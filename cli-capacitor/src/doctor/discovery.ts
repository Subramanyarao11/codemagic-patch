// Capacitor discovery for `doctor` (specs/doctor/Spec.md › Capacitor discovery): what the
// app's own project says about its OTA setup, read statically and within bounds. The
// counterpart of `discoverDoctorProject` in cli/src/doctor/discovery.ts
// (@codemagic/patch-cli 0.6.0), with the same result shape — findings per project and
// per platform, each platform's intent, effective settings and binding — so the command
// turns either into checks the same way.
//
// Per platform, a setting resolves as the SDK resolves it: the native override
// (androidProject.ts / iosProject.ts) wins; without one, the Capacitor config applies.
// The config value is taken from the source config (`capacitor.config.*`), which the next
// `npx cap sync` writes into the native project; only when the source computes it is the
// synced copy — the result of the last sync — used instead. A setting the build decides
// stays unresolved: no value is guessed for comparisons, binding or probes.

import { createRequire } from "node:module";
import { join, resolve } from "node:path";

import { isRecord } from "../output";
import { CLI_NAME } from "../branding";
import type { NativePlatform } from "../commands/doctor";
import { androidOverrides, detectAndroidVersionName } from "./androidProject";
import { isComputed, lookupJson, readCapacitorConfig, type CapacitorConfigSource, type ConfigLookup } from "./capacitorConfig";
import { detectIosMarketingVersion, iosOverrides, selectIosAppTarget } from "./iosProject";
import {
  judgeSetting,
  NATIVE_FIELDS,
  REQUIRED_SETTINGS,
  uniformOverrides,
  type DetectedVersion,
  type Evidence,
  type NativeOverrides,
  type SdkSettings,
  type SettingName,
} from "./settings";
import { parseSource, readDoctorSource, withoutComments, type ParsedDocument } from "./sources";
import { inspectUpdateFlow, SDK_PACKAGE } from "./webSources";

/**
 * Capacitor majors the SDK supports: "the two most recent" (client-capacitor/README.md ›
 * Support policy), which its CI tests. Older is below its `@capacitor/core` peer range
 * and fails; newer is untested, not known to be broken, and warns.
 */
export const SUPPORTED_CAPACITOR_MAJORS: readonly number[] = [7, 8];

export type DiscoveryFinding = {
  advice?: string[];
  detail: string;
  /** Extra evidence beyond the sources, merged into the check's `evidence`. */
  evidence?: Record<string, unknown>;
  id: string;
  platform?: NativePlatform;
  prerequisites?: string[];
  reason?: string;
  severity?: "info";
  sources: string[];
  status: "pass" | "fail" | "skip" | "warn";
};

export type PlatformDiscovery = {
  /** Only these selectors may be compared with this platform's SDK key. */
  binding: {
    app?: string;
    appId?: string;
    deployment?: string;
    deploymentId?: string;
    /** `key`: found by the app's deployment key (Spec.md › Key-based binding). */
    method?: "explicit" | "key";
    state: "resolved" | "unresolved";
  };
  findings: DiscoveryFinding[];
  intent: "configured" | "not_configured" | "unresolved";
  nativePresent: boolean;
  /** The native project directory, `ios.path` / `android.path` or the default. */
  nativeRoot: string;
  platform: NativePlatform;
  /** The effective settings; absent when the platform is not in scope. */
  settings?: SdkSettings;
  /** The native app version, for `target-binary-version` when no flag gives one. */
  version: DetectedVersion;
};

export type ProjectDiscovery = {
  /** `capacitor-config`, reported in the context group. */
  configCheck: DiscoveryFinding;
  /** The `sdk-project` group. */
  findings: DiscoveryFinding[];
  platforms: PlatformDiscovery[];
  /** The `web-assets` group. */
  webAssets: DiscoveryFinding[];
};

export type DiscoveryInput = {
  app?: string;
  appId?: string;
  deployment?: string;
  deploymentId?: string;
  deploymentKey?: string;
  platform?: NativePlatform;
  projectRoot: string;
};

const SYNCED_CONFIG: Record<NativePlatform, string[]> = {
  android: ["app", "src", "main", "assets", "capacitor.config.json"],
  ios: ["App", "App", "capacitor.config.json"],
};

