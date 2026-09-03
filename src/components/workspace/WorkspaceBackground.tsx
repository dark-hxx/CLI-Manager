import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { backgroundAssetUrl } from "../../lib/assetUrl";
import {
  getTerminalBackgroundOverlayColor,
  getTerminalTheme,
} from "../../lib/terminalThemes";
import { useSettingsStore } from "../../stores/settingsStore";

interface WorkspaceBackgroundContextValue {
  requested: boolean;
  active: boolean;
  assetUrl: string | null;
}

const WorkspaceBackgroundContext = createContext<WorkspaceBackgroundContextValue>({
  requested: false,
  active: false,
  assetUrl: null,
});

export function useWorkspaceBackground(): WorkspaceBackgroundContextValue {
  return useContext(WorkspaceBackgroundContext);
}

interface WorkspaceBackgroundProps {
  children: ReactNode;
}

export function WorkspaceBackground({ children }: WorkspaceBackgroundProps) {
  const background = useSettingsStore((state) => state.terminalBackground);
  const terminalBackgroundMissing = useSettingsStore((state) => state.terminalBackgroundMissing);
  const resolvedTheme = useSettingsStore((state) => state.resolvedTheme);
  const lightThemePalette = useSettingsStore((state) => state.lightThemePalette);
  const darkThemePalette = useSettingsStore((state) => state.darkThemePalette);
  const terminalThemeName = useSettingsStore((state) => state.terminalThemeName);
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  const backgroundRequested = Boolean(
    background.enabled
      && background.fillWorkspace
      && background.imagePath
      && !terminalBackgroundMissing,
  );

  useEffect(() => {
    let cancelled = false;
    setAssetUrl(null);
    if (!backgroundRequested || !background.imagePath) {
      return () => {
        cancelled = true;
      };
    }

    void backgroundAssetUrl(background.imagePath).then((url) => {
      if (!cancelled) setAssetUrl(url);
    });

    return () => {
      cancelled = true;
    };
  }, [background.imagePath, backgroundRequested]);

  const terminalTheme = useMemo(
    () => getTerminalTheme(terminalThemeName, resolvedTheme, lightThemePalette, darkThemePalette),
    [darkThemePalette, lightThemePalette, resolvedTheme, terminalThemeName],
  );
  const layerVisible = backgroundRequested && assetUrl !== null;
  const contextValue = useMemo(
    () => ({
      requested: backgroundRequested,
      active: layerVisible,
      assetUrl: layerVisible ? assetUrl : null,
    }),
    [assetUrl, backgroundRequested, layerVisible],
  );
  const layerStyle = layerVisible
    ? ({
        "--workspace-bg-image": `url("${assetUrl}")`,
        "--workspace-bg-opacity": (background.opacity / 100).toString(),
        "--workspace-bg-blur": `${background.blur}px`,
        "--workspace-bg-darken": (background.overlayDarken / 100).toString(),
        "--workspace-bg-overlay-color": getTerminalBackgroundOverlayColor(terminalTheme),
      } as CSSProperties)
    : undefined;

  return (
    <WorkspaceBackgroundContext.Provider value={contextValue}>
      <div
        className="ui-workspace-background-root relative h-full min-h-0"
        data-workspace-background={layerVisible ? "true" : undefined}
      >
        {layerVisible && (
          <div
            className="ui-workspace-background-layer absolute inset-0"
            style={layerStyle}
            data-workspace-bg-fit={background.fit}
            data-workspace-bg-position={background.position}
            aria-hidden="true"
          />
        )}
        <div className="ui-workspace-background-content relative z-[1] h-full min-h-0">
          {children}
        </div>
      </div>
    </WorkspaceBackgroundContext.Provider>
  );
}
