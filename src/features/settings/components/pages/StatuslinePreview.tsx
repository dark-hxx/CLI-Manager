import { useMemo } from "react";
import { Box, Group, NumberInput, Select, Text } from "@mantine/core";
import { Activity } from "lucide-react";
import { TERMINAL_THEME_PRESETS, getTerminalTheme } from "../../../../shared/lib/terminalThemes";
import { useSettingsStore } from "../../../../shared/preferences/settingsStore";
import { useI18n } from "../../../../shared/i18n/index";
import { normalizeTerminalFontFamily } from "../../../terminal/api/terminalFontFamily";

export interface StatuslinePreviewState {
  themeId: string;
  width: number;
}

interface Props {
  text: string;
  state: StatuslinePreviewState;
  onChange: (state: StatuslinePreviewState) => void;
  emptyText: string;
  ariaLabel: string;
  variant?: "default" | "codex-footer";
}

interface PreviewSpan {
  text: string;
  color?: string;
  background?: string;
  bold?: boolean;
  dim?: boolean;
}

function ansiColor(code: number, theme: ReturnType<typeof getTerminalTheme>) {
  const colors: Record<number, string | undefined> = {
    30: theme.black, 31: theme.red, 32: theme.green, 33: theme.yellow,
    34: theme.blue, 35: theme.magenta, 36: theme.cyan, 37: theme.white,
    90: theme.brightBlack, 91: theme.brightRed, 92: theme.brightGreen,
    93: theme.brightYellow, 94: theme.brightBlue, 95: theme.brightMagenta,
    96: theme.brightCyan, 97: theme.brightWhite,
  };
  return colors[code];
}

function ansi256Color(code: number, theme: ReturnType<typeof getTerminalTheme>) {
  const baseColors = [
    theme.black, theme.red, theme.green, theme.yellow, theme.blue, theme.magenta, theme.cyan, theme.white,
    theme.brightBlack, theme.brightRed, theme.brightGreen, theme.brightYellow,
    theme.brightBlue, theme.brightMagenta, theme.brightCyan, theme.brightWhite,
  ];
  if (code >= 0 && code < baseColors.length) return baseColors[code];
  if (code >= 16 && code <= 231) {
    const value = code - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(value / 36)];
    const green = levels[Math.floor(value / 6) % 6];
    const blue = levels[value % 6];
    return `rgb(${red}, ${green}, ${blue})`;
  }
  if (code >= 232 && code <= 255) {
    const gray = 8 + (code - 232) * 10;
    return `rgb(${gray}, ${gray}, ${gray})`;
  }
  return undefined;
}

function parseAnsi(text: string, theme: ReturnType<typeof getTerminalTheme>): PreviewSpan[] {
  const spans: PreviewSpan[] = [];
  const pattern = /\x1b\[([0-9;]*)m/g;
  let cursor = 0;
  let style: Omit<PreviewSpan, "text"> = {};
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index > cursor) spans.push({ text: text.slice(cursor, match.index), ...style });
    const codes = (match[1] || "0").split(";").map(Number);
    if (codes.includes(0)) style = {};
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      if (code === 1) style.bold = true;
      else if (code === 2) style.dim = true;
      else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) style.color = ansiColor(code, theme);
      else if (code >= 40 && code <= 47) style.background = ansiColor(code - 10, theme);
      else if (code >= 100 && code <= 107) style.background = ansiColor(code - 10, theme);
      else if ((code === 38 || code === 48) && codes[index + 1] === 5 && codes.length > index + 2) {
        const color = ansi256Color(codes[index + 2], theme);
        if (code === 38) style.color = color;
        else style.background = color;
        index += 2;
      } else if ((code === 38 || code === 48) && codes[index + 1] === 2 && codes.length > index + 4) {
        const color = `rgb(${codes[index + 2]}, ${codes[index + 3]}, ${codes[index + 4]})`;
        if (code === 38) style.color = color;
        else style.background = color;
        index += 4;
      }
    }
    cursor = pattern.lastIndex;
  }
  if (cursor < text.length) spans.push({ text: text.slice(cursor), ...style });
  return spans;
}

