// `sdk-update-flow`: whether the app's web sources call the SDK's update flow —
// `start()`, `sync()` or `notifyAppReady()` from @codemagic/capacitor-patch. Source
// evidence only, never proof that a call is reached (specs/doctor/Spec.md › Checks).
//
// `cmpatch doctor` follows the React Native import graph from the package entry point
// (cli/src/doctor/jsDiscovery.ts). A Capacitor app has no such entry: its bundler —
// Vite, Angular, webpack — starts from its own config. So this walks the project's
// source files instead, within fixed budgets, skipping dependencies, native projects,
// build output and tests, and parses each with @babel/parser (never executing it).
// A call through a wrapper module or a dynamic import is not followed, so finding none
// leaves the check unresolved rather than failed.

import { lstat, opendir } from "node:fs/promises";
import { join, relative } from "node:path";

import { parse, type ParserPlugin } from "@babel/parser";

import { isRecord } from "../output";
import { errorCode, readDoctorSource } from "./sources";

export const SDK_PACKAGE = "@codemagic/capacitor-patch";
const METHODS = new Set(["start", "sync", "notifyAppReady"]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte)$/;
const SKIPPED_FILE = /\.d\.[cm]?ts$|\.(?:test|spec|stories)\.[^.]+$/;
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "bower_components",
  "build",
  "coverage",
  "dist",
  "e2e",
  "out",
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "www",
]);
const MAX_ENTRIES = 4000;
const MAX_FILES = 600;
const MAX_DEPTH = 10;

type Node = { [key: string]: unknown; type: string };

export type UpdateFlowEvidence = {
  /** Files that call a flow method, relative to the project root. */
  calls: string[];
  /** Files that import the SDK without a direct call: a wrapper, re-export or dynamic import. */
  imports: string[];
  /** A budget was hit or a file could not be read or parsed: absence proves nothing. */
  limited: boolean;
};

/** Walks `root` for SDK update-flow calls, skipping the `excluded` paths (native projects, `webDir`). */
export async function inspectUpdateFlow(root: string, excluded: readonly string[]): Promise<UpdateFlowEvidence> {
  const result: UpdateFlowEvidence = { calls: [], imports: [], limited: false };
  const skip = new Set(excluded);
  let entries = 0;
  let files = 0;
  async function walk(dir: string, depth: number): Promise<void> {
    let iterator;
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      iterator = await opendir(dir, { bufferSize: 32 });
    } catch (error) {
      if (errorCode(error) !== "ENOENT") result.limited = true;
      return;
    }
    for await (const entry of iterator) {
      if (++entries > MAX_ENTRIES) {
        result.limited = true;
        return;
      }
      const path = join(dir, entry.name);
      if (entry.name.startsWith(".") || skip.has(path)) continue;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
        if (depth >= MAX_DEPTH) result.limited = true;
        else await walk(path, depth + 1);
      } else if (entry.isFile() && SOURCE_FILE.test(entry.name) && !SKIPPED_FILE.test(entry.name)) {
        // Config files (vite.config.ts, capacitor.config.ts, ...) never call the SDK.
        if (depth === 0 && /\.config\.[^.]+$/.test(entry.name)) continue;
        if (++files > MAX_FILES) {
          result.limited = true;
          return;
        }
        const found = await inspectFile(path);
        if (found === "unreadable") result.limited = true;
        else if (found === "call") result.calls.push(relative(root, path));
        else if (found === "import") result.imports.push(relative(root, path));
      }
    }
  }
  await walk(root, 0);
  result.calls.sort();
  result.imports.sort();
  return result;
}

async function inspectFile(file: string): Promise<"call" | "import" | "none" | "unreadable"> {
  const doc = await readDoctorSource(file);
  if (doc.state !== "resolved") return "unreadable";
  // Cheap filter: a file that never names the package cannot import it.
  if (!doc.text!.includes(SDK_PACKAGE)) return "none";
  const scripts = /\.(?:vue|svelte)$/.test(file) ? componentScripts(doc.text!) : [{ code: doc.text!, typescript: /\.[cm]?tsx?$/.test(file) }];
  let imported = false;
  for (const script of scripts) {
    let ast;
    try {
      ast = parse(script.code, {
        errorRecovery: false,
        plugins: parserPlugins(file, script.typescript),
        sourceType: "unambiguous",
      });
    } catch {
      return "unreadable";
    }
    const found = findFlowCalls(ast.program as unknown as Node);
    if (found === "call") return "call";
    if (found === "import") imported = true;
  }
  return imported ? "import" : "none";
}

