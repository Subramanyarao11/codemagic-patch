// The Android native project as doctor reads it: the `CodemagicPatch*` string-resource
// overrides the SDK prefers over capacitor.config (client-capacitor ADR-0003), and the
// app's `versionName`. Static and bounded: Gradle never runs, so whatever the build may
// change is reported as unresolved, never guessed (specs/doctor/Spec.md › Capacitor
// discovery, 3).
//
// Copied from @codemagic/patch-cli 0.6.0, adapted only to this SDK's settings and to
// Capacitor's fixed module layout (`<android>/app`):
//   - scanAndroidResources: the resource half of cli/src/doctor/androidScan.ts
//     (`scanAndroid`), with the same budgets; there is no host source to find.
//   - androidOverrides: `androidResources` and the Android branch of `nativeSettings` in
//     cli/src/doctor/discovery.ts — per-setting merge of `main` resources, overrides in
//     other source sets and qualifiers, Gradle `resValue`, and the module build file's
//     `productFlavors` / `sourceSets` / `apply from`.
//   - detectAndroidVersionName: `parseGradleVersionName` and its helpers in
//     cli/src/targetBinaryVersion.ts, unchanged.

import { lstat, opendir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { errorCode, parseSource, readDoctorSource, withoutComments, type ParsedDocument } from "./sources";
import {
  NATIVE_FIELDS,
  overrideValue,
  uniformOverrides,
  type DetectedVersion,
  type NativeOverrides,
  type OverrideEvidence,
  type SettingName,
} from "./settings";

type Dirent = { isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean; name: string };

/** The `values*` XML files of every source set under `<android>/app/src`, within cmpatch's budgets. */
export async function scanAndroidResources(
  sourceRoot: string,
): Promise<{ files: string[]; limited: boolean; present: boolean }> {
  const result = { files: [] as string[], limited: false, present: false };
  const counts = { layout: 0, resources: 0 };
  async function entries(dir: string, scope: keyof typeof counts, each: (entry: Dirent) => Promise<void>) {
    try {
      const stat = await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        result.limited = true;
        return;
      }
      if (scope === "layout") result.present = true;
      for await (const entry of await opendir(dir, { bufferSize: 32 })) {
        if (++counts[scope] > (scope === "resources" ? 1000 : 200)) {
          result.limited = true;
          break;
        }
        await each(entry);
      }
    } catch (error) {
      if (errorCode(error) !== "ENOENT") result.limited = true;
    }
  }
  let xmlFiles = 0;
  await entries(sourceRoot, "layout", async (sourceSet) => {
    if ([".git", "build", "node_modules"].includes(sourceSet.name)) return;
    if (sourceSet.isSymbolicLink()) {
      result.limited = true;
      return;
    }
    if (!sourceSet.isDirectory()) return;
    const res = join(sourceRoot, sourceSet.name, "res");
    await entries(res, "resources", async (values) => {
      if (!/^values(?:-|$)/.test(values.name)) return;
      if (values.isSymbolicLink()) {
        result.limited = true;
        return;
      }
      if (!values.isDirectory()) return;
      await entries(join(res, values.name), "resources", async (entry) => {
        if (entry.isSymbolicLink()) {
          result.limited = true;
          return;
        }
        if (!entry.isFile() || !entry.name.endsWith(".xml")) return;
        if (++xmlFiles > 128) {
          result.limited = true;
          return;
        }
        result.files.push(join(res, values.name, entry.name));
      });
    });
  });
  result.files.sort();
  return result;
}

/**
 * The resource overrides the built app may carry, per setting. `missing` means no
 * override (the config value applies); `unresolved` means the build decides, and the
 * config value is then not used either.
 */
