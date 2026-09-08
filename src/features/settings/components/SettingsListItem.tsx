import type { ReactNode } from "react";
import { Box, Text, UnstyledButton } from "@mantine/core";

interface SettingsListItemProps {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  rightSection?: ReactNode;
  selected?: boolean;
  subtitleMonospace?: boolean;
  ariaLabel?: string;
  ariaPressed?: boolean;
  onClick: () => void;
}

export function SettingsListItem({
  title,
  subtitle,
  leading,
  rightSection,
  selected = false,
  subtitleMonospace = false,
  ariaLabel,
  ariaPressed,
  onClick,
}: SettingsListItemProps) {
  return (
    <UnstyledButton
      type="button"
      onClick={onClick}
      data-selected={selected ? "true" : "false"}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className="ui-focus-ring flex w-full items-center gap-3 text-left transition-all"
      style={{
        padding: "9px 10px",
        borderRadius: 12,
        backgroundColor: selected
          ? "color-mix(in srgb, var(--primary) 10%, var(--surface-container-lowest))"
          : "var(--surface-container-lowest)",
        border: selected
          ? "1px solid color-mix(in srgb, var(--primary) 42%, transparent)"
          : "1px solid color-mix(in srgb, var(--border) 22%, transparent)",
        boxShadow: "none",
      }}
      onMouseEnter={(event) => {
        if (!selected) event.currentTarget.style.backgroundColor = "var(--surface-container-low)";
      }}
      onMouseLeave={(event) => {
        if (!selected) event.currentTarget.style.backgroundColor = "var(--surface-container-lowest)";
      }}
    >
      {leading}
      <Box className="min-w-0 flex-1">
        <Text className="truncate" fz={13} fw={500} c={selected ? "var(--primary)" : "var(--on-surface)"}>
          {title}
        </Text>
        {subtitle != null && (
          <Text className="truncate" fz={11} c="var(--text-muted)" mt={1} ff={subtitleMonospace ? "var(--font-ui-mono)" : undefined}>
            {subtitle}
          </Text>
        )}
      </Box>
      {rightSection}
    </UnstyledButton>
  );
}
