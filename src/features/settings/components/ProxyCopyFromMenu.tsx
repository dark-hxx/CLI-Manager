import type { ReactNode } from "react";
import { Badge, Button, Menu, Tooltip } from "@mantine/core";
import { ChevronDown, Copy, Lock } from "lucide-react";
import { useI18n } from "../../../shared/i18n/index";
import type { ProxyCopySource } from "../../../shared/lib/proxySettings";

interface ProxyCopyFromMenuProps {
  sources: ProxyCopySource[];
  onSelect: (source: ProxyCopySource) => void;
  renderIcon?: (source: ProxyCopySource) => ReactNode;
  disabled?: boolean;
}

export function ProxyCopyFromMenu({
  sources,
  onSelect,
  renderIcon,
  disabled = false,
}: ProxyCopyFromMenuProps) {
  const { t } = useI18n();
  const isEmpty = sources.length === 0;

  const trigger = (
    <Button
      variant="default"
      size="xs"
      disabled={disabled || isEmpty}
      leftSection={<Copy size={13} />}
      rightSection={<ChevronDown size={13} />}
    >
      {t("settings.proxy.copyFrom.button")}
    </Button>
  );

  if (isEmpty) {
    return (
      <Tooltip label={t("settings.proxy.copyFrom.empty")} zIndex={210}>
        <span style={{ display: "inline-flex" }}>{trigger}</span>
      </Tooltip>
    );
  }

  return (
    <Menu position="bottom-end" width={310} withinPortal zIndex={200}>
      <Menu.Target>{trigger}</Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>{t("settings.proxy.copyFrom.menuLabel")}</Menu.Label>
        {sources.map((source) => (
          <Menu.Item key={source.id} onClick={() => onSelect(source)}>
            <div className="proxy-copy-item">
              <div className="proxy-copy-item-top">
                {renderIcon && (
                  <span className="proxy-copy-item-icon" aria-hidden="true">
                    {renderIcon(source)}
                  </span>
                )}
                <span className="proxy-copy-item-label">{source.label}</span>
                {source.command && (
                  <code className="proxy-agent-cmd">{source.command}</code>
                )}
                {source.hasAuth && (
                  <Badge
                    size="xs"
                    variant="light"
                    color="gray"
                    leftSection={<Lock size={10} />}
                    className="proxy-pill proxy-copy-auth-badge"
                    data-tone="neutral"
                  >
                    {t("settings.proxy.copyFrom.hasAuth")}
                  </Badge>
                )}
              </div>
              <div className="proxy-copy-item-url">{source.displayUrl}</div>
            </div>
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
