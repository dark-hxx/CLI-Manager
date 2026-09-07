import { Group, Text } from "@mantine/core";
import type { ReactNode } from "react";

interface PathItemProps {
  agentIcon?: ReactNode;
  icon?: ReactNode;
  label: string;
  path: string;
}

export function PathItem({ agentIcon, icon, label, path }: PathItemProps) {
  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-surface-container-lowest px-3 py-2">
      {agentIcon || icon ? (
        <Group gap={6} wrap="nowrap">
          {agentIcon && (
            <span className="flex shrink-0 items-center" aria-hidden="true">{agentIcon}</span>
          )}
          <Text className="min-w-0 flex-1" size="xs" c="dimmed" truncate title={label}>{label}</Text>
          {icon && (
            <span className="flex shrink-0 items-center" aria-hidden="true">{icon}</span>
          )}
        </Group>
      ) : (
        <Text size="xs" c="dimmed">{label}</Text>
      )}
      <Text size="xs" truncate title={path}>{path}</Text>
    </div>
  );
}
