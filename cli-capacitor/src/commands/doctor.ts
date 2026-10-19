// `doctor`: why an app may not receive OTA updates. Adapted from
// cli/src/commands/doctor.ts (@codemagic/patch-cli 0.6.0) — the same check ids, wording,
// prerequisites, result model, coverage, verdict and report, so a script or an agent
// reads either doctor's JSON the same way. What differs, and why, is
// ../../specs/doctor/Spec.md › Deliberate differences: this CLI's command names and
// selectors, `text|json`, plain progress lines, no `--fix`, no project config file or
// team defaults, no bundler or fingerprint, and device handoff by log command.
//
// The Capacitor half (Spec.md › Capacitor discovery) lives in ../doctor/discovery.ts and
// its readers: the app's Capacitor config, the synced copies `npx cap sync` writes, the
// native overrides, plugin registration and the web sources. Here those findings become
// checks, platforms in scope become per-platform plans, as in cmpatch, and a platform
// with no explicit selectors is bound by its deployment key (Spec.md › Key-based binding).

import { readFile, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import {
  buildApiUrl,
  isServerCredential,
  normalizeBearerToken,
  SERVER_CREDENTIAL_PATTERN,
  SERVER_URL_ENV,
  TOKEN_ENV,
} from "../api";
import { teamAppsPath } from "../appFramework";
import { isPathSafeBinaryVersion } from "../binaryVersion";
import { CLI_NAME, PRODUCT_NAME } from "../branding";
import {
  APP_SELECTOR_FLAGS,
  CONNECTION_FLAGS,
  FORMAT_FLAG,
  readBoolean,
  readRequestedFormat,
  readString,
  type CommandDefinition,
  type FlagValues,
} from "../command";
import { loadStoredCredential } from "../credentials";
import { resolveCredentialStorePath } from "../credentialStore";
import type { CliDeps } from "../deps";
import { compareUrl, httpUrl, probeDownloadOrigin, redactUrlText, safeUrl } from "../doctor/connectivity";
import { verifyDoctorDelivery, type PublicationCache } from "../doctor/deliveryVerification";
import {
  discoverCapacitorProject,
  needsKeyBinding,
  type DiscoveryFinding,
  type PlatformDiscovery,
} from "../doctor/discovery";
import { doctorBlockers } from "../doctor/report";
import { UsageError, ValidationError } from "../errors";
import { request } from "../http";
import { isRecord, selectOutputFormat, writeLine, type WritableStream } from "../output";
import { HttpProblemError } from "../problem-details";
import { readConfiguredServerUrl, resolveUserConfigPath, UserConfigFileError } from "../userConfig";

export type NativePlatform = "android" | "ios";

export type DoctorCheckStatus = "fail" | "pass" | "skip" | "warn";

export type DoctorCheckResult = {
  severity?: "info";
  reason?: string;
  prerequisites?: string[];
  scope?: "setup" | "delivery";
  platform?: NativePlatform;
  advice?: string[];
  detail?: string;
  evidence?: Record<string, unknown>;
  id: string;
  issues?: string[];
  nextCommands?: string[];
  status: DoctorCheckStatus;
  title: string;
};

export type DoctorCheckGroup = {
  checks: DoctorCheckResult[];
  id: string;
  title: string;
};

export type DoctorCoverage = {
  state: "complete" | "incomplete" | "not_requested";
  outcome: "passed" | "warnings" | "failed" | "not_verified";
  reasons: string[];
  platforms?: Partial<Record<NativePlatform, DoctorCoverage>>;
};

/** `cmpatch doctor`'s result, minus `fixes`: this doctor offers none (Spec.md › Decisions, 1). */
export type DoctorResult = {
  coverage: { setup: DoctorCoverage; delivery: DoctorCoverage };
  command: "doctor";
  exitCode: 0 | 1;
  groups: DoctorCheckGroup[];
  summary: {
    fail: number;
    pass: number;
    skip: number;
    total: number;
    warn: number;
  };
};

/** What a doctor run was asked to look at, read and validated from the flags. */
export interface DoctorOptions {
  app?: string;
  appId?: string;
  currentPackageHash?: string;
  deployment?: string;
  deploymentId?: string;
  deploymentKey?: string;
  downloadBaseUrl?: string;
  platform?: NativePlatform;
  projectRoot: string;
  /** `--server-url` alone; the resolved server and its source are worked out per run. */
  serverUrl?: string;
  targetBinaryVersion?: string;
  team?: string;
  token?: string;
  /** Internal, per platform plan: selectors were given but cannot be bound to this platform. */
  unboundSelectors?: boolean;
  verbose: boolean;
  verifyDelivery: boolean;
}

type AuthProbeSource =
  | { kind: "flag" | "env" | "stored"; token: string }
  | { kind: "none" }
  | { detail: string; kind: "stored-invalid" };

type NamedResource = { id: string; name: string };

type DeploymentResource = NamedResource & { deploymentKey?: string };

type DoctorExecutionState = {
  appId?: string;
  downloadBaseUrl?: string;
  deployment?: DeploymentResource;
  deploymentId?: string;
  platform?: NativePlatform;
  serverUrl?: string;
  targetBinaryVersion?: string;
  teamId?: string;
  teams?: NamedResource[];
  token?: string;
};

type ResolvedServerUrl = { source: "command" | "env" | "user-config"; value: string };

/**
 * Bounds every remote probe doctor makes. A hung server or delivery origin is itself a
 * finding — it must surface as a failed check within seconds, not stall the whole run.
 */
const DOCTOR_REQUEST_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const doctorCommand: CommandDefinition = {
  flags: [
    {
      help: "Platform to diagnose (default: each platform the app is configured for)",
      name: "platform",
      type: "string",
      value: "ios|android",
    },
    {
      help: "App repository root (default: the current directory)",
      name: "project-root",
      type: "string",
      value: "path",
    },
    ...APP_SELECTOR_FLAGS,
    {
      help: "Deployment of that app, by name, e.g. Staging or Production",
      name: "deployment",
      type: "string",
      value: "name",
    },
    {
      help: "Deployment by id (instead of --deployment); doctor verifies it within the app named by --app or --app-id",
      name: "deployment-id",
      type: "string",
      value: "id",
    },
    ...CONNECTION_FLAGS,
    FORMAT_FLAG,
    { help: "Show every check, not just failures", name: "verbose", type: "boolean" },
    {
      help: "Verify manifests and advertised artifact accessibility",
      name: "verify-delivery",
      type: "boolean",
    },
    {
      help: "Deployment key the app uses, to compare and to probe delivery with",
      name: "deployment-key",
      type: "string",
      value: "key",
    },
    {
      help: "Exact native app version (CFBundleShortVersionString / versionName)",
      name: "target-binary-version",
      type: "string",
      value: "version",
    },
    {
      help: "Override the artifact download origin",
      name: "download-base-url",
      type: "string",
      value: "url",
    },
    {
      help: "Simulate an installed package (requires --verify-delivery)",
      name: "current-package-hash",
      type: "string",
      value: "hash",
    },
  ],
  notes: [
    "Read-only: no sign-in refresh, no configuration writes, no `npx cap sync`, no build and no publication.",
    "Exits 1 when a check fails; warnings and incomplete coverage still exit 0.",
  ],
  path: ["doctor"],
  run: async (values, deps) => {
    const options = readDoctorOptions(values);
    const format = selectOutputFormat(readRequestedFormat(values), deps.stdout);
    const progress = createDoctorProgress(
      format === "text" && deps.stdout.isTTY === true && !deps.env.CI ? deps.stderr : undefined,
    );
    const result = sanitizeDoctorOutput(await runDoctorChecks(options, deps, progress));
    progress.stop("Diagnostic checks completed");

    return {
      exitCode: result.exitCode,
      json: result,
      kind: "report",
      text: renderDoctorText(result, options),
    };
  },
  summary: "Diagnose local setup and OTA readiness",
  usage: "[flags]",
};

function readDoctorOptions(values: FlagValues): DoctorOptions {
  const currentPackageHash = readString(values, "current-package-hash");
  const verifyDelivery = readBoolean(values, "verify-delivery");
  if (currentPackageHash !== undefined && !verifyDelivery) {
    throw new UsageError("--current-package-hash requires --verify-delivery.");
  }

  const app = readString(values, "app");
  const appId = readString(values, "app-id");
  if (app !== undefined && appId !== undefined) {
    throw new UsageError("--app-id already identifies the app; it cannot be combined with --app.");
  }

  const deployment = readString(values, "deployment");
  const deploymentId = readString(values, "deployment-id");
  if (deployment !== undefined && deploymentId !== undefined) {
    throw new UsageError(
      "--deployment-id already identifies the deployment; it cannot be combined with --deployment.",
    );
  }

  const platform = readString(values, "platform");
  if (platform !== undefined && platform !== "ios" && platform !== "android") {
    throw new UsageError("--platform must be either ios or android.");
  }

  return {
    app,
    appId,
    currentPackageHash,
    deployment,
    deploymentId,
    deploymentKey: readString(values, "deployment-key"),
    downloadBaseUrl: readString(values, "download-base-url"),
    platform,
    projectRoot: readString(values, "project-root") ?? ".",
    serverUrl: readString(values, "server-url"),
    targetBinaryVersion: readString(values, "target-binary-version"),
    team: readString(values, "team"),
    token: readString(values, "token"),
    verbose: readBoolean(values, "verbose"),
    verifyDelivery,
  };
}

// ---------------------------------------------------------------------------
// Progress: cmpatch's plain-line renderer (cli/src/progress.ts) — this CLI has no spinner
// ---------------------------------------------------------------------------

interface DoctorProgress {
  stop: (message: string) => void;
  write: (message: string) => void;
}

function createDoctorProgress(stderr: WritableStream | undefined): DoctorProgress {
  if (stderr === undefined) {
    return { stop: () => {}, write: () => {} };
  }

  let closed = false;
  return {
    stop: (message) => {
      if (!closed) {
        closed = true;
        writeLine(stderr, `doctor: ${message}`);
      }
    },
    write: (message) => writeLine(stderr, `doctor: ${message}`),
  };
}

function sanitizeDoctorOutput<T>(value: T): T {
  if (typeof value === "string")
    return redactUrlText(value)
      .replace(SERVER_CREDENTIAL_PATTERN, "<redacted>")
      .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "<redacted>") as T;
  if (Array.isArray(value)) return value.map(sanitizeDoctorOutput) as T;
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeDoctorOutput(item)]),
    ) as T;
  return value;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function runDoctorChecks(
  options: DoctorOptions,
  deps: CliDeps,
  progress: DoctorProgress,
): Promise<DoctorResult> {
  const projectRoot = resolve(options.projectRoot);
  progress.write("Checking local configuration");
  const projectRootCheck = await checkProjectRoot(options.projectRoot);
  const userConfig = checkUserConfig(deps.env);
  const credentialStoreCheck = await checkCredentialStore(deps.env);
  const serverUrl = resolveDoctorServerUrl(options, deps.env, userConfig.serverUrl);
  progress.write("Inspecting application SDK configuration");
  const discovery = await discoverCapacitorProject(options);
  const contextGroup: DoctorCheckGroup = {
    checks: [
      commandShapeCheck(options),
      projectRootCheck,
      userConfig.check,
      toCheck(discovery.configCheck, "Capacitor config"),
      credentialStoreCheck,
      checkEffectiveContext(options, projectRoot, serverUrl),
    ],
    id: "context",
    title: "Context",
  };
  const projectExists = projectRootCheck.status === "pass";
  const state: DoctorExecutionState = {};
  const configured = discovery.platforms.filter((item) => item.intent === "configured");
  progress.write("Checking control plane and project");
  const baseChecks = await runControlPlaneBaseChecks(
    deps,
    options,
    serverUrl?.value,
    state,
    options.team === undefined &&
      (configured.length ? configured.every((item) => item.binding.appId !== undefined) : options.appId !== undefined),
  );
  const sdkConfigCheck = await checkServerSdkConfig(deps, state);
  await bindByDeploymentKey(deps, discovery.platforms, options, state);
  const groups: DoctorCheckGroup[] = [
    contextGroup,
    { checks: discovery.findings.map((finding) => toCheck(finding)), id: "sdk-project", title: "SDK Project" },
    { checks: [...baseChecks, sdkConfigCheck], id: "control-plane", title: "Control Plane" },
    {
      checks: discovery.webAssets.map((finding) => toCheck(finding, "Built web assets")),
      id: "web-assets",
      title: "Web Assets",
    },
  ];
  for (const item of discovery.platforms.filter((candidate) => candidate.intent !== "configured")) {
    groups.push({
      checks: item.findings.map((finding) => ({ ...toCheck(finding), platform: item.platform })),
      id: `sdk-${item.platform}`,
      title: `SDK Configuration (${item.platform})`,
    });
  }

  // No platform in scope still gets the CLI and server probes, never a guessed SDK binding.
  const publicationCache: PublicationCache = new Map();
  const plans: Array<PlatformDiscovery | undefined> = configured.length ? configured : [undefined];
  /** Each plan's platform once its native checks ran, for the device handoff below. */
  const planPlatforms: Array<NativePlatform | undefined> = [];
  for (const item of plans) {
    const requestedPlatform = item?.platform ?? options.platform;
    const suffix = configured.length > 1 ? `-${requestedPlatform}` : "";
    const localState: DoctorExecutionState = { ...state, ...(requestedPlatform ? { platform: requestedPlatform } : {}) };
    const binding = item?.binding;
    const plan: DoctorOptions = item
      ? {
          ...options,
          platform: item.platform,
          unboundSelectors:
            binding!.state === "unresolved" &&
            ((options.app !== undefined || options.appId !== undefined || options.deploymentId !== undefined) &&
              binding!.appId === undefined &&
              binding!.app === undefined),
          app: binding!.app,
          appId: binding!.appId,
          deployment: binding!.deployment,
          deploymentId: binding!.deploymentId,
          deploymentKey: configured.length === 1 ? options.deploymentKey : undefined,
        }
      : options;
    progress.write(`Checking ${requestedPlatform ?? "selected"} setup and download connectivity`);
    const targetChecks = await runControlPlaneTargetChecks(deps, plan, localState);
    const nativeChecks = await runNativeChecks(plan, {
      discovery: discovery.platforms,
      projectExists,
      projectRoot,
      state: localState,
    });
    // With no platform in scope and no --platform, runNativeChecks detects it from the
    // native directories: the groups, their checks and coverage are reported under it.
    const platform = localState.platform;
    planPlatforms.push(platform);
    const settings = item?.settings;
    const sdkChecks = item ? [...item.findings.map((finding) => toCheck(finding)), ...compareApplicationSettings(item, plan, localState)] : [];
    // An application URL gets its own probe; the override never erases it.
    const appDownload = settings?.downloadBaseUrl.state === "resolved" ? settings.downloadBaseUrl : undefined;
    const urls = [...new Set([...(appDownload ? [appDownload.value!] : []), ...(options.downloadBaseUrl ? [options.downloadBaseUrl] : [])])];
    const downloadChecks: DoctorCheckResult[] = urls.length
      ? await Promise.all(
          urls.map(async (url) => {
            const check = await probeDownloadOrigin(deps.fetch, url);
            return {
              ...check,
              evidence: {
                ...check.evidence,
                override: options.downloadBaseUrl === url,
                sources: appDownload?.value === url ? [appDownload.source] : [],
              },
            };
          }),
        )
      : [
          {
            detail: "No resolved application download URL or explicit probe override is available.",
            id: "download-connectivity",
            reason: "unresolved",
            status: "skip",
            title: "Download endpoint connectivity",
          },
        ];
    const appKey = settings?.deploymentKey.state === "resolved" && binding?.state === "resolved" ? settings.deploymentKey.value : undefined;
    const deliveryKey = plan.deploymentKey ?? appKey;
    const deliveryChecks: DoctorCheckResult[] = options.verifyDelivery
      ? await verifyDoctorDelivery({
          cache: publicationCache,
          currentHash: options.currentPackageHash,
          deploymentId:
            deliveryKey === undefined || deliveryKey === localState.deployment?.deploymentKey ? localState.deploymentId : undefined,
          deploymentKey: deliveryKey ?? localState.deployment?.deploymentKey,
          downloadBaseUrl: options.downloadBaseUrl ?? appDownload?.value,
          fetch: deps.fetch,
          serverUrl: localState.serverUrl,
          token: localState.token,
          version: localState.targetBinaryVersion ?? options.targetBinaryVersion,
        })
      : [
          {
            detail:
              "Delivery verification was not requested. No release history, metadata, manifests, or OTA artifacts were requested.",
            id: "delivery-not-requested",
            reason: "not_requested",
            status: "skip",
            title: "Optional delivery verification",
          },
        ];
    const platformGroups: DoctorCheckGroup[] = [
      { checks: targetChecks, id: `control-plane${suffix || "-target"}`, title: `Control Plane${platform ? ` (${platform})` : ""}` },
      { checks: nativeChecks, id: `native${suffix}`, title: `Native Project${platform ? ` (${platform})` : ""}` },
      { checks: sdkChecks, id: `sdk-${platform ?? "unknown"}`, title: `SDK Configuration (${platform ?? "unresolved"})` },
      { checks: downloadChecks, id: `download${suffix}`, title: `Download Connectivity${platform ? ` (${platform})` : ""}` },
      {
        checks: deliveryChecks.map((check) => ({ ...check, scope: "delivery" })),
        id: `delivery${suffix}`,
        title: `Optional Delivery${platform ? ` (${platform})` : ""}`,
      },
    ];
    for (const group of platformGroups)
      group.checks = group.checks.map((check) => ({ ...check, ...(platform ? { platform } : {}) }));
    groups.push(...platformGroups);
  }

  const preliminary = createDoctorResult(groups);
  for (const platform of planPlatforms) {
    const setup = platform ? preliminary.coverage.setup.platforms?.[platform] : preliminary.coverage.setup;
    const complete = setup?.state === "complete" && setup.outcome !== "failed";
    const logCommand = platform === "android" ? ["adb logcat -s Capacitor/CodemagicPatch"] : [];
    groups.push({
      checks: [
        {
          detail: complete
            ? "Evaluated setup assertions are complete; device behavior remains unverified."
            : "Review setup findings before moving to device debugging.",
          id: "device-debug-handoff",
          ...(complete && logCommand.length ? { nextCommands: logCommand } : {}),
          ...(platform ? { platform } : {}),
          reason: "not_applicable",
          status: complete ? "pass" : "skip",
          title: "Device debugging handoff",
        },
      ],
      id: configured.length > 1 ? `device-${platform}` : "device",
      title: `Device Debugging${platform ? ` (${platform})` : ""}`,
    });
  }
  return createDoctorResult(groups);
}

