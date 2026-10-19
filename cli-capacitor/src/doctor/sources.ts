// Bounded, read-only access to project files for doctor's discovery. Copied from
// cli/src/doctor/discovery.ts (@codemagic/patch-cli 0.6.0): `readDoctorSource`,
// `parseSource` and `withoutComments`. One difference: a path below a file (ENOTDIR)
// reads as missing, like a path that does not exist. Nothing here executes project code;
// a file that is too large, a symlink, or anything that is not a regular file is
// reported, never followed.

import { lstat, open } from "node:fs/promises";

import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parsePlist } from "plist";

import { isRecord } from "../output";

/** How far a piece of evidence got: the same four states as `cmpatch doctor`. */
export type Resolution = "resolved" | "missing" | "invalid" | "unresolved";

export type SourceDocument = {
  reason?: string;
  source: string;
  state: Resolution;
  text?: string;
};

export type ParsedDocument = {
  data?: Record<string, unknown>;
  reason?: string;
  source: string;
  state: Resolution;
};

/** Files over 1 MiB are not read: a project config or resource never needs more. */
export const MAX_SOURCE_BYTES = 1024 * 1024;

export function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

/** Bounded reads. No parsing exception or file content leaks into a result. */
export async function readDoctorSource(source: string): Promise<SourceDocument> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stats = await lstat(source);
    if (stats.isSymbolicLink() || !stats.isFile()) return { reason: "not_regular_file", source, state: "unresolved" };
    if (stats.size > MAX_SOURCE_BYTES) return { reason: "size_limit", source, state: "unresolved" };
    handle = await open(source, "r");
    const buffer = Buffer.alloc(MAX_SOURCE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_SOURCE_BYTES) return { reason: "size_limit", source, state: "unresolved" };
    return { source, state: "resolved", text: buffer.subarray(0, length).toString("utf8") };
  } catch (error) {
    const missing = errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";
    return { reason: missing ? "not_found" : "unreadable", source, state: missing ? "missing" : "unresolved" };
  } finally {
    await handle?.close();
  }
}

/**
 * A JSON object, an Info.plist dictionary, or the string resources of an Android
 * `values*` file (`<string name>` and `<item type="string">`, a duplicate name being
 * malformed, as aapt treats it).
 */
export async function parseSource(source: string, kind: "json" | "plist" | "xml"): Promise<ParsedDocument> {
  const doc = await readDoctorSource(source);
  if (doc.state !== "resolved") return doc;
  try {
    let data: unknown;
    if (kind === "json") data = JSON.parse(doc.text!);
    else if (kind === "plist") {
      // plist's XML parser can write malformed-input diagnostics to stderr.
      // Reject malformed XML before calling it; report only our sanitized reason.
      if (XMLValidator.validate(doc.text!) !== true || !/<plist[\s>]/.test(doc.text!)) throw new Error("invalid plist");
      data = parsePlist(doc.text!);
    } else {
      if (XMLValidator.validate(doc.text!) !== true) throw new Error("invalid XML");
      const parsed: unknown = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(
        doc.text!,
      );
      if (!isRecord(parsed) || (!isRecord(parsed.resources) && parsed.resources !== ""))
        throw new Error("missing resources");
      const resources = isRecord(parsed.resources) ? parsed.resources : {};
      const list = (value: unknown): unknown[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
      const nodes = [
        ...list(resources.string),
        ...list(resources.item).filter((node) => isRecord(node) && node["@_type"] === "string"),
      ];
      const strings: Record<string, unknown> = {};
      for (const node of nodes) {
        // `<string name="X"></string>` parses as "", `<string name="X">v</string>` as "v".
        const name = isRecord(node) ? node["@_name"] : undefined;
        if (typeof name !== "string") continue;
        if (Object.hasOwn(strings, name)) throw new Error("duplicate resource");
        strings[name] = isRecord(node) ? (node["#text"] ?? "") : node;
      }
      data = strings;
    }
    if (!isRecord(data)) throw new Error("expected object");
    return { data, source, state: "resolved" };
  } catch {
    return { reason: "malformed_document", source, state: "invalid" };
  }
}

/**
 * Comments blanked to spaces, newlines kept, so an index into the result addresses the
 * same character in the original. String literals are preserved so comment markers in
 * URLs cannot erase source.
 */
export function withoutComments(text: string): string {
  return text.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    (match, literal: string | undefined) => literal ?? match.replace(/[^\n]/g, " "),
  );
}