export function StatuslinePreview({ text, state, onChange, emptyText, ariaLabel, variant = "default" }: Props) {
  const { t } = useI18n();
  const resolvedTheme = useSettingsStore((value) => value.resolvedTheme);
  const lightPalette = useSettingsStore((value) => value.lightThemePalette);
  const darkPalette = useSettingsStore((value) => value.darkThemePalette);
  const terminalThemeName = useSettingsStore((value) => value.terminalThemeName);
  const terminalFontFamily = useSettingsStore((value) => value.fontFamily);
  const normalizedTerminalFontFamily = useMemo(() => normalizeTerminalFontFamily(terminalFontFamily), [terminalFontFamily]);
  const effectiveThemeId = state.themeId || terminalThemeName;
  const terminalTheme = getTerminalTheme(effectiveThemeId, resolvedTheme, lightPalette, darkPalette);
  const lines = useMemo(() => text.replace(/\r\n?/g, "\n").split("\n").map((line) => parseAnsi(line, terminalTheme)), [text, terminalTheme]);
  const hasContent = text.length > 0;
  const themeOptions = useMemo(() => [
    { value: "", label: t("settings.statusline.previewFollowTerminal") },
    ...TERMINAL_THEME_PRESETS.map((preset) => ({ value: preset.id, label: preset.name })),
  ], [t]);
  const compact = variant === "default";
  const previewBorder = `1px solid color-mix(in srgb, ${terminalTheme.foreground} ${compact ? 28 : 18}%, transparent)`;

  return (
    <section
      className={compact ? "overflow-hidden rounded-md" : "overflow-hidden rounded-2xl border border-border"}
      aria-label={ariaLabel}
      style={{
        background: terminalTheme.background,
        color: terminalTheme.foreground,
        border: compact ? previewBorder : undefined,
      }}
    >
      <Group
        justify="space-between"
        gap="sm"
        px={compact ? 10 : "md"}
        py={compact ? 6 : "sm"}
        style={{ borderBottom: previewBorder }}
      >
        <Group gap="xs">
          <Activity size={compact ? 14 : 16} color={terminalTheme.green ?? terminalTheme.foreground} />
          <Text size={compact ? "xs" : "sm"} fw={600} style={{ color: terminalTheme.foreground }}>{t("settings.statusline.livePreview")}</Text>
        </Group>
        <Group gap="xs">
          <Select
            size="xs"
            w={compact ? 168 : 190}
            data={themeOptions}
            value={state.themeId}
            onChange={(value) => onChange({ ...state, themeId: value ?? "" })}
            aria-label={t("settings.statusline.previewTheme")}
          />
          <NumberInput
            size="xs"
            w={compact ? 82 : 94}
            min={60}
            max={180}
            value={state.width}
            onChange={(value) => onChange({ ...state, width: Math.min(180, Math.max(60, Number(value) || 100)) })}
            aria-label={t("settings.statusline.previewWidth")}
          />
        </Group>
      </Group>
      <Box
        m={0}
        p={variant === "codex-footer" ? 10 : compact ? 8 : 12}
        mih={variant === "codex-footer" ? 42 : compact ? 36 : 52}
        ff={normalizedTerminalFontFamily}
        fz={compact ? 12.5 : 13}
        className="overflow-x-auto"
        style={{
          width: "100%",
          color: terminalTheme.foreground,
          caretColor: terminalTheme.cursor,
          background: terminalTheme.background,
          lineHeight: compact ? 1.35 : 1.5,
          letterSpacing: 0,
        }}
      >
        {hasContent ? lines.map((line, lineIndex) => (
          <Box
            key={lineIndex}
            component="div"
            className="whitespace-pre"
            mih="1.5em"
            style={{ width: "max-content", minWidth: `max(100%, ${state.width}ch)` }}
          >
            {line.map((span, index) => (
              <span key={index} style={{
                color: span.color,
                backgroundColor: span.background,
                fontWeight: span.bold ? 700 : undefined,
                opacity: span.dim ? 0.68 : undefined,
              }}>{span.text}</span>
            ))}
          </Box>
        )) : <span style={{ color: terminalTheme.brightBlack ?? terminalTheme.foreground }}>{emptyText}</span>}
      </Box>
    </section>
  );
}