/** A discovery finding as a check: cmpatch's `toCheck`, titles included. */
function toCheck(finding: DiscoveryFinding, title?: string): DoctorCheckResult {
  return {
    id: finding.id,
    ...(finding.severity ? { severity: finding.severity } : {}),
    ...(finding.platform ? { platform: finding.platform } : {}),
    title:
      title ??
      finding.id
        .replace(/^sdk-/, "")
        .replace(/-/g, " ")
        .replace(/apiUrl/g, "API URL")
        .replace(/downloadBaseUrl/g, "download URL")
        .replace(/deploymentKey/g, "deployment key")
        .replace(/publicKey/g, "public key")
        .replace(/maxLaunchAttempts/g, "max launch attempts") + (finding.platform ? ` (${finding.platform})` : ""),
    status: finding.status,
    detail: finding.detail,
    ...(finding.reason ? { reason: finding.reason } : {}),
    ...(finding.prerequisites ? { prerequisites: finding.prerequisites } : {}),
    evidence: { sources: finding.sources, ...finding.evidence },
    ...(finding.advice ? { advice: finding.advice } : {}),
  };
}

/**
 * Key-based binding (Spec.md › Key-based binding): with no explicit selectors, a
 * platform whose deployment key is resolved is bound to the one deployment, among the
 * selected team's Capacitor apps, that holds it. No match is not evidence the key is
 * unknown to the server — only that it is outside the searched scope — so it is never a
 * failure; only an explicitly selected deployment can turn a key mismatch into one.
 */
