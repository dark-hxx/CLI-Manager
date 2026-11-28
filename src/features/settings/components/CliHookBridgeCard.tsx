import { useId, type ReactNode } from "react";
import { Switch } from "@mantine/core";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../../../shared/i18n/index";
import type { CliToolIconKey } from "../../../shared/lib/cliTools";
import { CliToolIcon } from "../../../shared/ui/CliToolIcon";
import type { HookBridgeBadgeStatus } from "../lib/hookSettingsModel";
import { StatusPill } from "./HookSettingsControls";

export interface CliHookBridgeCardProps {
  cliIcon: CliToolIconKey;
  title: string;
  description: string;
  status: HookBridgeBadgeStatus;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  switchAriaLabel: string;
  open: boolean;
  onToggle: () => void;
  disabledNotice?: ReactNode;
  children: ReactNode;
}

export function CliHookBridgeCard({
  cliIcon,
  title,
  description,
  status,
  enabled,
  onEnabledChange,
  switchAriaLabel,
  open,
  onToggle,
  disabledNotice,
  children,
}: CliHookBridgeCardProps) {
  const { t } = useI18n();
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;

  return (
    <section
      className="hook-bridge-card"
      data-disabled={!enabled ? "true" : undefined}
      aria-labelledby={titleId}
    >
      <div className="hook-bridge-header">
        <button
          type="button"
          className="hook-bridge-trigger"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={bodyId}
        >
          <span className="hook-bridge-icon" aria-hidden="true">
            <CliToolIcon icon={cliIcon} size={18} />
          </span>
          <span className="hook-bridge-meta">
            <span id={titleId} className="hook-bridge-title">
              {title}
            </span>
            <span className="hook-bridge-desc">{description}</span>
          </span>
        </button>

        <div className="hook-bridge-controls">
          <StatusPill status={status} />
          <span className="hook-bridge-sep" aria-hidden="true" />
          <Switch
            color="cliPrimary"
            size="sm"
            checked={enabled}
            onChange={(event) => onEnabledChange(event.currentTarget.checked)}
            aria-label={switchAriaLabel}
          />
          <button
            type="button"
            className="hook-bridge-chevron"
            data-open={open ? "true" : undefined}
            onClick={onToggle}
            tabIndex={-1}
            aria-hidden="true"
          >
            <ChevronDown size={16} />
          </button>
        </div>
      </div>

      {open && (
        <div id={bodyId} className="hook-bridge-body">
          {!enabled && (
            <div className="hook-bridge-notice">
              {disabledNotice ?? t("settings.hooks.bridge.pausedNotice")}
            </div>
          )}
          {children}
        </div>
      )}
    </section>
  );
}
