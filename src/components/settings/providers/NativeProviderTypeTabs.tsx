import { Box, Group } from "@mantine/core";
import { useRef } from "react";
import { CliToolIcon } from "../../CliToolIcon";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type { NativeProviderAppType } from "./nativeProviderTypes";

interface NativeProviderTypeTabsProps {
  value: NativeProviderAppType;
  labels: Record<NativeProviderAppType, string>;
  onChange: (value: NativeProviderAppType) => boolean | void | Promise<boolean | void>;
}

const ICON_KEYS = {
  claude: "claude-code",
  codex: "codex",
  grokbuild: "grok",
} as const satisfies Record<NativeProviderAppType, "claude-code" | "codex" | "grok">;

export function NativeProviderTypeTabs({ value, labels, onChange }: NativeProviderTypeTabsProps) {
  const values: NativeProviderAppType[] = ["claude", "codex", "grokbuild"];
  const tabRefs = useRef<Partial<Record<NativeProviderAppType, HTMLButtonElement | null>>>({});

  const activateTab = (next: NativeProviderAppType) => {
    const current = value;
    void Promise.resolve(onChange(next))
      .then((changed) => {
        const target = changed === false ? current : next;
        requestAnimationFrame(() => tabRefs.current[target]?.focus());
      })
      .catch(() => {
        requestAnimationFrame(() => tabRefs.current[current]?.focus());
      });
  };

  return (
    <Box
      component="div"
      role="tablist"
      aria-label={labels[value]}
      className="rounded-xl border border-border/70 bg-surface-container-low p-1"
    >
      <Group gap={4} wrap="wrap">
        {values.map((item) => {
          const active = item === value;
          return (
            <Button
              key={item}
              ref={(node) => {
                tabRefs.current[item] = node;
              }}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              variant={active ? "light" : "subtle"}
              color={active ? "cliPrimary" : "gray"}
              size="compact-sm"
              leftSection={<CliToolIcon icon={ICON_KEYS[item]} size={15} className={active ? "" : "opacity-50"} />}
              onClick={() => activateTab(item)}
              onKeyDown={(event) => {
                const currentIndex = values.indexOf(item);
                let nextIndex: number | null = null;
                if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                  nextIndex = (currentIndex + 1) % values.length;
                } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                  nextIndex = (currentIndex - 1 + values.length) % values.length;
                } else if (event.key === "Home") {
                  nextIndex = 0;
                } else if (event.key === "End") {
                  nextIndex = values.length - 1;
                }
                if (nextIndex === null) return;
                event.preventDefault();
                activateTab(values[nextIndex]);
              }}
            >
              {labels[item]}
            </Button>
          );
        })}
      </Group>
    </Box>
  );
}
