/**
 * Jest setup for projects using @codemagic/react-native-patch.
 *
 * Add it to your Jest config:
 *
 *   setupFiles: ['@codemagic/react-native-patch/jest-setup']
 *
 * The SDK resolves its TurboModule at module scope with
 * `TurboModuleRegistry.getEnforcing`, which is deliberate: a missing native
 * module should fail loudly at app boot rather than degrade into runtime
 * errors at the first SDK call. Under Jest there is no native binary, so that
 * same throw stops the suite before any test runs. This file registers a stub
 * for `NativeCodemagicPatch` so the JS runtime is loadable, and leaves every
 * other TurboModule untouched.
 *
 * The stub is for loadability, not behaviour. To drive OTA state in a test,
 * seed the in-memory runtime with `@codemagic/react-native-patch/testing`, or
 * override individual methods with `jest.spyOn`.
 */
jest.mock("react-native/Libraries/TurboModule/TurboModuleRegistry", () => {
  const actual = jest.requireActual(
    "react-native/Libraries/TurboModule/TurboModuleRegistry",
  );

  // Defined inside the factory: jest.mock is hoisted above imports, so a
  // module-scope binding would not exist yet when this runs.
  const stub = {
    // Mirrors NativeBootState for a device running the store binary.
    getBootState: jest.fn(async () => ({
      bootSource: "embedded",
      runningPackageHash: null,
      confirmedPackageHash: null,
      pendingPackageHash: null,
      previousPackageHash: null,
      failedInstall: null,
    })),
    fetchManifest: jest.fn(async () => null),
    getDeviceId: jest.fn(async () => "jest-device"),
    getPackageMetadata: jest.fn(async () => null),

    enqueueMetricEvent: jest.fn(async () => undefined),

    downloadUpdate: jest.fn(async () => undefined),
    installUpdate: jest.fn(async () => undefined),
    confirmPendingUpdate: jest.fn(async () => undefined),
    stageEmbeddedRevert: jest.fn(async () => undefined),
    clearUpdatesForTests: jest.fn(async () => undefined),
    reloadBundle: jest.fn(async () => undefined),

    verifyJwtSignature: jest.fn(async () => true),
  };

  return {
    ...actual,
    get: (name) => (name === "NativeCodemagicPatch" ? stub : actual.get(name)),
    getEnforcing: (name) =>
      name === "NativeCodemagicPatch" ? stub : actual.getEnforcing(name),
  };
});