async function bindByDeploymentKey(
  deps: CliDeps,
  platforms: PlatformDiscovery[],
  options: DoctorOptions,
  state: DoctorExecutionState,
): Promise<void> {
  const configured = platforms.filter((item) => item.intent === "configured");
  const pending = configured.filter((item) => needsKeyBinding(item, options));
  if (!pending.length) return;
  let deployments: Promise<Array<{ app: NamedResource; deployment: DeploymentResource }>> | undefined;
  const listDeployments = () =>
    (deployments ??= (async () => {
      const apps = parseNamedResourceList(await doctorGet(deps, state.serverUrl!, teamAppsPath(state.teamId!), state.token), "apps");
      if (apps.length > KEY_BINDING_APP_LIMIT) throw new KeyBindingLimitError();
      const lists = await Promise.all(
        apps.map(async (app) =>
          parseDeploymentList(
            await doctorGet(deps, state.serverUrl!, `/v1/apps/${encodeURIComponent(app.id)}/deployments`, state.token),
          ).map((deployment) => ({ app, deployment })),
        ),
      );
      return lists.flat();
    })());
  for (const item of pending) {
    const platform = item.platform;
    const base = { id: "sdk-platform-binding", sources: [] as string[] };
    const explicitAdvice = `Pass --platform ${platform} with --app-id <id> and --deployment-id <id> (see \`${CLI_NAME} deployment list\`).`;
    const flagKey = configured.length === 1 ? options.deploymentKey : undefined;
    const appKey = item.settings?.deploymentKey;
    const key = flagKey ?? (appKey?.state === "resolved" ? appKey.value : undefined);
    if (key === undefined) {
      item.findings.push({
        ...base,
        advice: [`Pass --platform ${platform} with --deployment-key <key>.`, explicitAdvice],
        detail: "The app's deployment key is not resolved, so this platform cannot be bound to a deployment by it.",
        reason: "unresolved",
        status: "skip",
      });
      continue;
    }
    if (state.serverUrl === undefined || state.token === undefined) {
      item.findings.push({
        ...base,
        detail: "Binding by deployment key needs a successful authenticated request.",
        prerequisites: ["auth"],
        reason: "blocked",
        status: "skip",
      });
      continue;
    }
    if (state.teamId === undefined) {
      item.findings.push({
        ...base,
        advice: ["Pass --team <name or id>.", explicitAdvice],
        detail: "Binding by deployment key searches one team, and no team is selected.",
        reason: "unresolved",
        status: "skip",
      });
      continue;
    }
    const teamName = state.teams?.find((team) => team.id === state.teamId)?.name ?? state.teamId;
    let matches: Array<{ app: NamedResource; deployment: DeploymentResource }>;
    try {
      matches = (await listDeployments()).filter((entry) => entry.deployment.deploymentKey === key);
    } catch (error) {
      item.findings.push({
        ...base,
        advice: [explicitAdvice],
        detail:
          error instanceof KeyBindingLimitError
            ? `Team ${teamName} has more than ${KEY_BINDING_APP_LIMIT} Capacitor apps; doctor does not search them all.`
            : `The team's Capacitor apps and deployments could not be listed: ${formatRequestError(error)}`,
        reason: error instanceof KeyBindingLimitError ? "discovery_limit" : error instanceof DoctorRedirectError ? "redirect" : "unresolved",
        status: "skip",
      });
      continue;
    }
    if (matches.length !== 1) {
      item.findings.push({
        ...base,
        advice: [explicitAdvice],
        detail: matches.length
          ? `${matches.length} deployments of Capacitor apps in team ${teamName} have this key; doctor cannot tell which one the app uses.`
          : `No deployment of a Capacitor app in team ${teamName} has this key. It may belong to another team, or to an app not labelled capacitor; this is not evidence that the key is unknown to the server.`,
        reason: "unresolved",
        status: "skip",
      });
      continue;
    }
    const { app, deployment } = matches[0]!;
    item.binding = { appId: app.id, deploymentId: deployment.id, method: "key", state: "resolved" };
    item.findings.push({
      ...base,
      detail: `Bound by ${flagKey !== undefined ? "the supplied" : "the app's"} deployment key to deployment ${deployment.name} of app ${app.name}.`,
      evidence: { appId: app.id, appName: app.name, deploymentId: deployment.id, deploymentName: deployment.name, teamId: state.teamId },
      status: "pass",
    });
  }
}

/** Key-based binding lists every Capacitor app's deployments; past this many it stops. */
const KEY_BINDING_APP_LIMIT = 50;

class KeyBindingLimitError extends Error {}

/** cmpatch's `compareApplicationSettings`, for this SDK's one source of settings. */
function compareApplicationSettings(
  item: PlatformDiscovery,
  options: DoctorOptions,
  state: DoctorExecutionState,
): DoctorCheckResult[] {
  const settings = item.settings;
  if (!settings) return [];
  const value = (name: "apiUrl" | "downloadBaseUrl" | "deploymentKey") =>
    settings[name].state === "resolved" ? settings[name].value : undefined;
  const key = value("deploymentKey");
  const verified = item.binding.state === "resolved" && state.appId && state.deployment?.deploymentKey && key;
  return [
    compareUrl("sdk-native-api-comparison", value("apiUrl"), state.serverUrl, settings.apiUrl.source),
    {
      ...compareUrl("sdk-native-download-comparison", value("downloadBaseUrl"), state.downloadBaseUrl, settings.downloadBaseUrl.source),
      prerequisites: ["server-sdk-config"],
    },
    {
      id: "sdk-native-key-comparison",
      title: "Application deployment key",
      status: verified ? (key === state.deployment!.deploymentKey ? "pass" : "fail") : "skip",
      ...(!verified
        ? {
            prerequisites: [
              "app",
              "deployment",
              "sdk-native-deploymentKey",
              ...(item.binding.state === "unresolved" ? ["sdk-platform-binding"] : []),
            ],
            reason: "blocked",
          }
        : {}),
      detail: verified
        ? key === state.deployment!.deploymentKey
          ? "Application key matches the verified deployment."
          : "Application key differs from the verified deployment; a CLI override does not repair the app."
        : "Application key comparison needs resolved same-platform app, deployment, and source evidence.",
      evidence: { overrideSupplied: options.deploymentKey !== undefined, source: settings.deploymentKey.source },
    },
  ];
}

/** `--server-url`, then CODEMAGIC_PATCH_SERVER_URL, then the user config — api.ts's order. */
function resolveDoctorServerUrl(
  options: DoctorOptions,
  env: Record<string, string | undefined>,
  configured: string | undefined,
): ResolvedServerUrl | undefined {
  if (options.serverUrl !== undefined) return { source: "command", value: options.serverUrl.trim() };
  const fromEnv = env[SERVER_URL_ENV]?.trim();
  if (fromEnv) return { source: "env", value: fromEnv };
  return configured === undefined ? undefined : { source: "user-config", value: configured };
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function commandShapeCheck(options: DoctorOptions): DoctorCheckResult {
  return {
    detail: "The doctor command parsed successfully.",
    evidence: { receivedInputs: summarizeReceivedInputs(options) },
    id: "command",
    status: "pass",
    title: "Command shape",
  };
}

async function checkProjectRoot(inputPath: string): Promise<DoctorCheckResult> {
  const projectRoot = resolve(inputPath);

  try {
    const stats = await stat(projectRoot);
    if (!stats.isDirectory()) {
      return {
        advice: ["Pass `--project-root <path>` from the app repository root."],
        detail: `${projectRoot} is not a directory.`,
        evidence: { projectRoot },
        id: "project-root",
        issues: ["The configured project root is not a directory."],
        status: "fail",
        title: "Project root",
      };
    }

    return {
      detail: `Using project root ${projectRoot}.`,
      evidence: { projectRoot },
      id: "project-root",
      status: "pass",
      title: "Project root",
    };
  } catch (error) {
    return {
      advice: ["Pass `--project-root <path>` from the app repository root."],
      detail: `${projectRoot} was not found${formatErrorSuffix(error)}.`,
      evidence: { projectRoot },
      id: "project-root",
      issues: ["The configured project root could not be read."],
      status: "fail",
      title: "Project root",
    };
  }
}

/**
 * Validates only what this CLI reads from the user config — the file parses and its
 * `serverUrl`, if any, is a string — exactly as userConfig.ts does. Other keys,
 * `cmpatch`'s team defaults among them, are neither validated nor reported
 * (Spec.md › Deliberate differences).
 */
function checkUserConfig(env: Record<string, string | undefined>): {
  check: DoctorCheckResult;
  serverUrl?: string;
} {
  const path = resolveUserConfigPath(env);

  try {
    const configured = readConfiguredServerUrl(env);
    return {
      check: {
        detail: configured
          ? `Loaded user config from ${path}.`
          : `No server URL is set in the user config at ${path}.`,
        evidence: { path, serverUrl: configured !== undefined },
        id: "user-config",
        status: "pass",
        title: "User config",
      },
      ...(configured ? { serverUrl: configured.serverUrl } : {}),
    };
  } catch (error) {
    if (!(error instanceof UserConfigFileError)) throw error;
    return {
      check: {
        advice: [`Fix or remove the user config file, then rerun \`${CLI_NAME} doctor\`.`],
        detail: error.message,
        evidence: { path },
        id: "user-config",
        issues: [`The user config file is not valid ${PRODUCT_NAME} config JSON.`],
        status: "fail",
        title: "User config",
      },
    };
  }
}

async function checkCredentialStore(env: Record<string, string | undefined>): Promise<DoctorCheckResult> {
  const path = resolveCredentialStorePath(env);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        detail: `No stored credential file found at ${path}.`,
        evidence: { path, present: false },
        id: "credential-store",
        status: "pass",
        title: "Stored credentials",
      };
    }
    return credentialStoreFailure(`Could not read stored credentials at ${path}${formatErrorSuffix(error)}.`, path);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return credentialStoreFailure(`Could not read stored credentials at ${path}${formatErrorSuffix(error)}.`, path);
  }

  const validation = validateCredentialStoreFile(parsed);
  if (!validation.ok) {
    return credentialStoreFailure(`Stored credential file is invalid: ${validation.error}.`, path);
  }

  return {
    detail: `Stored credential file is readable at ${path}.`,
    evidence: { path, present: true, serverCount: validation.serverCount },
    id: "credential-store",
    status: "pass",
    title: "Stored credentials",
  };
}

