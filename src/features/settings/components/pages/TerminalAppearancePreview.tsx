import type { CSSProperties } from "react";
import type { ITheme } from "@xterm/xterm";
import { Terminal } from "lucide-react";
import { useI18n } from "../../../../shared/i18n/index";

const ANSI_KEYS = [
  "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow",
  "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
] as const satisfies readonly (keyof ITheme)[];

interface TerminalAppearancePreviewProps {
  theme: ITheme;
  themeName: string;
  fontFamily: string;
  fontSize: number;
  textColor: string;
}

export function TerminalAppearancePreview({
  theme, themeName, fontFamily, fontSize, textColor,
}: TerminalAppearancePreviewProps) {
  const { t } = useI18n();
  const foreground = textColor || theme.foreground || "#d8dee9";
  const style = {
    "--appearance-background": theme.background || "#1e1e1e",
    "--appearance-foreground": foreground,
    "--appearance-selection": theme.selectionBackground || "#ffffff4d",
    "--appearance-selection-text": theme.selectionForeground || foreground,
    "--appearance-cursor": theme.cursor || foreground,
  } as CSSProperties;

  return (
    <div className="terminal-appearance-preview">
      <div className="terminal-appearance-caption">
        <strong>{themeName}</strong>
        <span>{t("settings.terminalPreview.description")}</span>
      </div>
      <div className="terminal-appearance-window" style={style}>
        <div className="terminal-appearance-titlebar">
          <Terminal size={15} aria-hidden="true" />
          <span>cli-manager</span>
          <span className="terminal-appearance-session">PowerShell</span>
        </div>
        <div
          className="terminal-appearance-screen"
          role="region"
          aria-label={t("settings.terminalPreview.outputLabel")}
          tabIndex={0}
          style={{ fontFamily, fontSize: `${fontSize}px` }}
        >
          <div className="terminal-appearance-transcript">
            <div>
              <span style={{ color: theme.blue }}>F:\projects\cli-manager</span>
              {" "}<span style={{ color: theme.magenta }}>(main)</span>
            </div>
            <div><span style={{ color: theme.green }}>❯</span> cli-manager --doctor</div>
            <div>{t("settings.terminalPreview.starting")}</div>
            <div style={{ color: theme.cyan }}>[INFO] {t("settings.terminalPreview.info")}</div>
            <div style={{ color: theme.green }}>[OK]   {t("settings.terminalPreview.success")}</div>
            <div style={{ color: theme.yellow }}>[WARN] {t("settings.terminalPreview.warning")}</div>
            <div style={{ color: theme.red }}>[FAIL] {t("settings.terminalPreview.error")}</div>
            <div className="terminal-appearance-gap" aria-hidden="true" />
            <div><span style={{ color: theme.green }}>❯</span> git diff -- src/app.ts</div>
            <div style={{ color: theme.cyan }}>@@ -1 +1 @@</div>
            <div style={{ color: theme.red }}>- const status = "pending";</div>
            <div style={{ color: theme.green }}>+ const status = "ready";</div>
            <div className="terminal-appearance-gap" aria-hidden="true" />
            <div><span className="terminal-appearance-selection">{t("settings.terminalPreview.selection")}</span></div>
            <div>Aa Bb Cc 0123456789 {"{} [] () =>"}</div>
            <div><strong>{t("settings.terminalPreview.fontSample")}</strong></div>
            <div className="terminal-appearance-gap" aria-hidden="true" />
            <div>
              <span style={{ color: theme.blue }}>F:\projects\cli-manager</span>
              {" "}<span style={{ color: theme.magenta }}>(main)</span>
            </div>
            <div><span style={{ color: theme.green }}>❯</span>{" "}<span className="terminal-appearance-cursor" aria-hidden="true" /></div>
          </div>
        </div>
        <div className="terminal-appearance-palette">
          <div className="terminal-appearance-palette-label">
            <span>{t("settings.terminalPreview.ansi")}</span>
            <span>{fontSize}px</span>
          </div>
          <div className="terminal-appearance-swatches" aria-label={t("settings.terminalPreview.ansi")} role="group">
            {ANSI_KEYS.map((key, index) => (
              <span
                key={key}
                className="terminal-appearance-swatch"
                style={{ backgroundColor: theme[key] || foreground }}
                title={`${index} · ${key} · ${theme[key] || foreground}`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
