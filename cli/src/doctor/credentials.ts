// The server issues personal access tokens (server/src/app/apiToken.ts) and OAuth access
// and refresh tokens (server/src/app/oauthToken.ts). Doctor must never place any of them
// in a public URL or print them.
export const SERVER_CREDENTIAL_PREFIXES = ["cm_pat_", "cm_oat_", "cm_ort_"] as const;

/** Whether `value` is a token the server issued (see SERVER_CREDENTIAL_PREFIXES). */
export function isServerCredential(value: string): boolean {
  const trimmed = value.trim();
  return SERVER_CREDENTIAL_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

/** Whether a server-issued token appears anywhere in `value`. */
export function containsServerCredential(value: string): boolean {
  return SERVER_CREDENTIAL_PREFIXES.some((prefix) => value.includes(prefix));
}

/** Every server-issued token in a text, for redaction. */
export const SERVER_CREDENTIAL_PATTERN = /cm_(?:pat|oat|ort)_[A-Za-z0-9_-]+/g;