function credentialStoreFailure(detail: string, path: string): DoctorCheckResult {
  return {
    advice: [`Run \`${CLI_NAME} login\` again after fixing or removing the credential file.`],
    detail,
    evidence: { path, present: true },
    id: "credential-store",
    issues: ["Stored credentials cannot be read safely."],
    status: "fail",
    title: "Stored credentials",
  };
}

function checkEffectiveContext(
  options: DoctorOptions,
  projectRoot: string,
  serverUrl: ResolvedServerUrl | undefined,
): DoctorCheckResult {
  const fromCommand = (value: string | undefined) =>
    value === undefined ? {} : { source: "command", value };
  const evidence: Record<string, unknown> = {
    projectRoot,
    ...(serverUrl ? { serverUrl } : {}),
    ...(options.team !== undefined ? { team: fromCommand(options.team) } : {}),
    ...(options.app !== undefined ? { app: fromCommand(options.app) } : {}),
    ...(options.appId !== undefined ? { appId: fromCommand(options.appId) } : {}),
    ...(options.deployment !== undefined ? { deployment: fromCommand(options.deployment) } : {}),
    ...(options.platform !== undefined ? { platform: fromCommand(options.platform) } : {}),
  };

  if (serverUrl === undefined) {
    return {
      advice: [
        `Pass --server-url <url>, set ${SERVER_URL_ENV}, or run \`${CLI_NAME} config set --server-url <url>\`.`,
      ],
      detail: "No server URL was resolved from flags, env, or user config.",
      evidence,
      id: "effective-context",
      issues: ["Remote checks cannot run until a server URL is configured."],
      status: "warn",
      title: "Effective context",
    };
  }

  return {
    detail: "Resolved effective local context.",
    evidence,
    id: "effective-context",
    status: "pass",
    title: "Effective context",
  };
}

// ---------------------------------------------------------------------------
// Control plane
// ---------------------------------------------------------------------------

async function runControlPlaneBaseChecks(
  deps: CliDeps,
  options: DoctorOptions,
  serverUrl: string | undefined,
  state: DoctorExecutionState,
  teamIndependent: boolean,
): Promise<DoctorCheckResult[]> {
  const serverUrlCheck = checkServerUrl(serverUrl, state);
  // The readiness probe is unauthenticated and independent of the auth->team chain;
  // both only need the validated server URL, so they overlap.
  const [healthCheck, authAndTeamChecks] = await Promise.all([
    checkServerHealth(deps, state),
    (async () => {
      const authCheck = await checkControlPlaneAuth(deps, options, state);
      const teamCheck: DoctorCheckResult = teamIndependent
        ? {
            detail: "App IDs are verified directly; no team selection is required.",
            id: "team",
            reason: "not_applicable",
            status: "skip",
            title: "Team",
          }
        : checkTeamResolution(options, state);
      if (teamCheck.status === "skip" && !teamCheck.reason) {
        teamCheck.reason = "blocked";
        teamCheck.prerequisites = ["auth"];
      }
      return [authCheck, teamCheck];
    })(),
  ]);

  return [serverUrlCheck, healthCheck, ...authAndTeamChecks];
}

async function runControlPlaneTargetChecks(
  deps: CliDeps,
  options: DoctorOptions,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult[]> {
  if (options.unboundSelectors)
    return ["app", "deployment", "deployment-key"].map((id) => ({
      advice: [`Select --platform ${options.platform} with its app and deployment.`],
      detail: "App/deployment selectors were supplied, but cannot be assigned to this platform safely.",
      id,
      prerequisites: ["sdk-platform-binding"],
      reason: "blocked",
      status: "skip" as const,
      title: id,
    }));
  const appCheck = await checkAppResolution(deps, options, state);
  const deploymentCheck = await checkDeploymentResolution(deps, options, state);
  const deploymentKeyCheck = checkDeploymentKey(options, state);
  if (appCheck.status === "skip" && (!state.token || !state.teamId)) {
    appCheck.reason = "blocked";
    appCheck.prerequisites = [!state.token ? "auth" : "team"];
  }
  if (deploymentCheck.status === "skip" && !state.appId) {
    deploymentCheck.reason = "blocked";
    deploymentCheck.prerequisites = ["app"];
  }
  if (deploymentKeyCheck.status === "skip" && !state.deployment) {
    deploymentKeyCheck.reason = "blocked";
    deploymentKeyCheck.prerequisites = ["deployment"];
  }

  return [appCheck, deploymentCheck, deploymentKeyCheck];
}

function checkServerUrl(serverUrl: string | undefined, state: DoctorExecutionState): DoctorCheckResult {
  if (serverUrl === undefined) {
    return {
      advice: [`Pass --server-url <url>, or run \`${CLI_NAME} config set --server-url <url>\`.`],
      detail: "Control-plane checks need a server URL.",
      id: "server-url",
      status: "skip",
      title: "Server URL",
    };
  }

  let parsed: URL;
  try {
    const url = httpUrl(serverUrl);
    if (!url) throw new Error("Invalid HTTP URL");
    parsed = url;
  } catch (error) {
    return {
      advice: [`Check \`${SERVER_URL_ENV}\` or run \`${CLI_NAME} config set --server-url <url>\`.`],
      detail: `${safeUrl(serverUrl)} is not a valid URL${formatErrorSuffix(error)}.`,
      evidence: { serverUrl: safeUrl(serverUrl) },
      id: "server-url",
      issues: ["The configured server URL cannot be parsed."],
      status: "fail",
      title: "Server URL",
    };
  }

  state.serverUrl = serverUrl;
  return {
    detail: `Using control-plane server ${safeUrl(serverUrl)}.`,
    evidence: { origin: parsed.origin, serverUrl: safeUrl(serverUrl) },
    id: "server-url",
    status: "pass",
    title: "Server URL",
  };
}

async function checkServerHealth(
  deps: Pick<CliDeps, "fetch">,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined) {
    return {
      detail: "Server health check needs a valid server URL.",
      id: "server-health",
      status: "skip",
      title: "Server health",
    };
  }

  // Readiness, not liveness: /health is ok even when the database is down; /health/ready
  // is 200 only when the database check passes, 503 otherwise.
  const url = buildApiUrl(state.serverUrl, "/health/ready");

  let response: Response;
  try {
    response = await deps.fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(DOCTOR_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      advice: ["Check the configured server URL and network access."],
      detail: formatRequestError(error),
      evidence: { url },
      id: "server-health",
      issues: ["The server readiness endpoint did not respond."],
      ...(error instanceof DoctorRedirectError ? { reason: "redirect" } : {}),
      status: "fail",
      title: "Server health",
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  if (response.ok && isRecord(body) && body.ok === true) {
    return {
      detail: "Server readiness endpoint reports ok=true.",
      evidence: { response: summarizeHealthResponse(body), url },
      id: "server-health",
      status: "pass",
      title: "Server health",
    };
  }

  if (response.status === 503) {
    return {
      advice: [
        "Check the database container and the server logs (e.g. docker compose logs postgres server).",
      ],
      detail: "Server readiness endpoint returned HTTP 503.",
      evidence: { response: summarizeHealthResponse(body), url },
      id: "server-health",
      issues: ["Readiness failed; inspect server logs to establish the cause."],
      status: "fail",
      title: "Server health",
    };
  }

  return {
    advice: ["Check the configured server URL and the server logs."],
    detail: `Server readiness endpoint returned HTTP ${response.status} with an unexpected readiness response.`,
    evidence: { url },
    id: "server-health",
    issues: ["The server readiness endpoint did not respond successfully."],
    status: "fail",
    title: "Server health",
  };
}

async function checkControlPlaneAuth(
  deps: CliDeps,
  options: DoctorOptions,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined) {
    return {
      detail: "Auth check needs a valid server URL.",
      id: "auth",
      status: "skip",
      title: "Authentication",
    };
  }

  const authSource = await resolveDoctorAuthSource(deps.env, options, state.serverUrl);
  if (authSource.kind === "stored-invalid") {
    return {
      advice: [`Run \`${CLI_NAME} login --server-url <url>\` after fixing stored credentials.`],
      detail: authSource.detail,
      evidence: { authSource: "stored" },
      id: "auth",
      issues: ["Stored credentials are present but not usable."],
      status: "fail",
      title: "Authentication",
    };
  }

  if (authSource.kind === "none") {
    return {
      advice: [`Run \`${CLI_NAME} login --server-url ${state.serverUrl}\` or pass --token/${TOKEN_ENV}.`],
      detail: "No token or stored session was found for authenticated checks.",
      evidence: { authSource: "none" },
      id: "auth",
      issues: ["Authenticated control-plane routes cannot be checked."],
      status: "fail",
      title: "Authentication",
    };
  }

  try {
    const response = await doctorGet(deps, state.serverUrl, "/v1/teams", authSource.token);
    const teams = parseNamedResourceList(response, "teams");
    state.teams = teams;
    state.token = authSource.token;

    return {
      detail: "Authenticated control-plane request succeeded.",
      evidence: { authSource: authSource.kind, teamCount: teams.length },
      id: "auth",
      status: "pass",
      title: "Authentication",
    };
  } catch (error) {
    return {
      advice: [
        error instanceof DoctorRedirectError
          ? "Use the verified canonical server URL; this is not evidence of an invalid token."
          : authSource.kind === "stored"
            ? `Run \`${CLI_NAME} login --server-url ${state.serverUrl}\` again.`
            : `Check the token passed with --token or ${TOKEN_ENV}.`,
      ],
      detail: formatRequestError(error),
      evidence: { authSource: authSource.kind },
      id: "auth",
      issues: [formatAuthFailureIssue(authSource.kind, error)],
      ...(error instanceof DoctorRedirectError ? { reason: "redirect" } : {}),
      status: "fail",
      title: "Authentication",
    };
  }
}

/** `--team` takes a name or an id (this CLI's selector), so an exact id is tried first. */
function checkTeamResolution(options: DoctorOptions, state: DoctorExecutionState): DoctorCheckResult {
  if (state.serverUrl === undefined || state.teams === undefined) {
    return {
      detail: "Team resolution needs a successful authenticated teams request.",
      id: "team",
      status: "skip",
      title: "Team",
    };
  }

  if (options.team !== undefined) {
    const byId = state.teams.find((team) => team.id === options.team);
    const match = byId
      ? { kind: "matched" as const, resource: byId }
      : matchNamedResource(state.teams, options.team, "Team");
    if (match.kind === "matched") {
      state.teamId = match.resource.id;
      return {
        detail: `Resolved team ${match.resource.name}.`,
        evidence: { teamId: match.resource.id, teamName: match.resource.name },
        id: "team",
        status: "pass",
        title: "Team",
      };
    }

    return resourceMatchFailure("team", options.team, match);
  }

  if (state.teams.length === 1) {
    state.teamId = state.teams[0]!.id;
    return {
      detail: `Auto-selected the only visible team ${state.teams[0]!.name}.`,
      evidence: { teamId: state.teams[0]!.id, teamName: state.teams[0]!.name },
      id: "team",
      status: "pass",
      title: "Team",
    };
  }

  if (state.teams.length === 0) {
    return {
      advice: [
        "Ask an admin to confirm the server provisioned its default team (default-team), or sign in with an account that can access it.",
      ],
      detail: "No teams are visible to the current principal.",
      id: "team",
      issues: ["Team resolution failed because no teams are available."],
      status: "fail",
      title: "Team",
    };
  }

  return {
    advice: ["Pass --team <name or id>."],
    detail:
      "Multiple teams are visible; doctor cannot pick one on its own, so team-scoped checks are skipped.",
    evidence: { teams: state.teams.map((team) => ({ id: team.id, name: team.name })) },
    id: "team",
    issues: ["No team was selected among several visible teams."],
    status: "warn",
    title: "Team",
  };
}

async function checkAppResolution(
  deps: CliDeps,
  options: DoctorOptions,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined || state.token === undefined) {
    return {
      detail: "App resolution needs a successful authenticated request.",
      id: "app",
      status: "skip",
      title: "App",
    };
  }

  if (options.app === undefined && options.appId === undefined) {
    return {
      advice: ["Pass --app <name> or --app-id <id>."],
      detail: "No app selector was provided.",
      id: "app",
      status: "skip",
      title: "App",
    };
  }

  if (state.teamId === undefined && (!options.appId || options.team)) {
    return {
      detail: "App resolution needs a resolved team.",
      id: "app",
      status: "skip",
      title: "App",
    };
  }

  try {
    if (options.appId) {
      const response = await doctorGet(
        deps,
        state.serverUrl,
        `/v1/apps/${encodeURIComponent(options.appId)}`,
        state.token,
      );
      const app = isRecord(response) ? response.app : undefined;
      const appTeam = isRecord(app) ? app.team_id : undefined;
      if (!isNamedResource(app) || app.id !== options.appId || typeof appTeam !== "string")
        throw new Error("Invalid app response");
      if (options.team && appTeam !== state.teamId)
        return {
          detail: "The requested app does not belong to the selected team.",
          id: "app",
          status: "fail",
          title: "App",
        };
      state.appId = app.id;
      return {
        detail: `Verified app ${app.name}.`,
        evidence: { appId: app.id, appName: app.name, teamId: appTeam },
        id: "app",
        status: "pass",
        title: "App",
      };
    }

    const response = await doctorGet(deps, state.serverUrl, teamAppsPath(state.teamId!), state.token);
    const apps = parseNamedResourceList(response, "apps");
    const match = matchNamedResource(apps, options.app!, "App");
    if (match.kind !== "matched") {
      return resourceMatchFailure("app", options.app!, match);
    }

    state.appId = match.resource.id;
    return {
      detail: `Resolved app ${match.resource.name}.`,
      evidence: { appId: match.resource.id, appName: match.resource.name, teamId: state.teamId },
      id: "app",
      status: "pass",
      title: "App",
    };
  } catch (error) {
    return {
      advice: [`Run \`${CLI_NAME} app list\` with the same team selector.`],
      detail: formatRequestError(error),
      id: "app",
      issues: ["App resolution request failed."],
      ...(error instanceof DoctorRedirectError ? { reason: "redirect" } : {}),
      status: "fail",
      title: "App",
    };
  }
}