export async function androidOverrides(androidRoot: string): Promise<NativeOverrides> {
  const sourceRoot = join(androidRoot, "app", "src");
  const scan = await scanAndroidResources(sourceRoot);
  if (!scan.present) {
    let present = false;
    try {
      present = (await lstat(androidRoot)).isDirectory();
    } catch {
      /* an absent native project is reported by native-directory */
    }
    // An android/ directory without app/src is not the layout Capacitor generates.
    return present
      ? uniformOverrides("unresolved", "custom_android_layout", androidRoot)
      : uniformOverrides("missing", "not_found", androidRoot);
  }
  if (scan.limited) return uniformOverrides("unresolved", "discovery_limit", sourceRoot);

  const documents = await Promise.all(scan.files.map((file) => parseSource(file, "xml")));
  const merged = mergeResources(documents, sourceRoot);

  // The module build file, and the scripts it applies, can add, select or replace
  // resources at build time.
  const gradle = await inspectGradleScripts(androidRoot);
  const gradleUnresolved = gradle.unresolved;
  const selectionUnresolved = gradle.selectionUnresolved;
  for (const [setting, file] of gradle.resValues) {
    merged.values[setting] = { field: NATIVE_FIELDS[setting], reason: "build_configuration", source: file, state: "unresolved" };
  }
  if (gradleUnresolved) {
    for (const evidence of Object.values(merged.values)) {
      if (evidence.state === "missing") {
        evidence.state = "unresolved";
        evidence.reason = "build_configuration";
      }
    }
  }
  const uncertain = gradleUnresolved || merged.uncertain;
  return {
    buildInfo:
      gradleUnresolved &&
      !selectionUnresolved &&
      !merged.uncertain &&
      Object.values(merged.values).every((evidence) => evidence.state === "resolved"),
    intent: merged.intent,
    present: true,
    source: merged.source,
    uncertain,
    values: merged.values,
  };
}

/** Applied scripts are followed this far, then the build counts as unresolved. */
const MAX_GRADLE_SCRIPTS = 8;

/**
 * cmpatch's Gradle rules over `<android>/app/build.gradle(.kts)`: a `resValue` for a
 * setting makes that setting unresolved; `productFlavors`, `sourceSets` or an unreadable
 * build file make the resource selection unresolved. One difference: cmpatch treats any
 * `apply from` as unresolved, but every Capacitor app's build file applies Capacitor's
 * generated `capacitor.build.gradle` (which applies `cordova.variables.gradle`), and
 * that rule would leave every Capacitor setting unresolved. So a literal `apply from`
 * of a script inside the native project is read and held to the same rules; one doctor
 * cannot read — a URL, a computed path, a file outside the project, a missing file, or
 * past the script budget — still makes the build unresolved.
 */
