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
      className="settings-choice settings-list-item"
    >
      {leading}
      <Box className="min-w-0 flex-1">
        <Text className="truncate" fw={500} c="var(--on-surface)">
          {title}
        </Text>
        {subtitle != null && (
          <Text className="settings-list-subtitle truncate" c="var(--on-surface-variant)" mt={1} ff={subtitleMonospace ? "var(--font-ui-mono)" : undefined}>
            {subtitle}
          </Text>
        )}
      </Box>
      {rightSection}
    </UnstyledButton>
  );
}