async function checkDeploymentResolution(
  deps: CliDeps,
  options: DoctorOptions,
  state: DoctorExecutionState,
): Promise<DoctorCheckResult> {
  if (state.serverUrl === undefined || state.token === undefined) {
    return {
      detail: "Deployment resolution needs a successful authenticated request.",
      id: "deployment",
      status: "skip",
      title: "Deployment",
    };
  }

  if (options.deployment === undefined && options.deploymentId === undefined) {
    return {
      advice: ["Pass --deployment <name> or --deployment-id <id>, with --app or --app-id."],
      detail: "No deployment selector was provided.",
      id: "deployment",
      status: "skip",
      title: "Deployment",
    };
  }

  if (state.appId === undefined) {
    return {
      detail: "Deployment resolution needs a resolved app.",
      id: "deployment",
      status: "skip",
      title: "Deployment",
    };
  }

  try {
    const response = await doctorGet(
      deps,
      state.serverUrl,
      `/v1/apps/${encodeURIComponent(state.appId)}/deployments`,
      state.token,
    );
    const deployments = parseDeploymentList(response);
    const selector = options.deploymentId ?? options.deployment!;
    const candidates = options.deploymentId
      ? deployments.filter((resource) => resource.id === options.deploymentId)
      : deployments;
    const match = matchNamedResource(
      candidates,
      options.deploymentId ? (candidates[0]?.name ?? selector) : selector,
      "Deployment",
    );
    if (match.kind !== "matched") {
      return resourceMatchFailure("deployment", selector, match);
    }

    state.deployment = match.resource;
    state.deploymentId = match.resource.id;
    return {
      detail: `Resolved deployment ${match.resource.name}.`,
      evidence: {
        appId: state.appId,
        deploymentId: match.resource.id,
        deploymentName: match.resource.name,
        ...(match.resource.deploymentKey !== undefined
          ? { deploymentKey: redactValue(match.resource.deploymentKey) }
          : {}),
      },
      id: "deployment",
      status: "pass",
      title: "Deployment",
    };
  } catch (error) {
    return {
      advice: [`Run \`${CLI_NAME} deployment list\` with the same app selector.`],
      detail: formatRequestError(error),
      id: "deployment",
      issues: ["Deployment resolution request failed."],
      ...(error instanceof DoctorRedirectError ? { reason: "redirect" } : {}),
      status: "fail",
      title: "Deployment",
    };
  }
}

function checkDeploymentKey(options: DoctorOptions, state: DoctorExecutionState): DoctorCheckResult {
  if (options.deploymentKey !== undefined && looksLikeCredential(options.deploymentKey)) {
    return {
      advice: [`Use the deployment key from \`${CLI_NAME} deployment list\`, not a personal access token.`],
      detail: "The supplied deployment key looks like an API or OAuth credential.",
      evidence: { deploymentKey: "<redacted>" },
      id: "deployment-key",
      issues: ["A private credential may be wired as the client deployment key."],
      status: "fail",
      title: "Deployment key",
    };
  }

  const resolvedKey = state.deployment?.deploymentKey;
  if (options.deploymentKey !== undefined && resolvedKey !== undefined) {
    const matches = options.deploymentKey === resolvedKey;
    return {
      detail: matches
        ? "Supplied deployment key matches the resolved deployment."
        : "Supplied deployment key does not match the resolved deployment.",
      evidence: {
        resolvedDeploymentKey: redactValue(resolvedKey),
        suppliedDeploymentKey: redactValue(options.deploymentKey),
      },
      id: "deployment-key",
      ...(matches
        ? {}
        : {
            advice: [
              "Update the app's deploymentKey (plugins.CodemagicPatch.<platform>.deploymentKey, or its CodemagicPatchDeploymentKey native override).",
            ],
            issues: ["The client may be pointing at a different deployment."],
            nextCommands: [`${CLI_NAME} deployment list`],
          }),
      status: matches ? "pass" : "fail",
      title: "Deployment key",
    };
  }

  if (resolvedKey !== undefined) {
    return {
      detail: "Resolved deployment exposes a deployment key.",
      evidence: { resolvedDeploymentKey: redactValue(resolvedKey) },
      id: "deployment-key",
      status: "pass",
      title: "Deployment key",
    };
  }

  if (options.deploymentKey !== undefined) {
    return {
      advice: [`Resolve the app and deployment by name, or verify with \`${CLI_NAME} deployment list\`.`],
      detail: "A deployment key was supplied, but doctor could not resolve a deployment key to compare.",
      evidence: { suppliedDeploymentKey: redactValue(options.deploymentKey) },
      id: "deployment-key",
      nextCommands: [`${CLI_NAME} deployment list`],
      status: "skip",
      title: "Deployment key",
    };
  }

  return {
    detail: "Deployment key comparison needs a supplied key or a resolved deployment.",
    id: "deployment-key",
    status: "skip",
    title: "Deployment key",
  };
}