function parserPlugins(file: string, typescript: boolean): ParserPlugin[] {
  const plugins: ParserPlugin[] = ["decorators-legacy"];
  if (typescript) plugins.push("typescript");
  // `.ts` cannot take JSX: `<T>value` is a type assertion there.
  if (!/\.[cm]?ts$/.test(file) || !typescript) plugins.push("jsx");
  return plugins;
}

/** The `<script>` blocks of a Vue or Svelte component. */
function componentScripts(text: string): Array<{ code: string; typescript: boolean }> {
  return [...text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map((match) => ({
    code: match[2]!,
    typescript: /\blang\s*=\s*["']ts["']/.test(match[1]!),
  }));
}

/** Direct calls of a flow method through a named, namespace or `require` binding of the SDK. */
function findFlowCalls(program: Node): "call" | "import" | "none" {
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  let imported = false;
  visit(program, (node) => {
    if (node.type === "ImportDeclaration" && sdkSource(node.source)) {
      imported = true;
      for (const specifier of node.specifiers as Node[]) {
        const local = (specifier.local as Node).name as string;
        if (specifier.type === "ImportNamespaceSpecifier") namespaces.add(local);
        if (specifier.type === "ImportSpecifier" && METHODS.has(importedName(specifier.imported as Node))) functions.add(local);
      }
    }
    if ((node.type === "ExportNamedDeclaration" || node.type === "ExportAllDeclaration") && sdkSource(node.source))
      imported = true;
    if (node.type === "ImportExpression" && sdkSource(node.source)) imported = true;
    if (node.type === "CallExpression" && (node.callee as Node).type === "Import" && sdkSource((node.arguments as Node[])[0]))
      imported = true;
    if (node.type === "VariableDeclarator" && isRequireOfSdk(node.init as Node | null)) {
      imported = true;
      const id = node.id as Node;
      if (id.type === "Identifier") namespaces.add(id.name as string);
      if (id.type === "ObjectPattern") {
        for (const property of id.properties as Node[]) {
          if (property.type !== "ObjectProperty") continue;
          const key = property.key as Node;
          const value = property.value as Node;
          if (key.type === "Identifier" && METHODS.has(key.name as string) && value.type === "Identifier")
            functions.add(value.name as string);
        }
      }
    }
  });
  if (!imported) return "none";
  let called = false;
  visit(program, (node) => {
    if (called || (node.type !== "CallExpression" && node.type !== "OptionalCallExpression")) return;
    const callee = node.callee as Node;
    if (callee.type === "Identifier" && functions.has(callee.name as string)) called = true;
    if (
      (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression") &&
      (callee.object as Node).type === "Identifier" &&
      namespaces.has((callee.object as Node).name as string) &&
      !callee.computed &&
      METHODS.has((callee.property as Node).name as string)
    )
      called = true;
  });
  return called ? "call" : "import";
}

function sdkSource(node: unknown): boolean {
  return isRecord(node) && node.type === "StringLiteral" && node.value === SDK_PACKAGE;
}

function importedName(node: Node): string {
  return node.type === "Identifier" ? (node.name as string) : String(node.value);
}

function isRequireOfSdk(node: Node | null): boolean {
  return (
    node?.type === "CallExpression" &&
    (node.callee as Node).type === "Identifier" &&
    (node.callee as Node).name === "require" &&
    sdkSource((node.arguments as Node[])[0])
  );
}

function visit(node: unknown, callback: (node: Node) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) visit(item, callback);
    return;
  }
  if (!isRecord(node) || typeof node.type !== "string") return;
  callback(node as Node);
  for (const [key, value] of Object.entries(node)) {
    if (key !== "loc" && value !== null && typeof value === "object") visit(value, callback);
  }
}