export async function discoverCapacitorProject(input: DiscoveryInput): Promise<ProjectDiscovery> {
  const root = resolve(input.projectRoot);
  const pkg = await parseSource(join(root, "package.json"), "json");
  const config = await readCapacitorConfig(root);
  const dependencies = {
    ...(isRecord(pkg.data?.dependencies) ? pkg.data.dependencies : {}),
    ...(isRecord(pkg.data?.devDependencies) ? pkg.data.devDependencies : {}),
  };
  const capacitorProject = Object.hasOwn(dependencies, "@capacitor/core") || Object.hasOwn(dependencies, SDK_PACKAGE);
  const result: ProjectDiscovery = {
    configCheck: configFinding(config, capacitorProject),
    findings: [],
    platforms: [],
    webAssets: [],
  };

  result.findings.push(...(await dependencyFindings(root, pkg, dependencies, capacitorProject)));

  for (const platform of input.platform ? [input.platform] : (["ios", "android"] as const)) {
    result.platforms.push(await discoverPlatform(root, platform, config, input));
  }
  bindExplicitSelectors(result.platforms, input);

  const configured = result.platforms.filter((item) => item.intent === "configured");
  if (configured.length === 0)
    result.findings.push(
      finding("sdk-ota-intent", "skip", "No OTA platform could be selected with confidence.", [config.source], "unresolved", [
        "Configure plugins.CodemagicPatch.ios or .android in capacitor.config, or pass --platform ios or --platform android.",
      ]),
    );
  result.findings.push(sharedKeyFinding(result.platforms, config.source));
  result.findings.push(await updateFlowFinding(root, config, result.platforms));
  result.webAssets.push(await webDirFinding(root, config));
  return result;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

function configFinding(config: CapacitorConfigSource, capacitorProject: boolean): DiscoveryFinding {
  const ignored = config.ignored.length
    ? ` Capacitor ignores ${config.ignored.map((file) => file.split(/[\\/]/).pop()).join(" and ")} while this file exists.`
    : "";
  if (config.state === "missing")
    return finding(
      "capacitor-config",
      capacitorProject ? "fail" : "skip",
      "No capacitor.config.ts, capacitor.config.js or capacitor.config.json was found in the project root.",
      [config.source],
      capacitorProject ? "missing_config" : "unresolved",
      ["Pass `--project-root` with the app's root, or create the config with `npx cap init`."],
    );
  if (config.state === "invalid")
    return finding(
      "capacitor-config",
      "fail",
      `The Capacitor config could not be parsed.${ignored}`,
      [config.source],
      config.reason,
      ["Fix the syntax error; `npx cap sync` reports it as well."],
    );
  if (config.state !== "resolved")
    return finding(
      "capacitor-config",
      "skip",
      `The Capacitor config could not be read within the diagnostic limits.${ignored}`,
      [config.source],
      config.reason,
    );
  return {
    ...finding(
      "capacitor-config",
      "pass",
      config.computed
        ? `Read the Capacitor config statically; some of its values are computed and are reported where they matter. No project code was executed.${ignored}`
        : `Read the Capacitor config statically.${ignored}`,
      [config.source],
    ),
    evidence: { computed: config.computed, ...(config.ignored.length ? { ignored: config.ignored } : {}) },
  };
}

/** The version of a package as Node resolves it from the project; never executes it. */
async function installedVersion(root: string, name: string): Promise<string | undefined> {
  let manifest: string;
  try {
    manifest = createRequire(join(root, "package.json")).resolve(`${name}/package.json`);
  } catch {
    return undefined;
  }
  const doc = await parseSource(manifest, "json");
  return typeof doc.data?.version === "string" ? doc.data.version : undefined;
}

async function dependencyFindings(
  root: string,
  pkg: ParsedDocument,
  dependencies: Record<string, unknown>,
  capacitorProject: boolean,
): Promise<DiscoveryFinding[]> {
  const findings: DiscoveryFinding[] = [];
  const sdkVersion = await installedVersion(root, SDK_PACKAGE);
  findings.push(
    finding(
      "sdk-dependency",
      sdkVersion ? "pass" : capacitorProject ? "fail" : "skip",
      sdkVersion
        ? `${SDK_PACKAGE} ${sdkVersion} resolves from this project; native linking is checked per platform.`
        : `${SDK_PACKAGE} could not be resolved from this project.`,
      [pkg.source],
      sdkVersion ? undefined : capacitorProject ? "sdk_unavailable" : "unresolved",
      sdkVersion ? undefined : [`Install it with \`npm install ${SDK_PACKAGE}\`, then run \`npx cap sync\`.`],
    ),
  );
  if (sdkVersion && !Object.hasOwn(dependencies, SDK_PACKAGE))
    findings.push(
      finding(
        "sdk-declaration",
        "warn",
        "The SDK resolves but is not declared directly in this app's dependencies; check workspace ownership.",
        [pkg.source],
        "inherited_dependency",
      ),
    );
  if (pkg.state !== "resolved")
    findings.push(
      finding(
        "project-package",
        pkg.state === "invalid" ? "fail" : "skip",
        "Project package metadata could not be inspected.",
        [pkg.source],
        pkg.reason,
      ),
    );
  const coreVersion = await installedVersion(root, "@capacitor/core");
  const major = coreVersion === undefined ? undefined : Number.parseInt(coreVersion, 10);
  findings.push(
    coreVersion === undefined
      ? finding("sdk-capacitor-version", "skip", "@capacitor/core could not be resolved from this project.", [pkg.source], "unresolved", [
          "Install the project's dependencies, then run doctor again.",
        ])
      : major !== undefined && SUPPORTED_CAPACITOR_MAJORS.includes(major)
        ? finding("sdk-capacitor-version", "pass", `@capacitor/core ${coreVersion} is a supported Capacitor version.`, [pkg.source])
        : major !== undefined && major > Math.max(...SUPPORTED_CAPACITOR_MAJORS)
          ? finding(
              "sdk-capacitor-version",
              "warn",
              `@capacitor/core ${coreVersion} is newer than the Capacitor versions the SDK is tested with (${SUPPORTED_CAPACITOR_MAJORS.join(" and ")}).`,
              [pkg.source],
              "untested_version",
              [`Check the ${SDK_PACKAGE} release notes for Capacitor ${major} support.`],
            )
          : finding(
              "sdk-capacitor-version",
              "fail",
              `@capacitor/core ${coreVersion} is not supported; the SDK supports Capacitor ${SUPPORTED_CAPACITOR_MAJORS.join(" and ")}.`,
              [pkg.source],
              "unsupported_version",
              [`Upgrade to Capacitor ${SUPPORTED_CAPACITOR_MAJORS.at(-1)}.`],
            ),
  );
  return findings;
}

function sharedKeyFinding(platforms: PlatformDiscovery[], source: string): DiscoveryFinding {
  const keys = platforms
    .filter((item) => item.intent === "configured")
    .map((item) => item.settings?.deploymentKey)
    .filter((evidence): evidence is Evidence => evidence !== undefined);
  if (keys.length < 2)
    return finding(
      "sdk-shared-key",
      "skip",
      "Fewer than two platforms are in scope, so no deployment key can be shared.",
      [source],
      "not_applicable",
    );
  if (!keys.every((evidence) => evidence.state === "resolved"))
    return finding(
      "sdk-shared-key",
      "skip",
      "Both platforms' deployment keys must be resolved to compare them.",
      keys.map((evidence) => evidence.source),
      "blocked",
    );
  const shared = keys[0]!.value === keys[1]!.value;
  return finding(
    "sdk-shared-key",
    shared ? "fail" : "pass",
    shared
      ? "iOS and Android use the same deployment key. Release manifests carry no platform, so one platform's releases would overwrite what the other reads."
      : "iOS and Android use different deployment keys.",
    [...new Set(keys.map((evidence) => evidence.source))],
    shared ? "shared_deployment_key" : undefined,
    shared ? ["Give each platform its own deployment: one deployment key per platform."] : undefined,
  );
}

async function updateFlowFinding(
  root: string,
  config: CapacitorConfigSource,
  platforms: PlatformDiscovery[],
): Promise<DiscoveryFinding> {
  const webDir = config.read(["webDir"]);
  const excluded = [
    ...platforms.map((item) => item.nativeRoot),
    ...["android", "ios"].map((dir) => join(root, dir)),
    ...(webDir.state === "resolved" && typeof webDir.value === "string" ? [resolve(root, webDir.value)] : []),
  ];
  const flow = await inspectUpdateFlow(root, excluded);
  if (flow.calls.length)
    return finding(
      "sdk-update-flow",
      "pass",
      "SDK update/readiness source signals found; call reachability and runtime execution are not verified.",
      flow.calls.map((file) => join(root, file)),
    );
  return finding(
    "sdk-update-flow",
    "skip",
    flow.imports.length
      ? `The web sources import ${SDK_PACKAGE} but call none of start(), sync() or notifyAppReady() directly; wrappers and dynamic imports are not followed.`
      : `No call of start(), sync() or notifyAppReady() from ${SDK_PACKAGE} was found in the web sources. Only bounded local sources were inspected.`,
    flow.imports.map((file) => join(root, file)),
    flow.limited ? "discovery_limit" : "unresolved",
    [`Call \`start()\` from \`${SDK_PACKAGE}\` when the app starts: without it, or sync() and notifyAppReady(), the app never takes updates.`],
  );
}

async function webDirFinding(root: string, config: CapacitorConfigSource): Promise<DiscoveryFinding> {
  const configured = config.read(["webDir"]);
  if (configured.state === "unresolved" || configured.state === "invalid")
    return finding("web-dir", "skip", "webDir is computed in the Capacitor config; it was not resolved.", [config.source], "unresolved", [
      "Pass the built directory to `release create --bundle-path` explicitly.",
    ]);
  // Capacitor's own default (`loadConfig` in @capacitor/cli).
  const webDir = configured.state === "resolved" && typeof configured.value === "string" ? configured.value : "www";
  const directory = resolve(root, webDir);
  const index = await readDoctorSource(join(directory, "index.html"));
  return index.state === "resolved"
    ? {
        ...finding("web-dir", "pass", `${webDir}/ has an index.html at its root: it can be released.`, [directory]),
        evidence: { sources: [directory], webDir },
      }
    : {
        ...finding(
          "web-dir",
          "warn",
          `${webDir}/ has no index.html at its root yet; \`release create\` needs the built web assets.`,
          [directory],
          "not_built",
          [`Build the web app (for example \`npm run build\`) before \`${CLI_NAME} release create\`.`],
        ),
        evidence: { sources: [directory], webDir },
      };
}

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

async function discoverPlatform(
  root: string,
  platform: NativePlatform,
  config: CapacitorConfigSource,
  input: DiscoveryInput,
): Promise<PlatformDiscovery> {
  const configuredPath = config.read([platform, "path"]);
  const nativeRoot = resolve(
    root,
    configuredPath.state === "resolved" && typeof configuredPath.value === "string" ? configuredPath.value : platform,
  );
  const target = platform === "ios" ? await selectIosAppTarget(nativeRoot) : undefined;
  const overrides =
    configuredPath.state === "unresolved"
      ? uniformOverrides("unresolved", "computed_value", config.source)
      : platform === "ios"
        ? await iosOverrides(nativeRoot, target!)
        : await androidOverrides(nativeRoot);
  const synced = await parseSource(join(nativeRoot, ...SYNCED_CONFIG[platform]), "json");
  const sourceBlock = config.read(["plugins", "CodemagicPatch", platform]);
  const syncedBlock: ConfigLookup =
    synced.state === "resolved" ? lookupJson(synced.data, ["plugins", "CodemagicPatch", platform]) : { state: "missing" };
  const declared = isBlock(sourceBlock) || isBlock(syncedBlock);
  const nativePresent = overrides.present;
  const explicit = input.platform === platform;
  const intended = explicit || ((declared || overrides.intent) && nativePresent);
  const uncertain =
    overrides.uncertain ||
    sourceBlock.state === "unresolved" ||
    sourceBlock.state === "invalid" ||
    configuredPath.state === "unresolved";
  const version = configuredPath.state === "unresolved"
    ? { detail: "The native project path is computed in the Capacitor config.", state: "unresolved" as const }
    : platform === "ios"
      ? await detectIosMarketingVersion(target!)
      : await detectAndroidVersionName(nativeRoot);
  const item: PlatformDiscovery = {
    binding: { state: "unresolved" },
    findings: [],
    intent: intended ? "configured" : uncertain && nativePresent ? "unresolved" : "not_configured",
    nativePresent,
    nativeRoot,
    platform,
    version,
  };

  if (!intended) {
    const declaredWithoutProject = declared && !nativePresent;
    item.findings.push(
      finding(
        "sdk-platform",
        "skip",
        declaredWithoutProject
          ? `plugins.CodemagicPatch.${platform} is configured, but there is no ${platform} native project.`
          : item.intent === "unresolved"
            ? "OTA intent or native target could not be determined."
            : "This platform is not configured for OTA.",
        [declaredWithoutProject ? config.source : overrides.source],
        item.intent === "unresolved" ? "unresolved" : "not_configured",
        declaredWithoutProject
          ? [`Add the platform with \`npx cap add ${platform}\`, or pass --platform ${platform}.`]
          : item.intent === "unresolved"
            ? [`Select --platform ${platform} and inspect the app configuration.`]
            : undefined,
      ),
    );
    return item;
  }

  item.findings.push(syncedConfigFinding(platform, config, sourceBlock, syncedBlock, synced));
  item.settings = effectiveSettings(platform, overrides, config, sourceBlock, syncedBlock, synced);
  for (const [name, evidence] of Object.entries(item.settings) as Array<[SettingName, Evidence]>) {
    item.findings.push(settingFinding(platform, name, evidence));
  }
  if (overrides.uncertain)
    item.findings.push({
      ...finding(
        "sdk-build-selection",
        "skip",
        overrides.buildInfo
          ? "Patch resource settings were inspected. Final Gradle build values were not evaluated; this is a verification boundary, not a detected configuration problem."
          : "Effective target/build resource selection is not verified.",
        [overrides.source],
        overrides.buildInfo ? "build_not_evaluated" : "unresolved",
      ),
      ...(overrides.buildInfo ? { severity: "info" as const } : {}),
    });
  item.findings.push(await pluginRegistrationFinding(platform, nativeRoot, synced));
  return item;
}

function isBlock(lookup: ConfigLookup): boolean {
  return lookup.state === "resolved" && isRecord(lookup.value);
}

function syncedConfigFinding(
  platform: NativePlatform,
  config: CapacitorConfigSource,
  sourceBlock: ConfigLookup,
  syncedBlock: ConfigLookup,
  synced: ParsedDocument,
): DiscoveryFinding {
  if (synced.state === "missing")
    return finding(
      "sdk-synced-config",
      "skip",
      `The ${platform} project has no synced capacitor.config.json yet; Capacitor writes it on \`npx cap sync\`, and the app reads its settings from it.`,
      [synced.source],
      "deferred",
      [`Run \`npx cap sync ${platform}\`, then doctor again.`],
    );
  if (synced.state !== "resolved")
    return finding("sdk-synced-config", "skip", "The synced capacitor.config.json could not be read.", [synced.source], synced.reason ?? "unresolved", [
      `Run \`npx cap sync ${platform}\` to regenerate it.`,
    ]);
  if (sourceBlock.state === "unresolved" || config.state !== "resolved" || (sourceBlock.state === "resolved" && isComputed(sourceBlock.value)))
    return finding(
      "sdk-synced-config",
      "skip",
      "The source config's CodemagicPatch settings are computed, so the synced copy cannot be compared with them; doctor uses the synced values.",
      [synced.source, config.source],
      "unresolved",
    );
  const source = sourceBlock.state === "resolved" ? sourceBlock.value : undefined;
  const copy = syncedBlock.state === "resolved" ? syncedBlock.value : undefined;
  return JSON.stringify(sortKeys(source)) === JSON.stringify(sortKeys(copy))
    ? finding("sdk-synced-config", "pass", "The synced capacitor.config.json carries the same CodemagicPatch settings as the source config.", [
        synced.source,
      ])
    : finding(
        "sdk-synced-config",
        "warn",
        `The synced capacitor.config.json has different plugins.CodemagicPatch.${platform} settings than the source config: a build made now would use the old ones.`,
        [synced.source, config.source],
        "stale_sync",
        [`Run \`npx cap sync ${platform}\` before building.`],
      );
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function effectiveSettings(
  platform: NativePlatform,
  overrides: NativeOverrides,
  config: CapacitorConfigSource,
  sourceBlock: ConfigLookup,
  syncedBlock: ConfigLookup,
  synced: ParsedDocument,
): SdkSettings {
  const settings = {} as SdkSettings;
  for (const name of Object.keys(NATIVE_FIELDS) as SettingName[]) {
    const native = overrides.values[name];
    const configField = `plugins.CodemagicPatch.${platform}.${name}`;
    if (native.state === "resolved") {
      settings[name] = { ...judged(name, native.value), field: native.field, origin: "native-override", source: native.source };
      continue;
    }
    // An override the build decides, or a broken one, hides the config value: the SDK
    // does not fall back from a present override (and Android's resolution is unknown).
    if (native.state !== "missing") {
      settings[name] = { field: native.field, reason: native.reason, source: native.source, state: native.state };
      continue;
    }
    const fromSource = blockValue(sourceBlock, name);
    const useSynced = fromSource.state === "unresolved" && synced.state === "resolved";
    const value = useSynced ? blockValue(syncedBlock, name) : fromSource;
    const source = useSynced ? synced.source : config.source;
    const origin = useSynced ? "synced-config" : "source-config";
    settings[name] =
      value.state === "resolved"
        ? isBlank(value.value)
          ? { field: configField, reason: "missing_setting", source, state: "missing" }
          : { ...judged(name, value.value), field: configField, origin, source }
        : value.state === "missing"
          ? { field: configField, reason: "missing_setting", source, state: "missing" }
          : { field: configField, reason: value.reason, source, state: value.state };
  }
  return settings;
}

/** `null` and blank strings count as absent, as both native readers treat them. */
function isBlank(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.trim() === "");
}

function judged(name: SettingName, raw: unknown): Pick<Evidence, "reason" | "state" | "value"> {
  const result = judgeSetting(name, raw);
  return { state: result.state, ...(result.reason ? { reason: result.reason } : {}), ...(result.value !== undefined ? { value: result.value } : {}) };
}

function blockValue(block: ConfigLookup, name: SettingName): ConfigLookup {
  if (block.state !== "resolved") return block;
  if (!isRecord(block.value)) return { reason: "invalid_setting", state: "invalid" };
  return lookupJson(block.value, [name]);
}

/** What a native override is called on each platform. */
const OVERRIDE_KIND = { android: "string resource", ios: "Info.plist key" } as const;

function settingFinding(platform: NativePlatform, name: SettingName, evidence: Evidence): DiscoveryFinding {
  const required = REQUIRED_SETTINGS.includes(name);
  const status =
    evidence.state === "resolved"
      ? "pass"
      : evidence.state === "unresolved"
        ? "skip"
        : evidence.state === "missing" && !required
          ? "pass"
          : "fail";
  const from =
    evidence.origin === "native-override"
      ? `the ${evidence.field} ${OVERRIDE_KIND[platform]}`
      : evidence.origin === "synced-config"
        ? `${evidence.field} in the synced capacitor.config.json`
        : evidence.origin === "source-config"
          ? `${evidence.field} in the Capacitor config`
          : undefined;
  const nativeName = `${NATIVE_FIELDS[name]} ${OVERRIDE_KIND[platform]}`;
  const detail =
    evidence.state === "resolved"
      ? `${name}: resolved from ${from}.`
      : evidence.state === "missing"
        ? required
          ? `${name}: missing. The SDK will not check for updates without it.`
          : `${name}: not set; the SDK default applies.`
        : `${name}: ${evidence.state}${evidence.reason ? ` (${evidence.reason})` : ""}.`;
  return {
    ...finding(
      `sdk-native-${name}`,
      status,
      detail,
      [evidence.source],
      status === "pass" ? undefined : evidence.reason,
      status === "pass"
        ? undefined
        : evidence.state === "unresolved"
          ? [
              `The build decides ${name}; doctor does not guess it. Pass --platform ${platform} with --deployment-key, or with --app and --deployment, to check against what the app actually uses.`,
            ]
          : [`Set plugins.CodemagicPatch.${platform}.${name} in capacitor.config, or the ${nativeName} that overrides it.`],
    ),
    evidence: { field: evidence.field, ...(evidence.origin ? { origin: evidence.origin } : {}), sources: [evidence.source] },
  };
}

async function pluginRegistrationFinding(platform: NativePlatform, nativeRoot: string, synced: ParsedDocument): Promise<DiscoveryFinding> {
  if (platform === "android") {
    const file = join(nativeRoot, "app", "src", "main", "assets", "capacitor.plugins.json");
    const list = await readPluginList(file);
    if (list.state === "missing")
      return finding(
        "sdk-plugin-registration",
        "skip",
        "The Android project has no capacitor.plugins.json yet; Capacitor writes it on `npx cap sync`.",
        [file],
        "deferred",
        ["Run `npx cap sync android`, then doctor again."],
      );
    if (list.state !== "resolved")
      return finding("sdk-plugin-registration", "skip", "capacitor.plugins.json could not be read.", [file], list.reason ?? "unresolved");
    if (!list.packages.includes(SDK_PACKAGE))
      return finding(
        "sdk-plugin-registration",
        "fail",
        `capacitor.plugins.json does not list ${SDK_PACKAGE}: the app would run without the plugin.`,
        [file],
        "missing_plugin",
        [`Install ${SDK_PACKAGE} in this project, then run \`npx cap sync android\`.`],
      );
    // The app's settings.gradle applies this generated file to build the plugin's module:
    // listing the plugin is not enough, the module must be included, and only reading
    // the file shows that.
    const settingsFile = join(nativeRoot, "capacitor.settings.gradle");
    const settings = await readDoctorSource(settingsFile);
    if (settings.state === "missing")
      return finding(
        "sdk-plugin-registration",
        "skip",
        "The Android project has no capacitor.settings.gradle, which includes the plugin's Gradle module; Capacitor writes it on `npx cap sync`.",
        [settingsFile],
        "deferred",
        ["Run `npx cap sync android`, then doctor again."],
      );
    if (settings.state !== "resolved")
      return finding(
        "sdk-plugin-registration",
        "skip",
        "capacitor.settings.gradle could not be read within the diagnostic limits, so the plugin's Gradle module could not be checked.",
        [settingsFile],
        settings.reason ?? "unresolved",
      );
    return /['"]:codemagic-capacitor-patch['"]/.test(withoutComments(settings.text!))
      ? finding("sdk-plugin-registration", "pass", "The plugin is registered with the Android app; the built linkage is not verified.", [
          file,
          settingsFile,
        ])
      : finding(
          "sdk-plugin-registration",
          "fail",
          "capacitor.settings.gradle does not include the plugin's Gradle module, so it is not built into the app.",
          [settingsFile],
          "missing_plugin",
          ["Run `npx cap sync android`."],
        );
  }
  if (synced.state === "missing")
    return finding(
      "sdk-plugin-registration",
      "skip",
      "The iOS project has no synced capacitor.config.json yet; Capacitor lists the app's plugins in it on `npx cap sync`.",
      [synced.source],
      "deferred",
      ["Run `npx cap sync ios`, then doctor again."],
    );
  if (synced.state !== "resolved")
    return finding("sdk-plugin-registration", "skip", "The synced capacitor.config.json could not be read.", [synced.source], synced.reason ?? "unresolved");
  const classes = synced.data!.packageClassList;
  const listed = Array.isArray(classes) && classes.includes("CodemagicPatchPlugin");
  if (!listed)
    return finding(
      "sdk-plugin-registration",
      "fail",
      "The synced capacitor.config.json's packageClassList does not include CodemagicPatchPlugin: the app would run without the plugin.",
      [synced.source],
      "missing_plugin",
      [`Install ${SDK_PACKAGE} in this project, then run \`npx cap sync ios\`.`],
    );
  // Capacitor 7+ projects use Swift Package Manager or CocoaPods; either names the
  // plugin's package (`CodemagicCapacitorPatch`) once it has been synced.
  const manifests = [join(nativeRoot, "App", "CapApp-SPM", "Package.swift"), join(nativeRoot, "App", "Podfile")];
  for (const manifest of manifests) {
    const doc = await readDoctorSource(manifest);
    if (doc.state === "missing") continue;
    if (doc.state !== "resolved")
      return finding("sdk-plugin-registration", "skip", `${manifest} could not be read.`, [manifest], doc.reason ?? "unresolved");
    // A commented-out reference does not link anything: `#` in a Podfile, `//` in Swift.
    const code = manifest.endsWith("Podfile") ? doc.text!.replace(/#[^\n]*/g, "") : withoutComments(doc.text!);
    return /\bCodemagicCapacitorPatch\b/.test(code)
      ? finding("sdk-plugin-registration", "pass", "The plugin is registered with the iOS app; the built linkage is not verified.", [
          synced.source,
          manifest,
        ])
      : finding(
          "sdk-plugin-registration",
          "fail",
          `${manifest.endsWith("Podfile") ? "The Podfile" : "CapApp-SPM's Package.swift"} does not reference CodemagicCapacitorPatch, so the plugin is not built into the app.`,
          [manifest],
          "missing_plugin",
          ["Run `npx cap sync ios`."],
        );
  }
  return finding(
    "sdk-plugin-registration",
    "skip",
    "Neither CapApp-SPM's Package.swift nor a Podfile was found, so how the plugin is linked could not be checked.",
    [synced.source],
    "unresolved",
  );
}

async function readPluginList(file: string): Promise<{ packages: string[]; reason?: string; state: "missing" | "resolved" | "unresolved" }> {
  const doc = await readDoctorSource(file);
  if (doc.state === "missing") return { packages: [], state: "missing" };
  if (doc.state !== "resolved") return { packages: [], reason: doc.reason, state: "unresolved" };
  try {
    const data: unknown = JSON.parse(doc.text!);
    if (!Array.isArray(data)) throw new Error("not a list");
    return {
      packages: data.flatMap((entry) => (isRecord(entry) && typeof entry.pkg === "string" ? [entry.pkg] : [])),
      state: "resolved",
    };
  } catch {
    return { packages: [], reason: "malformed_document", state: "unresolved" };
  }
}

/**
 * Explicit app/deployment selectors bind as in `cmpatch`'s `bindPlatforms`: to the one
 * platform in scope (`--platform`, or the only configured platform), never to several.
 * With no selectors, the command binds by deployment key once the team is known.
 */
function bindExplicitSelectors(platforms: PlatformDiscovery[], input: DiscoveryInput): void {
  const intended = platforms.filter((item) => item.intent === "configured");
  const single =
    input.platform !== undefined || (intended.length === 1 && platforms.every((item) => item.intent !== "unresolved"));
  const hasApp = input.app !== undefined || input.appId !== undefined;
  const hasDeployment = input.deployment !== undefined || input.deploymentId !== undefined;
  // A --deployment-key alone, where it means one platform, binds by that key instead.
  if (!hasApp && !hasDeployment && (input.deploymentKey === undefined || single)) return;
  for (const item of intended) {
    if (!single) {
      item.binding = { state: "unresolved" };
    } else {
      const deploymentId = input.deploymentId;
      const deployment = deploymentId ? undefined : input.deployment;
      item.binding = {
        method: "explicit",
        state: hasApp && (deployment !== undefined || deploymentId !== undefined) ? "resolved" : "unresolved",
        ...(input.app ? { app: input.app } : {}),
        ...(input.appId ? { appId: input.appId } : {}),
        ...(deployment ? { deployment } : {}),
        ...(deploymentId ? { deploymentId } : {}),
      };
    }
    if (item.binding.state === "unresolved")
      item.findings.push(
        finding(
          "sdk-platform-binding",
          "skip",
          "App/deployment selectors are not bound to this platform; key comparison is not safe yet.",
          [],
          "unresolved",
          [`Select --platform ${item.platform} with its app (--app or --app-id) and deployment (--deployment or --deployment-id).`],
        ),
      );
  }
}

/** A platform still to bind by its deployment key: no explicit selectors were given. */
export function needsKeyBinding(item: PlatformDiscovery, input: DiscoveryInput): boolean {
  return (
    item.intent === "configured" &&
    item.binding.state === "unresolved" &&
    !item.findings.some((check) => check.id === "sdk-platform-binding") &&
    input.app === undefined &&
    input.appId === undefined &&
    input.deployment === undefined &&
    input.deploymentId === undefined
  );
}

export function finding(
  id: string,
  status: DiscoveryFinding["status"],
  detail: string,
  sources: string[],
  reason?: string,
  advice?: string[],
): DiscoveryFinding {
  return { detail, id, sources, status, ...(reason ? { reason } : {}), ...(advice ? { advice } : {}) };
}