async function checkServerSdkConfig(deps: CliDeps, state: DoctorExecutionState): Promise<DoctorCheckResult> {
  const base = { id: "server-sdk-config", title: "Server SDK configuration" };
  if (!state.serverUrl || !state.token)
    return {
      ...base,
      detail: "Server comparison requires authentication; public connectivity remains independent.",
      prerequisites: ["auth"],
      reason: "blocked",
      status: "skip",
    };
  try {
    const response = await doctorGet(deps, state.serverUrl, "/v1/sdk-config", state.token);
    if (
      !isRecord(response) ||
      typeof response.download_base_url !== "string" ||
      !httpUrl(response.download_base_url)
    ) {
      return {
        ...base,
        detail: "The SDK-config endpoint did not return a valid download_base_url.",
        reason: "unresolved",
        status: "skip",
      };
    }
    state.downloadBaseUrl = response.download_base_url;
    return {
      ...base,
      detail: "Server download configuration was retrieved.",
      evidence: { downloadBaseUrl: safeUrl(state.downloadBaseUrl) },
      status: "pass",
    };
  } catch (error) {
    return {
      ...base,
      advice: [
        "Inspect the server's download configuration; public endpoint probes still run independently.",
      ],
      detail:
        error instanceof HttpProblemError && error.responseStatus === 501
          ? "Server SDK configuration is not available (HTTP 501)."
          : "Server SDK configuration could not be retrieved.",
      reason: "unresolved",
      status: "skip",
    };
  }
}

/**
 * `--token`, then CODEMAGIC_PATCH_TOKEN, then this CLI's stored sign-in — read as it is,
 * never refreshed or removed: doctor is read-only. Read through credentials.ts like every
 * other command (R18), so a store this version cannot read is reported with that module's
 * explanation and remedy rather than a generic failure — as a failed check, not a crash.
 */
async function resolveDoctorAuthSource(
  env: Record<string, string | undefined>,
  options: DoctorOptions,
  serverUrl: string,
): Promise<AuthProbeSource> {
  const flagToken = resolveOptionalString(options.token);
  if (flagToken !== undefined) return { kind: "flag", token: flagToken };

  const envToken = resolveOptionalString(env[TOKEN_ENV]);
  if (envToken !== undefined) return { kind: "env", token: envToken };

  try {
    const stored = await loadStoredCredential(serverUrl, { env });
    if (stored === null) return { kind: "none" };
    if (resolveOptionalString(stored.accessToken) === undefined) {
      return { detail: "Stored credential is missing a usable access token.", kind: "stored-invalid" };
    }
    return { kind: "stored", token: stored.accessToken };
  } catch (error) {
    return {
      detail:
        error instanceof ValidationError
          ? error.message
          : `Stored credential could not be read${formatErrorSuffix(error)}.`,
      kind: "stored-invalid",
    };
  }
}

class DoctorRedirectError extends Error {
  constructor(readonly target?: string) {
    super("Control-plane redirect");
  }
}