async function inspectGradleScripts(
  androidRoot: string,
): Promise<{ resValues: Map<SettingName, string>; selectionUnresolved: boolean; unresolved: boolean }> {
  const result = { resValues: new Map<SettingName, string>(), selectionUnresolved: false, unresolved: false };
  const queue = ["build.gradle", "build.gradle.kts"].map((name) => ({ file: join(androidRoot, "app", name), root: true }));
  const seen = new Set<string>();
  while (queue.length) {
    const { file, root } = queue.shift()!;
    if (seen.has(file)) continue;
    if (seen.size >= MAX_GRADLE_SCRIPTS) {
      result.unresolved = true;
      break;
    }
    seen.add(file);
    const build = await readDoctorSource(file);
    // A module without build.gradle or without build.gradle.kts is normal; a missing
    // applied script is not something doctor can evaluate.
    if (build.state === "missing" && root) continue;
    if (build.state !== "resolved") {
      result.unresolved = true;
      result.selectionUnresolved = true;
      continue;
    }
    const code = withoutComments(build.text!);
    if (/\b(productFlavors|sourceSets)\b/.test(code)) {
      result.selectionUnresolved = true;
      result.unresolved = true;
    }
    if (/\bresValue\b/.test(code)) result.unresolved = true;
    for (const [setting, field] of Object.entries(NATIVE_FIELDS)) {
      if (new RegExp(`\\bresValue\\s*\\(?[^\\n;{}]*["']${field}["']`).test(code))
        result.resValues.set(setting as SettingName, file);
    }
    const applies = [...code.matchAll(/\bapply\s*\(?\s*from\s*[:=]?/g)];
    const literal = /\bapply\s*\(?\s*from\s*[:=]\s*(["'])([^"'$]+)\1/g;
    const targets = [...code.matchAll(literal)].map((match) => match[2]!);
    if (targets.length !== applies.length) result.unresolved = true;
    for (const target of targets) {
      const path = resolve(dirname(file), target);
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || relative(androidRoot, path).startsWith("..")) result.unresolved = true;
      else queue.push({ file: path, root: false });
    }
  }
  return result;
}

/** Merge only the SDK keys, preserving per-setting uncertainty. */
function mergeResources(
  documents: ParsedDocument[],
  sourceRoot: string,
): { intent: boolean; source: string; uncertain: boolean; values: NativeOverrides["values"] } {
  const base = documents.filter((doc) => dirname(doc.source) === join(sourceRoot, "main", "res", "values"));
  let uncertain = documents.some((doc) => doc.state !== "resolved");
  const values = {} as NativeOverrides["values"];
  for (const [name, field] of Object.entries(NATIVE_FIELDS)) {
    const primary = base.filter((doc) => Object.hasOwn(doc.data ?? {}, field));
    const overrides = documents.filter((doc) => !base.includes(doc) && Object.hasOwn(doc.data ?? {}, field));
    let evidence: OverrideEvidence;
    if (documents.some((doc) => doc.state !== "resolved")) {
      evidence = { field, reason: "unreadable_resources", source: sourceRoot, state: "unresolved" };
    } else if (primary.length > 1) {
      evidence = { field, reason: "duplicate_resource", source: primary[0]!.source, state: "invalid" };
    } else if (overrides.some((doc) => doc.data?.[field] !== primary[0]?.data?.[field])) {
      evidence = { field, reason: "resource_override", source: overrides[0]!.source, state: "unresolved" };
      uncertain = true;
    } else if (primary.length === 1) {
      evidence = overrideValue(primary[0]!.data![field], field, primary[0]!.source);
    } else {
      evidence = { field, reason: "missing_setting", source: join(sourceRoot, "main", "res", "values"), state: "missing" };
    }
    values[name as SettingName] = evidence;
  }
  return {
    intent: documents.some((doc) => Object.keys(doc.data ?? {}).some((key) => key.startsWith("CodemagicPatch"))),
    source: base[0]?.source ?? join(sourceRoot, "main", "res", "values", "strings.xml"),
    uncertain,
    values,
  };
}

// ---------------------------------------------------------------------------
// versionName — cli/src/targetBinaryVersion.ts, unchanged in substance
// ---------------------------------------------------------------------------

class AndroidVersionError extends Error {}

function androidVersionError(reason: string): AndroidVersionError {
  return new AndroidVersionError(reason);
}

/** The literal `versionName` (plus `versionNameSuffix`) of `<android>/app`'s `defaultConfig`. */
export async function detectAndroidVersionName(androidRoot: string): Promise<DetectedVersion> {
  for (const name of ["build.gradle", "build.gradle.kts"]) {
    const file = join(androidRoot, "app", name);
    const doc = await readDoctorSource(file);
    if (doc.state === "missing") continue;
    if (doc.state !== "resolved") return { detail: `${file} could not be read within the diagnostic limits.`, state: "unresolved" };
    try {
      const version = await parseGradleVersionName(file, doc.text!);
      if (version !== null) return { source: file, state: "resolved", version };
    } catch (error) {
      if (error instanceof AndroidVersionError) return { detail: error.message, state: "unresolved" };
      throw error;
    }
  }
  return { detail: `No literal versionName was found in ${join(androidRoot, "app")}.`, state: "unresolved" };
}

async function parseGradleVersionName(gradleFile: string, content: string): Promise<string | null> {
  // Only interpret direct static declarations. Keep strings intact and check every
  // scope, including conditional blocks that could override the version.
  const tokens = (
    content.match(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:[\w$]+|`[^`\r\n]+`)(?:\.(?:[\w$]+|`[^`\r\n]+`))*|\n|[^\s]/gu,
    ) ?? []
  ).filter((token) => !token.startsWith("//") && !token.startsWith("/*"));
  const scopes: string[] = [];
  let statement: string[] = [];
  const values = new Map<string, string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "{") {
      scopes.push(statement.join(""));
      statement = [];
    } else if (token === "}") {
      scopes.pop();
      statement = [];
    } else if (token === "\n" || token === ";") {
      statement = [];
    } else if (isGradleVersionWrite(tokens, index)) {
      if (
        scopes.join("/") !== "android/defaultConfig" ||
        statement.length > 0 ||
        (token !== "versionName" && token !== "versionNameSuffix") ||
        values.has(token)
      ) {
        const scope = scopes.length ? `the ${scopes.join(".")} block` : "the top-level script";
        throw androidVersionError(
          `Android ${token} is written in ${scope}; only one direct versionName/versionNameSuffix declaration in android.defaultConfig is supported.`,
        );
      }
      const expression: string[] = [];
      while (index + 1 < tokens.length && !["\n", ";", "}"].includes(tokens[index + 1]!)) {
        expression.push(tokens[++index]!);
      }
      if (expression[0] === "=") expression.shift();
      if (expression.length !== 1) throw androidVersionError(`Android ${token} is not a static value.`);
      const raw = expression[0]!;
      const literal = /^(?:"[^"\\$]*"|'[^'\\]*')$/u.test(raw);
      let value: string | null;
      if (literal) {
        value = raw.slice(1, -1);
      } else if (token === "versionName" && /^(?:project\.)?[A-Za-z_][A-Za-z0-9_]*$/u.test(raw)) {
        value = await readGradleProperty(gradleFile, raw.replace(/^project\./u, ""));
      } else {
        throw androidVersionError(`Android ${token} is not a supported static value.`);
      }
      if (value === null) throw androidVersionError(`Android ${token} "${raw}" is an unresolved Gradle variable.`);
      values.set(token, value);
    } else {
      statement.push(token);
    }
  }
  const version = values.get("versionName");
  return version?.trim() ? version + (values.get("versionNameSuffix") ?? "") : null;
}

