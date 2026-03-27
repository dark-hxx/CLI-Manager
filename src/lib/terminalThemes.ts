import type { ITheme } from "@xterm/xterm";

export interface TerminalThemePreset {
  id: string;
  name: string;
  theme: ITheme;
  family?: string;
  tone?: "light" | "dark";
}

export type LightTerminalPalette = "warm-paper" | "cream-green" | "ink-red";
export type DarkTerminalPalette = "night-indigo" | "forest-night" | "graphite-red";

const tokyoNightDark: ITheme = {
  background: "#1a1b26",
  foreground: "#c0caf5",
  cursor: "#c0caf5",
  selectionBackground: "#364a82",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

const tokyoNightLight: ITheme = {
  background: "#f5f5f5",
  foreground: "#343b58",
  cursor: "#343b58",
  selectionBackground: "#b4c0e0",
  black: "#0f0f14",
  red: "#8c4351",
  green: "#485e30",
  yellow: "#8f5e15",
  blue: "#34548a",
  magenta: "#5a4a78",
  cyan: "#0f4b6e",
  white: "#343b58",
  brightBlack: "#9699a3",
  brightRed: "#8c4351",
  brightGreen: "#485e30",
  brightYellow: "#8f5e15",
  brightBlue: "#34548a",
  brightMagenta: "#5a4a78",
  brightCyan: "#0f4b6e",
  brightWhite: "#343b58",
};

const forestNightDark: ITheme = {
  background: "#111714",
  foreground: "#d8e5dc",
  cursor: "#d8e5dc",
  selectionBackground: "#2a3a31",
  black: "#0d1410",
  red: "#dc6e74",
  green: "#6bc28f",
  yellow: "#d8b15f",
  blue: "#6ea88f",
  magenta: "#7c9b84",
  cyan: "#66a79a",
  white: "#c8d8ce",
  brightBlack: "#4b5f55",
  brightRed: "#e6848a",
  brightGreen: "#7dd0a0",
  brightYellow: "#e2be74",
  brightBlue: "#81b8a2",
  brightMagenta: "#8eab96",
  brightCyan: "#79b8aa",
  brightWhite: "#e6efe9",
};

const graphiteRedDark: ITheme = {
  background: "#171616",
  foreground: "#e6dfdb",
  cursor: "#e6dfdb",
  selectionBackground: "#3a3232",
  black: "#121111",
  red: "#e06a6a",
  green: "#64b487",
  yellow: "#d3a053",
  blue: "#b48a77",
  magenta: "#c08a7a",
  cyan: "#8ea091",
  white: "#d2c8c3",
  brightBlack: "#5b4f4f",
  brightRed: "#e97f7f",
  brightGreen: "#79c49a",
  brightYellow: "#ddb168",
  brightBlue: "#c09a89",
  brightMagenta: "#ca9b8e",
  brightCyan: "#9db0a3",
  brightWhite: "#f1eae6",
};

const warmPaperLight: ITheme = {
  background: "#fffdf8",
  foreground: "#3a3126",
  cursor: "#5b4f41",
  selectionBackground: "#e7dcc8",
  black: "#2d261d",
  red: "#c84a4a",
  green: "#2f8f62",
  yellow: "#b8842a",
  blue: "#8b6b45",
  magenta: "#a35b3a",
  cyan: "#6f7b57",
  white: "#6f6252",
  brightBlack: "#8a7b6a",
  brightRed: "#d66161",
  brightGreen: "#3ea574",
  brightYellow: "#c9973e",
  brightBlue: "#9b7a53",
  brightMagenta: "#b86a46",
  brightCyan: "#7f8e66",
  brightWhite: "#2d261d",
};

const creamGreenLight: ITheme = {
  background: "#fdfdf9",
  foreground: "#223224",
  cursor: "#3f5141",
  selectionBackground: "#dce5d8",
  black: "#1f2a20",
  red: "#b84b4b",
  green: "#2d8a5f",
  yellow: "#a77d2f",
  blue: "#3f7a4f",
  magenta: "#5a6a3f",
  cyan: "#3e6f63",
  white: "#54645a",
  brightBlack: "#6e7f70",
  brightRed: "#c76060",
  brightGreen: "#43a174",
  brightYellow: "#b88d41",
  brightBlue: "#4f8d60",
  brightMagenta: "#6e7f4d",
  brightCyan: "#4f8276",
  brightWhite: "#1f2a20",
};

const inkRedLight: ITheme = {
  background: "#ffffff",
  foreground: "#2a2722",
  cursor: "#494943",
  selectionBackground: "#ebe7df",
  black: "#1f1f1c",
  red: "#b63a3a",
  green: "#2b8a5a",
  yellow: "#b07a22",
  blue: "#7a5140",
  magenta: "#8a4a40",
  cyan: "#5f6d55",
  white: "#59564e",
  brightBlack: "#7b7b72",
  brightRed: "#c74a4a",
  brightGreen: "#3ea070",
  brightYellow: "#c08d35",
  brightBlue: "#8c604d",
  brightMagenta: "#9b5a4e",
  brightCyan: "#738266",
  brightWhite: "#1f1f1c",
};

const dracula: ITheme = {
  background: "#282a36",
  foreground: "#f8f8f2",
  cursor: "#f8f8f2",
  selectionBackground: "#44475a",
  black: "#21222c",
  red: "#ff5555",
  green: "#50fa7b",
  yellow: "#f1fa8c",
  blue: "#bd93f9",
  magenta: "#ff79c6",
  cyan: "#8be9fd",
  white: "#f8f8f2",
  brightBlack: "#6272a4",
  brightRed: "#ff6e6e",
  brightGreen: "#69ff94",
  brightYellow: "#ffffa5",
  brightBlue: "#d6acff",
  brightMagenta: "#ff92df",
  brightCyan: "#a4ffff",
  brightWhite: "#ffffff",
};

const monokai: ITheme = {
  background: "#272822",
  foreground: "#f8f8f2",
  cursor: "#f8f8f0",
  selectionBackground: "#49483e",
  black: "#272822",
  red: "#f92672",
  green: "#a6e22e",
  yellow: "#f4bf75",
  blue: "#66d9ef",
  magenta: "#ae81ff",
  cyan: "#a1efe4",
  white: "#f8f8f2",
  brightBlack: "#75715e",
  brightRed: "#f92672",
  brightGreen: "#a6e22e",
  brightYellow: "#f4bf75",
  brightBlue: "#66d9ef",
  brightMagenta: "#ae81ff",
  brightCyan: "#a1efe4",
  brightWhite: "#f9f8f5",
};

const nord: ITheme = {
  background: "#2e3440",
  foreground: "#d8dee9",
  cursor: "#d8dee9",
  selectionBackground: "#434c5e",
  black: "#3b4252",
  red: "#bf616a",
  green: "#a3be8c",
  yellow: "#ebcb8b",
  blue: "#81a1c1",
  magenta: "#b48ead",
  cyan: "#88c0d0",
  white: "#e5e9f0",
  brightBlack: "#4c566a",
  brightRed: "#bf616a",
  brightGreen: "#a3be8c",
  brightYellow: "#ebcb8b",
  brightBlue: "#81a1c1",
  brightMagenta: "#b48ead",
  brightCyan: "#8fbcbb",
  brightWhite: "#eceff4",
};

const solarizedDark: ITheme = {
  background: "#002b36",
  foreground: "#839496",
  cursor: "#839496",
  selectionBackground: "#073642",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const solarizedLight: ITheme = {
  background: "#fdf6e3",
  foreground: "#657b83",
  cursor: "#657b83",
  selectionBackground: "#eee8d5",
  black: "#073642",
  red: "#dc322f",
  green: "#859900",
  yellow: "#b58900",
  blue: "#268bd2",
  magenta: "#d33682",
  cyan: "#2aa198",
  white: "#eee8d5",
  brightBlack: "#586e75",
  brightRed: "#cb4b16",
  brightGreen: "#586e75",
  brightYellow: "#657b83",
  brightBlue: "#839496",
  brightMagenta: "#6c71c4",
  brightCyan: "#93a1a1",
  brightWhite: "#fdf6e3",
};

const oneDark: ITheme = {
  background: "#282c34",
  foreground: "#abb2bf",
  cursor: "#528bff",
  selectionBackground: "#3e4451",
  black: "#282c34",
  red: "#e06c75",
  green: "#98c379",
  yellow: "#e5c07b",
  blue: "#61afef",
  magenta: "#c678dd",
  cyan: "#56b6c2",
  white: "#abb2bf",
  brightBlack: "#5c6370",
  brightRed: "#e06c75",
  brightGreen: "#98c379",
  brightYellow: "#e5c07b",
  brightBlue: "#61afef",
  brightMagenta: "#c678dd",
  brightCyan: "#56b6c2",
  brightWhite: "#ffffff",
};

const githubDark: ITheme = {
  background: "#24292e",
  foreground: "#e1e4e8",
  cursor: "#c8e1ff",
  selectionBackground: "#444d56",
  black: "#586069",
  red: "#ea4a5a",
  green: "#34d058",
  yellow: "#ffea7f",
  blue: "#2188ff",
  magenta: "#b392f0",
  cyan: "#39c5cf",
  white: "#d1d5da",
  brightBlack: "#959da5",
  brightRed: "#f97583",
  brightGreen: "#85e89d",
  brightYellow: "#ffea7f",
  brightBlue: "#79b8ff",
  brightMagenta: "#b392f0",
  brightCyan: "#56d4dd",
  brightWhite: "#fafbfc",
};

const githubLight: ITheme = {
  background: "#ffffff",
  foreground: "#24292e",
  cursor: "#044289",
  selectionBackground: "#c8c8fa",
  black: "#24292e",
  red: "#d73a49",
  green: "#22863a",
  yellow: "#e36209",
  blue: "#005cc5",
  magenta: "#6f42c1",
  cyan: "#032f62",
  white: "#6a737d",
  brightBlack: "#959da5",
  brightRed: "#cb2431",
  brightGreen: "#28a745",
  brightYellow: "#b08800",
  brightBlue: "#2188ff",
  brightMagenta: "#8a63d2",
  brightCyan: "#3192aa",
  brightWhite: "#d1d5da",
};

export const TERMINAL_THEME_PRESETS: TerminalThemePreset[] = [
  { id: "tokyoNightDark", name: "Tokyo Night Dark", theme: tokyoNightDark, family: "tokyo-night", tone: "dark" },
  { id: "tokyoNightLight", name: "Tokyo Night Light", theme: tokyoNightLight, family: "tokyo-night", tone: "light" },
  { id: "forestNightDark", name: "Forest Night Dark", theme: forestNightDark, family: "atelier", tone: "dark" },
  { id: "graphiteRedDark", name: "Graphite Red Dark", theme: graphiteRedDark, family: "atelier", tone: "dark" },
  { id: "warmPaperLight", name: "Warm Paper Light", theme: warmPaperLight, family: "atelier", tone: "light" },
  { id: "creamGreenLight", name: "Cream Green Light", theme: creamGreenLight, family: "atelier", tone: "light" },
  { id: "inkRedLight", name: "Ink Red Light", theme: inkRedLight, family: "atelier", tone: "light" },
  { id: "dracula", name: "Dracula", theme: dracula, family: "classic", tone: "dark" },
  { id: "monokai", name: "Monokai", theme: monokai, family: "classic", tone: "dark" },
  { id: "nord", name: "Nord", theme: nord, family: "nord", tone: "dark" },
  { id: "solarizedDark", name: "Solarized Dark", theme: solarizedDark, family: "solarized", tone: "dark" },
  { id: "solarizedLight", name: "Solarized Light", theme: solarizedLight, family: "solarized", tone: "light" },
  { id: "oneDark", name: "One Dark", theme: oneDark, family: "one-dark", tone: "dark" },
  { id: "githubDark", name: "GitHub Dark", theme: githubDark, family: "github", tone: "dark" },
  { id: "githubLight", name: "GitHub Light", theme: githubLight, family: "github", tone: "light" },
];

const themeMap = new Map(TERMINAL_THEME_PRESETS.map((p) => [p.id, p.theme]));

function resolveAutoLightThemeId(lightPalette: LightTerminalPalette = "warm-paper"): string {
  if (lightPalette === "cream-green") return "creamGreenLight";
  if (lightPalette === "ink-red") return "inkRedLight";
  return "warmPaperLight";
}

function resolveAutoDarkThemeId(darkPalette: DarkTerminalPalette = "night-indigo"): string {
  if (darkPalette === "forest-night") return "forestNightDark";
  if (darkPalette === "graphite-red") return "graphiteRedDark";
  return "tokyoNightDark";
}

function resolveAutoLightTheme(lightPalette: LightTerminalPalette = "warm-paper"): ITheme {
  return themeMap.get(resolveAutoLightThemeId(lightPalette)) ?? warmPaperLight;
}

function resolveAutoDarkTheme(darkPalette: DarkTerminalPalette = "night-indigo"): ITheme {
  return themeMap.get(resolveAutoDarkThemeId(darkPalette)) ?? tokyoNightDark;
}

export function resolveAutoTerminalThemeId(
  resolvedTheme: "dark" | "light",
  lightPalette: LightTerminalPalette = "warm-paper",
  darkPalette: DarkTerminalPalette = "night-indigo"
): string {
  return resolvedTheme === "dark" ? resolveAutoDarkThemeId(darkPalette) : resolveAutoLightThemeId(lightPalette);
}

/**
 * Resolve a terminal theme by name.
 * - "auto" → pick based on app resolvedTheme (dark → tokyoNightDark, light → selected light palette)
 * - other → lookup by ID, fallback to auto behavior
 */
export function getTerminalTheme(
  themeName: string,
  resolvedTheme: "dark" | "light",
  lightPalette: LightTerminalPalette = "warm-paper",
  darkPalette: DarkTerminalPalette = "night-indigo"
): ITheme {
  if (themeName === "auto") {
    return resolvedTheme === "dark" ? resolveAutoDarkTheme(darkPalette) : resolveAutoLightTheme(lightPalette);
  }
  return themeMap.get(themeName) ?? (resolvedTheme === "dark" ? resolveAutoDarkTheme(darkPalette) : resolveAutoLightTheme(lightPalette));
}

export function getTerminalBackground(
  themeName: string,
  resolvedTheme: "dark" | "light",
  lightPalette: LightTerminalPalette = "warm-paper",
  darkPalette: DarkTerminalPalette = "night-indigo"
): string {
  return getTerminalTheme(themeName, resolvedTheme, lightPalette, darkPalette).background!;
}
