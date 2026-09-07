import { useCallback, type CSSProperties } from "react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import { Activity, TerminalSquare, Sparkles, Copy, Folder, FolderOpen, Hash, Cloud } from "../../../components/icons";
import { VendorIcon } from "../../../components/VendorIcon";
import { type TerminalTabHoverInfo, type TerminalTabHoverRow, formatSessionIdPreview } from "../lib/terminalTabsModel";

export function TerminalTabHoverCard({
  info,
  position,
  themeStyle,
  onPointerEnter,
  onPointerLeave,
}: {
  info: TerminalTabHoverInfo;
  position: { left: number; top: number };
  themeStyle?: CSSProperties;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
}) {
  const { t } = useI18n();
  const sessionIdPreview = formatSessionIdPreview(info.sessionId);
  const rows: TerminalTabHoverRow[] = [
    { key: "cli", label: "CLI", value: info.cli, icon: Sparkles, vendor: info.cliVendor },
    { key: "shell", label: "Shell", value: info.shell, icon: TerminalSquare },
    { key: "project", label: t("termStats.project"), value: info.project, icon: Folder },
    {
      key: "path",
      label: t("termStats.path"),
      value: info.path,
      icon: FolderOpen,
      copyValue: info.path,
      copyLabel: t("terminal.tab.copyPath"),
    },
    ...(info.sshHost ? [{ key: "ssh-host", label: t("terminal.ssh.host"), value: info.sshHost, icon: Cloud }] : []),
    ...(info.connectionState ? [{
      key: "connection-state",
      label: t("terminal.ssh.connectionState"),
      value: t(`terminal.ssh.connection.${info.connectionState}` as TranslationKey),
      icon: Activity,
    }] : []),
    ...(info.disconnectReason ? [{
      key: "disconnect-reason",
      label: t("terminal.ssh.disconnectReason"),
      value: t(`terminal.ssh.disconnect.${info.disconnectReason}` as TranslationKey),
      icon: Activity,
    }] : []),
    {
      key: "session-id",
      label: "Session ID",
      value: sessionIdPreview,
      icon: Hash,
      copyValue: info.sessionId,
      copyLabel: t("terminal.tab.copySessionId"),
    },
  ];
  const copyValue = useCallback((value: string, label: string) => {
    void navigator.clipboard
      .writeText(value)
      .then(() => toast.success(t("terminal.tab.copySuccess", { label })))
      .catch((err) => toast.error(t("terminal.tab.copyFailed"), { description: String(err) }));
  }, [t]);

  return (
    <div
      className="ui-terminal-tab-hover-card"
      style={{ ...themeStyle, left: position.left, top: position.top }}
      role="tooltip"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div className="ui-terminal-tab-hover-title">{info.name}</div>
      <div className="ui-terminal-tab-hover-rows">
        {rows.map((row) => {
          const RowIcon = row.icon;
          const copyTarget = row.copyValue;
          const copyLabel = row.copyLabel;
          return (
            <div key={row.key} className={`ui-terminal-tab-hover-row${copyTarget ? " ui-terminal-tab-hover-row-action" : ""}`}>
              <span className="ui-terminal-tab-hover-label">
                <RowIcon size={12} strokeWidth={1.8} aria-hidden="true" />
                <span>{row.label}</span>
              </span>
              <strong className="ui-terminal-tab-hover-value">
                {row.vendor && (
                  <span className="ui-terminal-tab-hover-vendor" aria-hidden="true">
                    <VendorIcon vendor={row.vendor} size={13} />
                  </span>
                )}
                <span>{row.value}</span>
              </strong>
              {copyTarget && copyLabel && (
                <button
                  type="button"
                  className="ui-terminal-tab-hover-copy"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    copyValue(copyTarget, row.label);
                  }}
                  aria-label={copyLabel}
                  title={copyLabel}
                >
                  <Copy size={12} strokeWidth={2} aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