/** An authenticated GET that refuses redirects, so a token is never forwarded elsewhere. */
async function doctorGet(
  deps: Pick<CliDeps, "fetch">,
  serverUrl: string,
  pathname: string,
  token: string | undefined,
): Promise<unknown> {
  const url = buildApiUrl(serverUrl, pathname);
  const response = await deps.fetch(url, {
    headers: token !== undefined ? { authorization: `Bearer ${normalizeBearerToken(token)}` } : {},
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(DOCTOR_REQUEST_TIMEOUT_MS),
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel();
    let target: string | undefined;
    try {
      target = location ? safeUrl(new URL(location, url).toString()) : undefined;
    } catch {
      /* unavailable */
    }
    throw new DoctorRedirectError(target);
  }
  return request(async () => response, url, { method: "GET" });
}

// ---------------------------------------------------------------------------
// Native project
// ---------------------------------------------------------------------------

type NativeContext = {
  discovery: PlatformDiscovery[];
  projectExists: boolean;
  projectRoot: string;
  state: DoctorExecutionState;
};

async function runNativeChecks(options: DoctorOptions, context: NativeContext): Promise<DoctorCheckResult[]> {
  const platformResolution = await resolveDoctorPlatform(options, context);
  const platform = platformResolution.platform;
  if (platform !== undefined) context.state.platform = platform;
  const discovered = context.discovery.find((item) => item.platform === platform);

  return [
    platformResolution.check,
    await checkNativeDirectory(platform, discovered?.nativeRoot, context),
    checkTargetBinaryVersion(options, platform, discovered, context),
    {
      detail:
        "Capacitor releases are scoped by their exact binary version; no native fingerprint is computed.",
      id: "fingerprint",
      reason: "not_applicable",
      status: "skip",
      title: "Fingerprint",
    },
  ];
}

async function resolveDoctorPlatform(
  options: DoctorOptions,
  context: { projectExists: boolean; projectRoot: string },
): Promise<{ check: DoctorCheckResult; platform?: NativePlatform }> {
  if (options.platform !== undefined) {
    return {
      check: {
        detail: `Using ${options.platform} from command context.`,
        evidence: { platform: options.platform },
        id: "platform",
        status: "pass",
        title: "Platform",
      },
      platform: options.platform,
    };
  }

  if (!context.projectExists) {
    return {
      check: {
        detail: "Platform detection was skipped because the project root is not readable.",
        id: "platform",
        status: "skip",
        title: "Platform",
      },
    };
  }

  const platforms: NativePlatform[] = [];
  for (const candidate of ["ios", "android"] as const) {
    if (await isDirectory(join(context.projectRoot, candidate))) platforms.push(candidate);
  }
  if (platforms.length === 1) {
    return {
      check: {
        detail: `Detected ${platforms[0]} from native project directories.`,
        evidence: { platform: platforms[0] },
        id: "platform",
        status: "pass",
        title: "Platform",
      },
      platform: platforms[0]!,
    };
  }

  if (platforms.length > 1) {
    return {
      check: {
        advice: ["Pass `--platform ios` or `--platform android`."],
        detail: "Both ios and android native directories are present.",
        evidence: { detectedPlatforms: platforms },
        id: "platform",
        issues: ["Doctor needs one platform to run its native-project checks."],
        status: "warn",
        title: "Platform",
      },
    };
  }

  return {
    check: {
      advice: ["Pass `--platform ios` or `--platform android`."],
      detail: "No platform was configured or detected.",
      id: "platform",
      status: "skip",
      title: "Platform",
    },
  };
}

/** The platform's native project: `ios.path` / `android.path` in the Capacitor config, else `ios/` / `android/`. */
async function checkNativeDirectory(
  platform: NativePlatform | undefined,
  nativeRoot: string | undefined,
  context: { projectExists: boolean; projectRoot: string },
): Promise<DoctorCheckResult> {
  if (platform === undefined) {
    return {
      detail: "Native directory check needs a platform.",
      id: "native-directory",
      status: "skip",
      title: "Native directory",
    };
  }

  if (!context.projectExists) {
    return {
      detail: "Native directory check was skipped because the project root is not readable.",
      id: "native-directory",
      status: "skip",
      title: "Native directory",
    };
  }

  const directory = nativeRoot ?? join(context.projectRoot, platform);
  if (!(await isDirectory(directory))) {
    return {
      advice: [`Pass the correct \`--project-root\` or \`--platform\`, or add the platform with \`npx cap add ${platform}\`.`],
      detail: `No ${platform} native project was found at ${directory}.`,
      evidence: { nativeRoot: directory, platform, projectRoot: context.projectRoot },
      id: "native-directory",
      issues: ["The selected platform does not have a native project directory."],
      status: "fail",
      title: "Native directory",
    };
  }

  return {
    detail: `Found the ${platform} native project at ${directory}.`,
    evidence: { nativeRoot: directory, platform, projectRoot: context.projectRoot },
    id: "native-directory",
    status: "pass",
    title: "Native directory",
  };
}

function checkTargetBinaryVersion(
  options: DoctorOptions,
  platform: NativePlatform | undefined,
  discovered: PlatformDiscovery | undefined,
  context: { projectExists: boolean; state: DoctorExecutionState },
): DoctorCheckResult {
  if (options.targetBinaryVersion !== undefined) {
    if (!isPathSafeBinaryVersion(options.targetBinaryVersion)) {
      return {
        advice: ["Pass `--target-binary-version <version>` such as 1.2.3."],
        detail: `${options.targetBinaryVersion} is not a valid binary version: it must start with an alphanumeric character, contain only letters, digits, '.', '_', '+', '-', and be at most 128 characters.`,
        id: "target-binary-version",
        issues: ["The server will reject the supplied target binary version."],
        status: "fail",
        title: "Target binary version",
      };
    }

    context.state.targetBinaryVersion = options.targetBinaryVersion;
    return {
      detail: "Using supplied target binary version.",
      evidence: { source: "flag-or-default", targetBinaryVersion: options.targetBinaryVersion },
      id: "target-binary-version",
      status: "pass",
      title: "Target binary version",
    };
  }

  if (platform === undefined) {
    return {
      detail: "Target binary version detection needs a platform.",
      id: "target-binary-version",
      status: "skip",
      title: "Target binary version",
    };
  }

  if (!context.projectExists) {
    return {
      detail: "Target binary version detection was skipped because the project root is not readable.",
      id: "target-binary-version",
      status: "skip",
      title: "Target binary version",
    };
  }

  const detected = discovered?.version;
  if (detected?.state !== "resolved") {
    return {
      advice: ["Pass `--target-binary-version <version>`: the app's CFBundleShortVersionString (iOS) or versionName (Android)."],
      detail: detected?.detail ?? "The binary version could not be read from the native project.",
      id: "target-binary-version",
      reason: "unresolved",
      status: "skip",
      title: "Target binary version",
    };
  }

  context.state.targetBinaryVersion = detected.version;
  if (!isPathSafeBinaryVersion(detected.version)) {
    return {
      advice: ["Pass `--target-binary-version <version>` such as 1.2.3."],
      detail: `Detected target binary version '${detected.version}' from the native project, but the server will reject it: it must start with an alphanumeric character, contain only letters, digits, '.', '_', '+', '-', and be at most 128 characters.`,
      evidence: { platform, source: detected.source, targetBinaryVersion: detected.version },
      id: "target-binary-version",
      issues: ["The detected target binary version will be rejected by the server."],
      status: "warn",
      title: "Target binary version",
    };
  }

  return {
    detail: "Detected target binary version from the native project.",
    evidence: { platform, source: detected.source, targetBinaryVersion: detected.version },
    id: "target-binary-version",
    status: "pass",
    title: "Target binary version",
  };
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export function createDoctorResult(groups: DoctorCheckGroup[]): DoctorResult {
  for (const group of groups)
    for (const check of group.checks) {
      check.scope ??= "setup";
      if (check.status === "skip") check.reason ??= "unresolved";
      if (check.reason === "blocked" && !check.prerequisites) check.prerequisites = ["auth"];
    }
  const checks = groups.flatMap((group) => group.checks);
  const summarizeScope = (items: DoctorCheckResult[]): DoctorCoverage => {
    const applicable = items.filter(
      (check) =>
        check.severity !== "info" && !["not_applicable", "not_configured"].includes(check.reason ?? ""),
    );
    const reasons = [
      ...new Set(
        applicable
          .filter(
            (check) => check.status === "skip" || ["unresolved", "deferred"].includes(check.reason ?? ""),
          )
          .map((check) => check.reason ?? "unresolved"),
      ),
    ];
    const state =
      applicable.length > 0 && applicable.every((check) => check.reason === "not_requested")
        ? "not_requested"
        : !applicable.length || reasons.length
          ? "incomplete"
          : "complete";
    return {
      state,
      outcome: applicable.some((check) => check.status === "fail")
        ? "failed"
        : state !== "complete"
          ? "not_verified"
          : applicable.some((check) => check.status === "warn")
            ? "warnings"
            : "passed",
      reasons,
    };
  };
  const coverageFor = (scope: "setup" | "delivery"): DoctorCoverage => {
    const scoped = checks.filter((check) => check.scope === scope);
    const shared = scoped.filter((check) => !check.platform);
    return {
      ...summarizeScope(scoped),
      platforms: Object.fromEntries(
        (["ios", "android"] as const)
          .filter((platform) =>
            scoped.some((check) => check.platform === platform && check.reason !== "not_configured"),
          )
          .map((platform) => [
            platform,
            summarizeScope([...shared, ...scoped.filter((check) => check.platform === platform)]),
          ]),
      ),
    };
  };
  const summary = {
    fail: countChecks(checks, "fail"),
    pass: countChecks(checks, "pass"),
    skip: countChecks(checks, "skip"),
    total: checks.length,
    warn: countChecks(checks, "warn"),
  };

  return {
    command: "doctor",
    coverage: { setup: coverageFor("setup"), delivery: coverageFor("delivery") },
    exitCode: summary.fail > 0 ? 1 : 0,
    groups,
    summary,
  };
}

// ---------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------

const STATUS_SYMBOLS: Record<DoctorCheckStatus, string> = {
  fail: "✗",
  pass: "✓",
  skip: "○",
  warn: "!",
};

/** `cmpatch`'s `renderDoctorTable`, without colour (this CLI has no palette) or fixes. */
export function renderDoctorText(
  result: DoctorResult,
  options: Pick<DoctorOptions, "platform" | "projectRoot" | "verbose" | "verifyDelivery">,
): string {
  const platforms = Object.keys(result.coverage.setup.platforms ?? {});
  const lines = [
    `${PRODUCT_NAME} doctor · ${basename(resolve(options.projectRoot))}`,
    `Platforms: ${platforms.length ? platforms.join(", ") : (options.platform ?? "not determined")} · ${options.verifyDelivery ? "Setup and delivery verification" : "Setup checks; delivery not requested"}`,
    "",
    renderVerdict(result),
    "",
  ];
  const blockers = doctorBlockers(result.groups);

  for (const group of result.groups) {
    lines.push(renderGroupLine(group));
    const visibleChecks = options.verbose
      ? group.checks
      : group.checks.filter((check) => !blockers.has(check) && (isProblemCheck(check) || isNoticeCheck(check)));
    for (const check of visibleChecks) {
      lines.push(...renderCheckLines(check, options.verbose));
    }
    if (!options.verbose) {
      const affected = new Map<DoctorCheckResult, number>();
      for (const check of group.checks) {
        for (const root of blockers.get(check) ?? []) {
          affected.set(root, (affected.get(root) ?? 0) + 1);
        }
      }
      for (const [root, count] of affected) {
        lines.push(
          `  ○ ${count} ${count === 1 ? "check" : "checks"} blocked by ${root.title} [${root.id}${root.platform ? ` / ${root.platform}` : ""}].`,
        );
      }
    }
  }

  lines.push("");
  const coverageLine = (label: string, coverage: DoctorCoverage) =>
    `${label}: ${coverage.state.replaceAll("_", " ")} (${coverage.outcome.replaceAll("_", " ")}).`;
  lines.push(coverageLine("Setup", result.coverage.setup));
  lines.push(coverageLine("Delivery", result.coverage.delivery));
  if (result.coverage.delivery.state === "not_requested") {
    lines.push(`Run \`${CLI_NAME} doctor --verify-delivery\` to check published artifacts.`);
  }
  lines.push("Static/CLI evidence does not verify behavior on a device.");

  const handoffHint = renderHandoffHint(result);
  if (handoffHint !== null) lines.push(handoffHint);

  if (!options.verbose && countHiddenChecks(result) > 0) {
    lines.push(`Run \`${CLI_NAME} doctor --verbose\` to see all checks.`);
  }

  return `${lines.join("\n")}\n`;
}

/**
 * A group inherits the worst status of its checks: any failure taints the group, an
 * actionable skip counts as a warning (the user can unblock it), and a group whose
 * checks were all skipped is reported as skipped rather than passed.
 */
function rollupGroupStatus(group: DoctorCheckGroup): DoctorCheckStatus {
  if (group.checks.some((check) => check.status === "fail")) return "fail";
  if (group.checks.some((check) => check.status === "warn" || isActionableSkip(check))) return "warn";
  if (group.checks.every((check) => check.status === "skip") || group.checks.some(isDeliveryBoundary))
    return "skip";
  return "pass";
}

function renderGroupLine(group: DoctorCheckGroup): string {
  const status = rollupGroupStatus(group);
  if (status === "skip") {
    return `${STATUS_SYMBOLS[status]} ${group.title} — ${group.checks.some(isDeliveryBoundary) ? "verification incomplete" : "skipped"}`;
  }
  return `${STATUS_SYMBOLS[status]} ${group.title}`;
}

function isProblemCheck(check: DoctorCheckResult): boolean {
  return check.status === "fail" || check.status === "warn" || isActionableSkip(check);
}

function renderCheckLines(check: DoctorCheckResult, includeEvidence: boolean): string[] {
  const [firstIssue, ...remainingIssues] = check.issues ?? [];
  const lines = [
    `  ${check.severity === "info" ? "i" : STATUS_SYMBOLS[check.status]} ${check.title}${
      firstIssue !== undefined ? ` — ${firstIssue}` : ""
    }`,
  ];
  for (const issue of remainingIssues) lines.push(`      ${issue}`);
  if (check.detail !== undefined && check.detail.length > 0) {
    for (const line of check.detail.split("\n")) lines.push(`      ${line}`);
  }
  for (const advice of check.advice ?? []) lines.push(`      → ${advice}`);
  for (const nextCommand of nextCommandsNotInAdvice(check)) lines.push(`      $ ${nextCommand}`);
  if (includeEvidence && check.evidence !== undefined) {
    lines.push(`      Evidence: ${JSON.stringify(check.evidence)}`);
  }
  return lines;
}

/** Advice lines often spell out the next command verbatim; print it once. */
function nextCommandsNotInAdvice(check: DoctorCheckResult): string[] {
  const advice = check.advice ?? [];
  return (check.nextCommands ?? []).filter((nextCommand) => !advice.some((entry) => entry.includes(nextCommand)));
}

function renderVerdict(result: DoctorResult): string {
  const counts = `(${renderSummaryCounts(result.summary)})`;
  const failedAreas = result.groups.filter((group) => group.checks.some((check) => check.status === "fail")).length;
  if (failedAreas > 0) {
    return `✗ Doctor found issues in ${failedAreas} ${failedAreas === 1 ? "area" : "areas"}. ${counts}`;
  }

  const warningAreas = result.groups.filter((group) => rollupGroupStatus(group) === "warn").length;
  if (warningAreas > 0) {
    return `! Doctor found warnings in ${warningAreas} ${warningAreas === 1 ? "area" : "areas"}. ${counts}`;
  }

  if (result.coverage.setup.state !== "complete") {
    return `○ No confirmed failures; setup verification is incomplete. ${counts}`;
  }
  if (result.coverage.delivery.state === "incomplete") {
    return `○ Setup checks passed; delivery verification is incomplete. ${counts}`;
  }
  return `${result.coverage.delivery.state === "complete" ? "✓ Setup and published artifact accessibility checks passed." : "✓ Evaluated setup checks passed."} ${counts}`;
}

/**
 * The clean-run handoff pointer: passed setup checks cannot prove the device side, so the
 * closing hint says where to look if updates still do not arrive.
 */
function renderHandoffHint(result: DoctorResult): string | null {
  const commands = result.groups
    .flatMap((group) => group.checks)
    .filter((check) => check.id === "device-debug-handoff" && check.status === "pass")
    .flatMap((check) => check.nextCommands ?? []);
  if (commands.length === 0) return null;
  return `If updates still do not appear on a device, run ${commands.map((command) => `\`${command}\``).join(" or ")} while reproducing an update check.`;
}

function countHiddenChecks(result: DoctorResult): number {
  return result.groups
    .flatMap((group) => group.checks)
    .filter((check) => !isProblemCheck(check) && !isNoticeCheck(check)).length;
}

function renderSummaryCounts(summary: DoctorResult["summary"]): string {
  if (summary.total === 0) return "no checks ran";
  return [
    formatCount(summary.pass, "check passed", "checks passed"),
    formatCount(summary.warn, "warning", "warnings"),
    formatCount(summary.fail, "failed", "failed"),
    formatCount(summary.skip, "skipped", "skipped"),
  ]
    .filter((part) => part !== null)
    .join(", ");
}

function formatCount(count: number, singular: string, plural: string): string | null {
  return count === 0 ? null : `${count} ${count === 1 ? singular : plural}`;
}

function isDeliveryBoundary(check: DoctorCheckResult): boolean {
  return check.status === "skip" && ["no_artifact", "embedded_target"].includes(check.reason ?? "");
}

function isNoticeCheck(check: DoctorCheckResult): boolean {
  return check.severity === "info" || isDeliveryBoundary(check);
}

function isActionableSkip(check: DoctorCheckResult): boolean {
  if (isNoticeCheck(check)) return false;
  if (check.status === "skip" && ["blocked", "unresolved", "deferred"].includes(check.reason ?? "")) return true;
  return (
    check.status === "skip" &&
    ((check.issues?.length ?? 0) > 0 || (check.advice?.length ?? 0) > 0 || (check.nextCommands?.length ?? 0) > 0)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function summarizeReceivedInputs(options: DoctorOptions): Record<string, unknown> {
  return {
    ...(options.serverUrl !== undefined ? { serverUrl: options.serverUrl } : {}),
    ...(options.team !== undefined ? { team: options.team } : {}),
    ...(options.app !== undefined ? { app: options.app } : {}),
    ...(options.appId !== undefined ? { appId: options.appId } : {}),
    ...(options.deployment !== undefined ? { deployment: options.deployment } : {}),
    ...(options.deploymentId !== undefined ? { deploymentId: options.deploymentId } : {}),
    ...(options.platform !== undefined ? { platform: options.platform } : {}),
    projectRoot: options.projectRoot,
    ...(options.downloadBaseUrl !== undefined ? { downloadBaseUrl: options.downloadBaseUrl } : {}),
    ...(options.targetBinaryVersion !== undefined ? { targetBinaryVersion: options.targetBinaryVersion } : {}),
    ...(options.currentPackageHash !== undefined ? { currentPackageHash: options.currentPackageHash } : {}),
    ...(options.deploymentKey !== undefined ? { deploymentKey: redactValue(options.deploymentKey) } : {}),
    ...(options.token !== undefined ? { token: "<redacted>" } : {}),
  };
}

function parseNamedResourceList(response: unknown, wrapperKey: "apps" | "teams"): NamedResource[] {
  if (!isRecord(response) || !Array.isArray(response[wrapperKey])) {
    throw new UsageError(
      `Malformed ${wrapperKey} response: expected { "${wrapperKey}": [{ "id": string, "name": string }] }`,
    );
  }

  return response[wrapperKey].map((resource: unknown, index: number) => {
    if (!isNamedResource(resource)) {
      throw new UsageError(`Malformed ${wrapperKey} response: item ${index} must include string id and name`);
    }
    return { id: resource.id, name: resource.name };
  });
}

function parseDeploymentList(response: unknown): DeploymentResource[] {
  if (!isRecord(response) || !Array.isArray(response.deployments)) {
    throw new UsageError(
      'Malformed deployments response: expected { "deployments": [{ "id": string, "name": string, "deployment_key"?: string }] }',
    );
  }

  return response.deployments.map((deployment: unknown, index: number) => {
    if (!isNamedResource(deployment)) {
      throw new UsageError(`Malformed deployments response: item ${index} must include string id and name`);
    }
    const record = deployment as Record<string, unknown>;
    if ("deployment_key" in record && record.deployment_key !== undefined && typeof record.deployment_key !== "string") {
      throw new UsageError(`Malformed deployments response: item ${index} deployment_key must be a string`);
    }
    return {
      id: deployment.id,
      name: deployment.name,
      ...(typeof record.deployment_key === "string" ? { deploymentKey: record.deployment_key } : {}),
    };
  });
}

type MatchResult<T> =
  | { kind: "ambiguous"; matches: T[] }
  | { kind: "matched"; resource: T }
  | { kind: "missing"; label: "App" | "Deployment" | "Team" };

function matchNamedResource<T extends NamedResource>(
  resources: T[],
  requestedName: string,
  label: "App" | "Deployment" | "Team",
): MatchResult<T> {
  const exactMatches = resources.filter((resource) => resource.name === requestedName);
  if (exactMatches.length === 1) return { kind: "matched", resource: exactMatches[0]! };
  if (exactMatches.length > 1) return { kind: "ambiguous", matches: exactMatches };

  const normalizedName = requestedName.toLocaleLowerCase();
  const caseInsensitiveMatches = resources.filter(
    (resource) => resource.name.toLocaleLowerCase() === normalizedName,
  );
  if (caseInsensitiveMatches.length === 1) return { kind: "matched", resource: caseInsensitiveMatches[0]! };
  if (caseInsensitiveMatches.length > 1) return { kind: "ambiguous", matches: caseInsensitiveMatches };
  return { kind: "missing", label };
}

/** The flag that selects each resource by id in this CLI. */
const ID_SELECTOR: Record<"app" | "deployment" | "team", string> = {
  app: "--app-id <id>",
  deployment: "--deployment-id <id>",
  team: "--team <id>",
};

function resourceMatchFailure(
  id: "app" | "deployment" | "team",
  requestedName: string,
  match: Exclude<MatchResult<NamedResource>, { kind: "matched" }>,
): DoctorCheckResult {
  if (match.kind === "ambiguous") {
    return {
      advice: [`Pass ${ID_SELECTOR[id]}.`],
      detail: `${capitalize(id)} "${requestedName}" is ambiguous.`,
      evidence: { matches: match.matches.map((resource) => ({ id: resource.id, name: resource.name })) },
      id,
      issues: [`Multiple ${id} resources matched "${requestedName}".`],
      status: "fail",
      title: capitalize(id),
    };
  }

  return {
    advice: [
      id === "team"
        ? "Check --team against the teams this account can see."
        : `Run \`${CLI_NAME} ${id} list\` to inspect available resources.`,
    ],
    detail: `${match.label} "${requestedName}" was not found.`,
    id,
    issues: [`The selected ${id} does not exist or is not visible.`],
    status: "fail",
    title: capitalize(id),
  };
}

