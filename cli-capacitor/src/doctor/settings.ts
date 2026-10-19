// The SDK settings doctor resolves per platform, and how one value is judged.
//
// Names and precedence are the SDK's (client-capacitor ADR-0003, CodemagicPatchConfig.kt
// and CodemagicPatchConfig.swift): `plugins.CodemagicPatch.<platform>.<setting>` in the
// Capacitor config, overridden by the `CodemagicPatch*` string resource (Android) or
// Info.plist key (iOS). The judgement of a URL or deployment key is `settings` in
// cli/src/doctor/discovery.ts (@codemagic/patch-cli 0.6.0); `publicKey` and
// `maxLaunchAttempts` are this SDK's own and follow what its native readers accept.

import { createPublicKey } from "node:crypto";

import { isServerCredential } from "../api";
import type { Resolution } from "./sources";

export type SettingName = "apiUrl" | "downloadBaseUrl" | "deploymentKey" | "publicKey" | "maxLaunchAttempts";

/** Native override keys, by setting — `cmpatch`'s `FIELDS` plus this SDK's two optional ones. */
export const NATIVE_FIELDS: Record<SettingName, string> = {
  apiUrl: "CodemagicPatchApiUrl",
  downloadBaseUrl: "CodemagicPatchDownloadBaseUrl",
  deploymentKey: "CodemagicPatchDeploymentKey",
  publicKey: "CodemagicPatchPublicKey",
  maxLaunchAttempts: "CodemagicPatchMaxLaunchAttempts",
};

/** The three the SDK refuses to start without; the other two have defaults. */
export const REQUIRED_SETTINGS: readonly SettingName[] = ["apiUrl", "downloadBaseUrl", "deploymentKey"];

/** Largest launch-attempt budget both native readers accept (Int32), as checkMaxLaunchAttempts.ts. */
export const MAX_LAUNCH_ATTEMPTS_LIMIT = 2147483647;

/** A native override as read from the project, before it is judged. */
export type OverrideEvidence = {
  field: string;
  reason?: string;
  source: string;
  state: Resolution;
  value?: unknown;
};

export type NativeOverrides = {
  /** Android: every override is known, and only the final Gradle build is unevaluated. */
  buildInfo: boolean;
  /** A `CodemagicPatch*` key exists in the app's resources: OTA intent. */
  intent: boolean;
  present: boolean;
  source: string;
  /** Something about the build makes the effective values uncertain. */
  uncertain: boolean;
  values: Record<SettingName, OverrideEvidence>;
};

/** Overrides all in one state: their source is absent, or unknown as a whole. */
export function uniformOverrides(state: "missing" | "unresolved", reason: string, source: string): NativeOverrides {
  return {
    buildInfo: false,
    intent: false,
    present: state === "unresolved",
    source,
    uncertain: state === "unresolved",
    values: Object.fromEntries(
      Object.entries(NATIVE_FIELDS).map(([name, field]) => [name, { field, reason, source, state }]),
    ) as NativeOverrides["values"],
  };
}

/**
 * One override value as the SDK reads it: trimmed, and blank treated as absent
 * (`cleanConfigValue` on Android, `nilIfEmpty` on iOS). A resource reference
 * (`@string/x`) or a placeholder is resolved by the build, so it stays unresolved.
 */
export function overrideValue(raw: unknown, field: string, source: string): OverrideEvidence {
  if (typeof raw === "number" || typeof raw === "boolean") return { field, source, state: "resolved", value: raw };
  if (typeof raw !== "string") return { field, reason: "invalid_setting", source, state: "invalid" };
  const value = raw.trim();
  if (value === "") return { field, reason: "blank_override", source, state: "missing" };
  if (/\$\(|\$\{|^@/.test(value)) return { field, reason: "build_time_value", source, state: "unresolved" };
  return { field, source, state: "resolved", value };
}

/** The app's version as read from its native project, or why it could not be. */
export type DetectedVersion = { source: string; state: "resolved"; version: string } | { detail: string; state: "unresolved" };

/** Where an effective value came from, in the SDK's order of precedence. */
export type SettingOrigin = "native-override" | "synced-config" | "source-config";

/**
 * One effective setting. `value` is internal evidence only: deployment keys and URLs are
 * compared and probed, never serialized as they are.
 */
export type Evidence = {
  field: string;
  origin?: SettingOrigin;
  reason?: string;
  source: string;
  state: Resolution;
  value?: string;
};

export type SdkSettings = Record<SettingName, Evidence>;

/**
 * Judges a value that was found. Strings are trimmed first, as both native readers do.
 * `missing` is never returned here: absence is decided by the caller, which knows
 * whether a lower-precedence source applies.
 */
export function judgeSetting(name: SettingName, raw: unknown): { reason?: string; state: Resolution; value?: string } {
  if (name === "maxLaunchAttempts") {
    const parsed = typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : raw;
    return typeof parsed === "number" && Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LAUNCH_ATTEMPTS_LIMIT
      ? { state: "resolved", value: String(parsed) }
      : { reason: "invalid_setting", state: "invalid" };
  }
  if (typeof raw !== "string" || raw.trim() === "") return { reason: "invalid_setting", state: "invalid" };
  const value = raw.trim();
  if (/\$\(|\$\{|^@/.test(value)) return { reason: "build_time_value", state: "unresolved" };
  if (name === "deploymentKey") {
    // Any token the server issues (OAuth ones included, unlike cmpatch), a JWT or a key.
    return isServerCredential(value) || /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$|BEGIN .*PRIVATE KEY/.test(value)
      ? { reason: "credential_in_deployment_key", state: "invalid" }
      : { state: "resolved", value };
  }
  if (name === "publicKey") {
    if (/PRIVATE KEY/.test(value)) return { reason: "private_key", state: "invalid" };
    return isRsaPublicKey(value) ? { state: "resolved", value } : { reason: "invalid_public_key", state: "invalid" };
  }
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("invalid URL");
  } catch {
    return { reason: "invalid_url", state: "invalid" };
  }
  return { state: "resolved", value };
}

/**
 * Whether the SDK can verify signatures with this key. Both native verifiers
 * (CodemagicPatchUtil.kt and .swift) strip the PEM armour and whitespace, decode the
 * base64 and import it as an RSA SubjectPublicKeyInfo; a `\n` escape in strings.xml is a
 * newline once the app is built.
 */
function isRsaPublicKey(pem: string): boolean {
  const body = pem
    .replace("-----BEGIN PUBLIC KEY-----", "")
    .replace("-----END PUBLIC KEY-----", "")
    .replace(/\\n|\s/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) return false;
  try {
    return createPublicKey({ format: "der", key: Buffer.from(body, "base64"), type: "spki" }).asymmetricKeyType === "rsa";
  } catch {
    return false;
  }
}
