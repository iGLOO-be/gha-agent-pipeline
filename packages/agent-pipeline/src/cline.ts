let sdkPromise: Promise<typeof import("@cline/sdk")> | undefined;

export function loadClineSdk() {
  sdkPromise ??= import("@cline/sdk");
  return sdkPromise;
}
