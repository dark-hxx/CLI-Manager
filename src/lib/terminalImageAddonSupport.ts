const MINIMAL_WASM_MODULE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d,
  0x01, 0x00, 0x00, 0x00,
]);

let cachedWasmSupport: boolean | null = null;

export const canUseTerminalImageAddonWasm = (): boolean => {
  if (cachedWasmSupport !== null) return cachedWasmSupport;

  try {
    if (typeof WebAssembly === "undefined" || typeof WebAssembly.Module !== "function") {
      cachedWasmSupport = false;
      return cachedWasmSupport;
    }
    // Constructing a module exercises the same CSP gate used by addon-image.
    new WebAssembly.Module(MINIMAL_WASM_MODULE);
    cachedWasmSupport = true;
  } catch {
    cachedWasmSupport = false;
  }

  return cachedWasmSupport;
};