function summarizeHealthResponse(response: unknown): Record<string, unknown> {
  if (isRecord(response)) {
    return {
      ...(typeof response.mode === "string" ? { mode: response.mode } : {}),
      ...(typeof response.ok === "boolean" ? { ok: response.ok } : {}),
    };
  }
  return { type: response === null ? "empty" : typeof response };
}

function formatRequestError(error: unknown): string {
  if (error instanceof DoctorRedirectError)
    return `The control-plane endpoint redirected${error.target ? ` to ${error.target}` : ""}. No credentials were forwarded. Verify the canonical server URL and rerun with --server-url.`;
  if (error instanceof Error && error.name === "TimeoutError") {
    return `The request did not respond within ${DOCTOR_REQUEST_TIMEOUT_MS / 1000} seconds.`;
  }
  if (error instanceof HttpProblemError) {
    return `Control-plane request failed (HTTP ${error.responseStatus}).`;
  }
  return "The control-plane request failed or returned an unexpected response.";
}

function formatAuthFailureIssue(source: "flag" | "env" | "stored", error: unknown): string {
  if (error instanceof HttpProblemError && error.responseStatus === 401) {
    return source === "stored"
      ? "Stored credentials were rejected and may be expired or revoked."
      : "The supplied token was rejected.";
  }
  if (error instanceof HttpProblemError && error.responseStatus === 403) {
    return "The authenticated principal is forbidden from this server.";
  }
  return "Authenticated control-plane request failed.";
}

function looksLikeCredential(value: string): boolean {
  const trimmed = value.trim();
  return (
    isServerCredential(trimmed) ||
    /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed) ||
    trimmed.includes("BEGIN PRIVATE KEY")
  );
}

/**
 * credentialStore.ts's own schema: version 1, a `servers` map of `oauth` or `token`
 * credentials. Unlike `cmpatch`'s check, no `kind`-less OAuth credential is accepted:
 * this CLI's store has never held one.
 */
function validateCredentialStoreFile(
  value: unknown,
): { ok: true; serverCount: number } | { error: string; ok: false } {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.servers)) {
    return { error: "expected version 1 with a servers object", ok: false };
  }
  for (const [serverUrl, credential] of Object.entries(value.servers)) {
    if (!isStoredCredential(credential)) {
      return { error: `credential for ${serverUrl} does not match the expected schema`, ok: false };
    }
  }
  return { ok: true, serverCount: Object.keys(value.servers).length };
}

function isStoredCredential(value: unknown): boolean {
  if (!isRecord(value) || typeof value.accessToken !== "string" || !isStoredUser(value.user)) return false;
  if (value.kind === "token") return true;
  return (
    value.kind === "oauth" &&
    typeof value.accessTokenExpiresAt === "string" &&
    typeof value.refreshToken === "string" &&
    typeof value.refreshTokenExpiresAt === "string"
  );
}

function isStoredUser(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.email === "string" &&
    typeof value.id === "string" &&
    (typeof value.displayName === "string" || value.displayName === null)
  );
}

function isNamedResource(value: unknown): value is NamedResource {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function resolveOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function redactValue(value: string): string {
  return value.length <= 8 ? "<redacted>" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function countChecks(checks: DoctorCheckResult[], status: DoctorCheckStatus): number {
  return checks.filter((check) => check.status === status).length;
}

function capitalize(value: string): string {
  return value[0]!.toUpperCase() + value.slice(1);
}

function formatErrorSuffix(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? " (source could not be read or parsed)" : "";
}

function isNodeError(error: unknown): error is { code: unknown } {
  return typeof error === "object" && error !== null && "code" in error;
}
