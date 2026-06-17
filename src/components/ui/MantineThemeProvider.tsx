import { MantineProvider, createTheme, type MantineColorsTuple } from "@mantine/core";
import { useMemo, type ReactNode } from "react";
import {
  useSettingsStore,
  type DarkThemePalette,
  type LightThemePalette,
} from "../../stores/settingsStore";

const LIGHT_PRIMARY_COLORS: Record<LightThemePalette, string> = {
  "warm-paper": "#c46a2d",
  "cream-green": "#3f7a4f",
  "ink-red": "#c43d2f",
  "emerald-mist": "#039d74",
  "saas-analytics-dashboard": "#3b82f6",
  "apple-pure": "#007aff",
  "apple-mist": "#0a84ff",
  "apple-warm": "#ff9f0a",
  "apple-mono": "#3a3a3c",
};

const DARK_PRIMARY_COLORS: Record<DarkThemePalette, string> = {
  "night-indigo": "#7aa2f7",
  "forest-night": "#52a36e",
  "graphite-red": "#c95b4a",
  "investment-platform": "#f59e0b",
  "github-dark": "#58a6ff",
  "catppuccin-mocha": "#89b4fa",
  "terminal-green": "#3dd68c",
  "dracula-purple": "#bd93f9",
  "carbon-black": "#78a9ff",
};

interface AppMantineThemeProviderProps {
  children: ReactNode;
}

function mixHex(hex: string, target: string, ratio: number): string {
  const parse = (value: string) => {
    const normalized = value.replace("#", "");
    return [0, 2, 4].map((i) => parseInt(normalized.slice(i, i + 2), 16));
  };
  const [r1, g1, b1] = parse(hex);
  const [r2, g2, b2] = parse(target);
  const mix = (a: number, b: number) => Math.round(a + (b - a) * ratio);
  return `#${[mix(r1, r2), mix(g1, g2), mix(b1, b2)]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

// Mantine 的 light/subtle 变体依赖完整色阶（浅色背景取 1、文字取 9）。
// 基色放在索引 6，配合 primaryShade=6 保证 filled 变体仍是用户选择的主色。
function buildPrimaryShades(base: string): MantineColorsTuple {
  const WHITE_MIX = [0.93, 0.85, 0.75, 0.6, 0.4, 0.2];
  const BLACK_MIX = [0.12, 0.24, 0.38];
  return [
    ...WHITE_MIX.map((ratio) => mixHex(base, "#ffffff", ratio)),
    base,
    ...BLACK_MIX.map((ratio) => mixHex(base, "#000000", ratio)),
  ] as unknown as MantineColorsTuple;
}

export function AppMantineThemeProvider({ children }: AppMantineThemeProviderProps) {
  const resolvedTheme = useSettingsStore((s) => s.resolvedTheme);
  const lightThemePalette = useSettingsStore((s) => s.lightThemePalette);
  const darkThemePalette = useSettingsStore((s) => s.darkThemePalette);
  const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
  const uiFontSize = useSettingsStore((s) => s.uiFontSize);
  const primaryColor =
    resolvedTheme === "dark" ? DARK_PRIMARY_COLORS[darkThemePalette] : LIGHT_PRIMARY_COLORS[lightThemePalette];

  const mantineTheme = useMemo(() => {
    const metaSize = Math.max(9, uiFontSize - 1);
    return createTheme({
      colors: {
        cliPrimary: buildPrimaryShades(primaryColor),
      },
      primaryColor: "cliPrimary",
      primaryShade: 6,
      fontFamily: uiFontFamily,
      fontFamilyMonospace: uiFontFamily,
      fontSizes: {
        xs: `${metaSize}px`,
        sm: `${uiFontSize + 1}px`,
        md: `${uiFontSize + 3}px`,
        lg: `${uiFontSize + 5}px`,
        xl: `${uiFontSize + 7}px`,
      },
      headings: {
        fontFamily: uiFontFamily,
      },
      defaultRadius: "md",
    });
  }, [primaryColor, uiFontFamily, uiFontSize]);

  return (
    <MantineProvider theme={mantineTheme} defaultColorScheme={resolvedTheme} forceColorScheme={resolvedTheme}>
      {children}
    </MantineProvider>
  );
}
