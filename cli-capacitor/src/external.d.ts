// Types for the untyped packages doctor's discovery bundles (tech spec §8): the same
// shapes cli/src/external.d.ts declares for `cmpatch`, limited to what this CLI calls.

declare module "plist" {
  export function parse(xml: string): unknown;
}

declare module "xcode/lib/parser/pbxproj" {
  export function parse(text: string): unknown;
}
