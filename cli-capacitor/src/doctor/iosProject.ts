// The iOS native project as doctor reads it: the `App` target of
// `<ios>/App/App.xcodeproj` (the layout Capacitor generates, `loadIOSConfig` in
// @capacitor/cli), the `CodemagicPatch*` Info.plist keys the SDK prefers over
// capacitor.config, and the app's marketing version. Static: Xcode never runs and an
// xcconfig is never evaluated, so a value only the build knows is unresolved.
//
// Target and version resolution follow `discoverIosTargets` (cli/src/doctor/iosTargets.ts)
// and `detectIosTargetBinaryVersion` (cli/src/targetBinaryVersion.ts) of
// @codemagic/patch-cli 0.6.0, narrowed to Capacitor's fixed project: there is no target
// selector, so the application target named `App` (or the only one) is used, and
// several Info.plist files across its build configurations leave it unresolved.

import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { parse as parsePlist } from "plist";

import { isRecord } from "../output";
import {
  NATIVE_FIELDS,
  overrideValue,
  uniformOverrides,
  type DetectedVersion,
  type NativeOverrides,
  type SettingName,
} from "./settings";
import { parseSource, readDoctorSource } from "./sources";
import { parseXcodeProject, resolveXcodeSetting, unquoteXcode } from "./xcodeProject";

type Configuration = { name: string; settings: Record<string, unknown> };

export type IosAppTarget =
  | { configurations: Configuration[]; name: string; plist?: string; project: string; root: string; state: "resolved" }
  | { reason: string; source: string; state: "missing" | "unresolved" };

/** `<ios>/App/App.xcodeproj`'s application target: `App`, or the only one there is. */
export async function selectIosAppTarget(iosRoot: string): Promise<IosAppTarget> {
  const root = join(iosRoot, "App");
  const project = join(root, "App.xcodeproj", "project.pbxproj");
  const doc = await readDoctorSource(project);
  if (doc.state !== "resolved") return { reason: doc.reason ?? "unreadable", source: project, state: doc.state === "missing" ? "missing" : "unresolved" };
  let parsed: ReturnType<typeof parseXcodeProject>;
  try {
    parsed = parseXcodeProject(doc.text!);
  } catch {
    return { reason: "malformed_document", source: project, state: "unresolved" };
  }
  const targets = parsed.targets;
  const target = targets.length === 1 ? targets[0] : targets.find((candidate) => unquoteXcode(candidate.name) === "App");
  if (target === undefined) return { reason: "ambiguous_target", source: project, state: "unresolved" };
  const configurations = parsed.configurations(target);
  const plists = new Set<string>();
  let unresolvedPlist = configurations.length === 0;
  for (const configuration of configurations) {
    const plist = resolveXcodeSetting("INFOPLIST_FILE", configuration.settings, root);
    if (plist === undefined) unresolvedPlist = true;
    else plists.add(resolve(root, plist));
  }
  return {
    configurations,
    name: unquoteXcode(target.name),
    ...(plists.size === 1 && !unresolvedPlist ? { plist: [...plists][0]! } : {}),
    project,
    root,
    state: "resolved",
  };
}

/** The Info.plist overrides of the selected target, per setting. */
export async function iosOverrides(iosRoot: string, target: IosAppTarget): Promise<NativeOverrides> {
  if (target.state === "missing") {
    const present = await lstat(iosRoot).then((stats) => stats.isDirectory(), () => false);
    return present
      ? uniformOverrides("unresolved", "custom_ios_layout", target.source)
      : uniformOverrides("missing", "not_found", iosRoot);
  }
  const plistFile = target.state === "resolved" ? target.plist : undefined;
  if (plistFile === undefined) {
    return target.state === "resolved"
      ? uniformOverrides("unresolved", "build_configuration", target.project)
      : uniformOverrides("unresolved", target.reason, target.source);
  }
  const plist = await parseSource(plistFile, "plist");
  if (plist.state !== "resolved") return uniformOverrides("unresolved", plist.reason ?? "unreadable", plistFile);
  const values = {} as NativeOverrides["values"];
  for (const [name, field] of Object.entries(NATIVE_FIELDS)) {
    values[name as SettingName] = Object.hasOwn(plist.data!, field)
      ? overrideValue(plist.data![field], field, plistFile)
      : { field, reason: "missing_setting", source: plistFile, state: "missing" };
  }
  return {
    buildInfo: false,
    intent: Object.keys(plist.data!).some((key) => key.startsWith("CodemagicPatch")),
    present: true,
    source: plistFile,
    uncertain: false,
    values,
  };
}

/** CFBundleShortVersionString of the target, `$(MARKETING_VERSION)` resolved per configuration. */
export async function detectIosMarketingVersion(target: IosAppTarget): Promise<DetectedVersion> {
  if (target.state !== "resolved") return { detail: `The iOS App target could not be selected (${target.reason}).`, state: "unresolved" };
  if (target.plist === undefined)
    return { detail: `The ${target.name} target's build configurations do not name one Info.plist.`, state: "unresolved" };
  const doc = await readDoctorSource(target.plist);
  let declared: unknown;
  try {
    if (doc.state !== "resolved") throw new Error("unreadable");
    const parsed = parsePlist(doc.text!);
    declared = isRecord(parsed) ? parsed.CFBundleShortVersionString : undefined;
  } catch {
    return { detail: `${target.plist} could not be read.`, state: "unresolved" };
  }
  if (typeof declared !== "string" || !declared.trim())
    return { detail: `${target.plist} has no CFBundleShortVersionString.`, state: "unresolved" };
  const versions = new Set<string>();
  for (const configuration of target.configurations) {
    let version = declared.trim();
    if (/^\$\(MARKETING_VERSION\)$|^\$\{MARKETING_VERSION\}$/.test(version))
      version = resolveXcodeSetting("MARKETING_VERSION", configuration.settings, target.root) ?? "";
    if (!version || version.includes("$(") || version.includes("${"))
      return {
        detail: `CFBundleShortVersionString of ${target.name} (${configuration.name}) is set at build time; conditional or xcconfig values are not evaluated.`,
        state: "unresolved",
      };
    versions.add(version);
  }
  if (versions.size !== 1)
    return { detail: `Binary versions differ across the build configurations of ${target.name}.`, state: "unresolved" };
  return { source: target.project, state: "resolved", version: [...versions][0]! };
}
