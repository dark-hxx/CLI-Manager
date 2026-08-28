// Pure color helpers for the terminal renderer: hex validation, rgba conversion,
// relative luminance, and xterm cell background resolution. No xterm runtime dependency.
import type { ITheme } from "@xterm/xterm";

export type TerminalRgbColor = readonly [number, number, number];

const SHORT_OR_LONG_HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

const XTERM_CELL_COLOR_MODE_MASK = 0x03000000;
const XTERM_CELL_COLOR_MODE_PALETTE_16 = 0x01000000;
const XTERM_CELL_COLOR_MODE_PALETTE_256 = 0x02000000;
const XTERM_CELL_COLOR_MODE_RGB = 0x03000000;
const XTERM_CELL_PALETTE_INDEX_MASK = 0x000000ff;
const XTERM_CELL_RGB_MASK = 0x00ffffff;

// xterm.js default ANSI palette, used when the active theme omits an entry.
const DEFAULT_ANSI_HEX_COLORS = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
] as const;

const ANSI_THEME_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const satisfies readonly (keyof ITheme)[];

const XTERM_COLOR_CUBE_STEPS = [0, 95, 135, 175, 215, 255] as const;
const XTERM_COLOR_CUBE_START_INDEX = 16;
const XTERM_GRAYSCALE_RAMP_START_INDEX = 232;

// A "dark block" is a background that a dark-theme CLI paints and that reads as an
// opaque black bar on a light terminal: dark enough to swallow the theme background,
// and neutral enough that it cannot be a deliberate colored badge or diff marker.
const DARK_BLOCK_MAX_RELATIVE_LUMINANCE = 0.28;
const DARK_BLOCK_MAX_CHROMA = 96;

export const normalizeHexColor = (value: string | undefined, fallback: string) => (
  value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback
);

export const hexToRgba = (value: string | undefined, alpha: number, fallback: string) => {
  const normalized = normalizeHexColor(value, "");
  if (!normalized) return fallback;
  const hex = normalized.slice(1);
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
};

export const hexToRgb = (value: string | undefined): TerminalRgbColor | null => {
  if (!value || !SHORT_OR_LONG_HEX_PATTERN.test(value)) return null;
  const hex = value.length === 4
    ? value.slice(1).replace(/./g, (channel) => `${channel}${channel}`)
    : value.slice(1);
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
};

export const getRelativeLuminance = ([r, g, b]: TerminalRgbColor): number => {
  const [srgbR, srgbG, srgbB] = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * srgbR + 0.7152 * srgbG + 0.0722 * srgbB;
};

export const resolveXtermPaletteRgb = (
  index: number,
  theme: ITheme | undefined,
): TerminalRgbColor | null => {
  if (!Number.isInteger(index) || index < 0 || index > 255) return null;
  if (index < ANSI_THEME_KEYS.length) {
    return hexToRgb(theme?.[ANSI_THEME_KEYS[index]]) ?? hexToRgb(DEFAULT_ANSI_HEX_COLORS[index]);
  }
  if (index >= XTERM_GRAYSCALE_RAMP_START_INDEX) {
    const level = 8 + (index - XTERM_GRAYSCALE_RAMP_START_INDEX) * 10;
    return [level, level, level];
  }
  const cubeIndex = index - XTERM_COLOR_CUBE_START_INDEX;
  return [
    XTERM_COLOR_CUBE_STEPS[Math.floor(cubeIndex / 36) % 6],
    XTERM_COLOR_CUBE_STEPS[Math.floor(cubeIndex / 6) % 6],
    XTERM_COLOR_CUBE_STEPS[cubeIndex % 6],
  ];
};

// Resolves what xterm actually paints for a cell background attribute. Cells that keep
// the default background return null: the terminal theme owns those, never a CLI.
export const resolveXtermCellBackgroundRgb = (
  backgroundAttribute: number,
  theme: ITheme | undefined,
): TerminalRgbColor | null => {
  const colorMode = backgroundAttribute & XTERM_CELL_COLOR_MODE_MASK;
  if (colorMode === XTERM_CELL_COLOR_MODE_RGB) {
    const rgb = backgroundAttribute & XTERM_CELL_RGB_MASK;
    return [(rgb >>> 16) & 0xff, (rgb >>> 8) & 0xff, rgb & 0xff];
  }
  if (
    colorMode === XTERM_CELL_COLOR_MODE_PALETTE_16
    || colorMode === XTERM_CELL_COLOR_MODE_PALETTE_256
  ) {
    return resolveXtermPaletteRgb(backgroundAttribute & XTERM_CELL_PALETTE_INDEX_MASK, theme);
  }
  return null;
};

export const isDarkBlockColor = (rgb: TerminalRgbColor): boolean => {
  const chroma = Math.max(...rgb) - Math.min(...rgb);
  return chroma <= DARK_BLOCK_MAX_CHROMA
    && getRelativeLuminance(rgb) <= DARK_BLOCK_MAX_RELATIVE_LUMINANCE;
};

export const isXtermCellDarkBlockBackground = (
  backgroundAttribute: number,
  theme: ITheme | undefined,
): boolean => {
  const rgb = resolveXtermCellBackgroundRgb(backgroundAttribute, theme);
  return rgb !== null && isDarkBlockColor(rgb);
};
