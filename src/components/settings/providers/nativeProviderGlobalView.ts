import type { NativeProviderGlobalPreview } from "./nativeProviderTypes";

export function providerGlobalTargetRoot(preview: NativeProviderGlobalPreview): string {
  switch (preview.appType) {
    case "claude":
      return preview.home.targets.claudeConfigDir;
    case "codex":
      return preview.home.targets.codexConfigDir;
    case "grokbuild":
      return preview.home.targets.grokConfigDir;
  }
}
