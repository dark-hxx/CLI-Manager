import { useState, type ReactNode } from "react";
import { ActionIcon, Badge, Box, Button, Card, Group, Stack, Switch, Text } from "@mantine/core";
import { Folder, FileCode, Copy, Check, Bell, BellOff } from "lucide-react";
import { useI18n } from "../../../shared/i18n/index";
import {
  type HookBridgeBadgeStatus,
  getBadgeStatusColor,
  getBadgeStatusLabel,
  pickText,
  formatPath,
} from "../lib/hookSettingsModel";
import { SettingsRow, SettingsSection } from "./SettingsPrimitives";
import { debugConsoleError } from "../../../shared/platform/debugConsole";

export function PathRow({ label, value }: { label: string; value: string | null }) {
  const { language } = useI18n();
  const formatted = formatPath(value, language);
  const hasValue = Boolean(value && value.trim());
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!hasValue || !value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      debugConsoleError("Failed to copy:", err);
    }
  };

  const getIcon = () => {
    const normalized = label.toLowerCase();
    if (label.includes("目录") || normalized.includes("directory")) return <Folder size={16} />;
    return <FileCode size={16} />;
  };

  return (
    <Box className="hook-path-row" p="sm">
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Box
          style={{
            color: hasValue ? "var(--primary)" : "var(--text-muted)",
            marginTop: 2,
          }}
        >
          {getIcon()}
        </Box>
        <Stack gap={4} className="min-w-0 flex-1">
          <Text size="xs" fw={500} c="var(--on-surface-variant)">
            {label}
          </Text>
          <Text
            component="code"
            size="xs"
            ff="var(--font-ui-mono)"
            c={hasValue ? "var(--on-surface)" : "var(--text-muted)"}
            className="min-w-0 break-all leading-5"
            title={formatted}
          >
            {formatted}
          </Text>
        </Stack>
        {hasValue && (
          <Button
            variant="subtle"
            color="gray"
            size="compact-xs"
            onClick={handleCopy}
            className="shrink-0"
            aria-label={pickText(language, "复制路径", "Copy path")}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </Button>
        )}
      </Group>
    </Box>
  );
}

export interface HookCardProps {
  icon: React.ReactNode;
  label: string;
  checked: boolean;
  notifyEnabled?: boolean;
  onToggleNotify?: () => void;
  notifyDisabled?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  actionLabel?: string;
}

export function HookCard({
  icon,
  label,
  checked,
  notifyEnabled,
  onToggleNotify,
  notifyDisabled,
  onClick,
  disabled,
  actionLabel,
}: HookCardProps) {
  const { language } = useI18n();
  const interactive = Boolean(onClick);
  return (
    <Card
      className="border transition-colors"
      p="md"
      radius="lg"
      role={interactive ? "button" : undefined}
      tabIndex={interactive && !disabled ? 0 : undefined}
      aria-disabled={interactive ? disabled : undefined}
      aria-label={actionLabel}
      title={actionLabel}
      onClick={interactive && !disabled ? onClick : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (disabled) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick?.();
              }
            }
          : undefined
      }
      style={{
        borderColor: checked
          ? "color-mix(in srgb, var(--success) 38%, var(--settings-card-border, var(--settings-line)))"
          : "var(--settings-card-border, var(--settings-line))",
        backgroundColor: checked
          ? "color-mix(in srgb, var(--success) 8%, var(--settings-subsurface, var(--surface-container-low)))"
          : "var(--settings-subsurface, var(--surface-container-low))",
        cursor: interactive && !disabled ? "pointer" : "default",
        opacity: disabled ? 0.68 : 1,
      }}
    >
      <Stack gap={8} align="center">
        <Box
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg [&>svg]:h-5 [&>svg]:w-5"
          style={{
            color: checked ? "var(--success)" : "var(--text-muted)",
            backgroundColor: checked
              ? "color-mix(in srgb, var(--success) 12%, transparent)"
              : "color-mix(in srgb, var(--on-surface) 5%, transparent)",
          }}
        >
          {icon}
        </Box>
        <Text
          size="xs"
          fw={500}
          c={checked ? "var(--on-surface)" : "var(--on-surface-variant)"}
          ta="center"
          lh={1.3}
        >
          {label}
        </Text>
        <Group gap={4} align="center" wrap="nowrap">
          <Badge variant="filled" color={checked ? "green" : "gray"} radius="xl" size="xs">
            {checked ? pickText(language, "已安装", "Installed") : pickText(language, "未安装", "Not Installed")}
          </Badge>
          {onToggleNotify && (
            <ActionIcon
              variant={notifyEnabled ? "light" : "subtle"}
              color={notifyEnabled ? "blue" : "gray"}
              size="sm"
              radius="xl"
              onClick={(e) => {
                e.stopPropagation();
                onToggleNotify();
              }}
              disabled={notifyDisabled}
              aria-label={pickText(language, `${label} 系统通知`, `${label} system notification`)}
            >
              {notifyEnabled ? <Bell size={12} /> : <BellOff size={12} />}
            </ActionIcon>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

export function StatusPill({ status }: { status: HookBridgeBadgeStatus }) {
  const { language } = useI18n();
  return (
    <Badge variant="light" color={getBadgeStatusColor(status)} radius="xl">
      {getBadgeStatusLabel(status, language)}
    </Badge>
  );
}

export function SettingsSwitchRow({
  title,
  description,
  checked,
  onCheckedChange,
  icon: Icon,
  tools,
}: {
  title: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  icon?: React.ComponentType<{ size?: number }>;
  tools?: ("claude" | "codex")[];
}) {
  return (
    <SettingsRow
      leading={Icon && <Icon size={18} />}
      description={description}
      title={
        <Group gap="xs" align="center" wrap="wrap">
          <span>{title}</span>
          {tools?.map((tool) => (
            <Badge key={tool} variant="light" size="xs" color={tool === "claude" ? "orange" : "blue"}>
              {tool === "claude" ? "Claude" : "Codex"}
            </Badge>
          ))}
        </Group>
      }
    >
      <Switch
        color="cliPrimary"
        checked={checked}
        onChange={(event) => onCheckedChange(event.currentTarget.checked)}
        aria-label={title}
      />
    </SettingsRow>
  );
}

export function CollapsibleHookSection({
  title,
  description,
  open,
  onToggle,
  children,
  action,
  collapsible = true,
  right,
}: {
  title: string;
  description?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  action?: ReactNode;
  collapsible?: boolean;
  right?: ReactNode;
}) {
  return (
    <SettingsSection
      title={title}
      description={description}
      className="settings-section--card"
      open={open}
      onToggle={collapsible ? onToggle : undefined}
      actions={
        (action || right) && (
          <Group gap="xs" wrap="wrap">
            {action}
            {right}
          </Group>
        )
      }
    >
      {children}
    </SettingsSection>
  );
}