// Gradle properties whose writes change the versionName devices report, including
// AGP's per-output override. Only the first two are supported as direct
// android.defaultConfig declarations; every other write is rejected.
const GRADLE_VERSION_PROPERTY_PATTERN =
  /(?:^|\.)(versionName(?:Suffix|Override)?|setVersionName(?:Suffix|Override)?)(?:\.(.*))?$/u;

function isGradleVersionWrite(tokens: string[], index: number): boolean {
  // Escaped Kotlin identifiers name the same properties; detect their writes even
  // though only ordinary direct declarations are supported above.
  const member = GRADLE_VERSION_PROPERTY_PATTERN.exec(tokens[index]!.replace(/`/gu, ""));
  if (member === null) return false;

  const next = tokens[index + 1];
  const following = tokens[index + 2];
  if (next === "as" || next === "is") return false;
  // Calls on the value (e.g. versionName.toString()) only read it; a Property.set(...)
  // call changes it and must still be rejected.
  if (member[2] !== undefined) return member[2] === "set" && next === "(";
  if (next === "=" && following !== "=") return true;
  if (["+", "-", "*", "/", "%"].includes(next ?? "") && following === "=") return true;
  if (
    (["+", "-"].includes(next ?? "") && following === next) ||
    (["+", "-"].includes(tokens[index - 1] ?? "") && tokens[index - 2] === tokens[index - 1])
  )
    return true;

  // Both Groovy command syntax and parenthesized setter calls are writes. Delimiters
  // and operators following a property reference are reads instead.
  return next === "(" || /^(?:["']|[A-Za-z_$0-9])/u.test(next ?? "");
}

async function readGradleProperty(gradleFile: string, propertyName: string): Promise<string | null> {
  const moduleDirectory = dirname(gradleFile);
  let root = moduleDirectory;
  while (
    (await readDoctorSource(join(root, "settings.gradle"))).state !== "resolved" &&
    (await readDoctorSource(join(root, "settings.gradle.kts"))).state !== "resolved"
  ) {
    const parent = dirname(root);
    if (parent === root) throw androidVersionError("Could not locate the Gradle settings file for Android version properties.");
    root = parent;
  }
  for (const directory of new Set([moduleDirectory, root])) {
    const doc = await readDoctorSource(join(directory, "gradle.properties"));
    if (doc.state !== "resolved") continue;
    const value = parseGradlePropertiesValue(doc.text!, propertyName);
    if (value !== null) return value;
  }
  return null;
}

function parseGradlePropertiesValue(content: string, propertyName: string): string | null {
  for (const line of content.split(/\r?\n/u)) {
    const trimmedLine = line.trim();
    if (trimmedLine.length === 0 || trimmedLine.startsWith("#")) continue;
    const equalsIndex = trimmedLine.indexOf("=");
    if (equalsIndex === -1) continue;
    if (trimmedLine.slice(0, equalsIndex).trim() === propertyName) return trimmedLine.slice(equalsIndex + 1).trim();
  }
  return null;
}
