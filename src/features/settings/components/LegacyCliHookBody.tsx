import { useEffect, useState, type ReactNode } from "react";
import { Box, Button, Group, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import { AlertTriangle, Check, ChevronDown, ChevronUp, FileCode, HelpCircle, ShieldAlert, X } from "lucide-react";
import { useI18n } from "../../../shared/i18n/index";
import { pickText, type HookTool } from "../lib/hookSettingsModel";
import { HookCard, PathRow, type HookCardProps } from "./HookSettingsControls";

export interface LegacyHookModuleItem extends HookCardProps {
  key: string;
}

export interface LegacyHookPathItem {
  label: string;
  value: string | null;
}

export interface LegacyCliHookBodyProps {
  tool: HookTool;
  topSlot?: ReactNode;
  modules: LegacyHookModuleItem[];
  grokIsolationInstalled?: boolean;
  openPathsSignal?: number;
  paths: LegacyHookPathItem[];
  dirLabel: string;
  dirPlaceholder: string;
  dirValue: string;
  onDirChange: (next: string) => void;
  onDirCommit: (raw: string) => void;
  onSelectDir: () => void;
  chooseDirLabel: string;
  onInstall: () => void;
  installLabel: string;
  installDisabled: boolean;
  working: boolean;
  onUninstall: () => void;
  uninstallLabel: string;
  uninstallDisabled: boolean;
  onRefresh: () => void;
  loading: boolean;
  anyWorking: boolean;
}

function LegacyHookInstallNotes({ tool }: { tool: HookTool }) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => pickText(language, zh, en);

  if (tool === "claude") {
    return (
      <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Box style={{ color: "var(--success)", marginTop: 2 }}><Check size={16} /></Box>
          <Stack gap={2}>
            <Text size="xs" fw={500} c="var(--on-surface)">{text("安装内容", "Installed Content")}</Text>
            <Group gap="xs">
              <FileCode size={12} style={{ color: "var(--text-muted)" }} />
              <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">
                {text("settings.json 注册 __hook 命令", "settings.json registers the __hook command")}
              </Text>
            </Group>
            <Group gap="xs">
              <FileCode size={12} style={{ color: "var(--text-muted)" }} />
              <Text size="xs" c="var(--on-surface-variant)">
                {text("指向本程序，跨平台无需脚本", "Points to this app directly; no cross-platform script is needed")}
              </Text>
            </Group>
          </Stack>
        </Group>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Box style={{ color: "var(--warning)", marginTop: 2 }}><X size={16} /></Box>
          <Stack gap={2}>
            <Text size="xs" fw={500} c="var(--on-surface)">{text("删除时保留", "Kept on Removal")}</Text>
            <Text size="xs" c="var(--on-surface-variant)">{text("• 用户自己的 hooks", "• User-owned hooks")}</Text>
            <Text size="xs" c="var(--on-surface-variant)">
              {text("• 其它工具注册的 hook 命令", "• Hook commands registered by other tools")}
            </Text>
          </Stack>
        </Group>
      </Stack>
    );
  }

  if (tool === "codex") {
    return (
      <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Box style={{ color: "var(--success)", marginTop: 2 }}><Check size={16} /></Box>
          <Stack gap={2}>
            <Text size="xs" fw={500} c="var(--on-surface)">{text("安装内容", "Installed Content")}</Text>
            <Group gap="xs">
              <FileCode size={12} style={{ color: "var(--text-muted)" }} />
              <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">
                {text("hooks.json 注册 __hook 命令", "hooks.json registers the __hook command")}
              </Text>
            </Group>
            <Group gap="xs">
              <FileCode size={12} style={{ color: "var(--text-muted)" }} />
              <Text size="xs" c="var(--on-surface-variant)">
                {text("指向本程序，跨平台无需脚本", "Points to this app directly; no cross-platform script is needed")}
              </Text>
            </Group>
            <Group gap="xs">
              <FileCode size={12} style={{ color: "var(--text-muted)" }} />
              <Text size="xs" c="var(--on-surface-variant)">
                {text("config.toml 中开启 ", "Enable ")}
                <span className="font-mono">[features].hooks = true</span>
                {text("", " in config.toml")}
              </Text>
            </Group>
          </Stack>
        </Group>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Box style={{ color: "var(--warning)", marginTop: 2 }}><AlertTriangle size={16} /></Box>
          <Stack gap={2}>
            <Text size="xs" fw={500} c="var(--on-surface)">{text("注意事项", "Notes")}</Text>
            <Text size="xs" c="var(--on-surface-variant)">
              {text("• 不修改项目级 ", "• Does not modify project-level ")}
              <span className="font-mono">.codex/hooks.json</span>
            </Text>
            <Text size="xs" c="var(--on-surface-variant)">
              {text("• Codex 0.129+ 仍需在 TUI 执行 ", "• Codex 0.129+ still requires running ")}
              <span className="font-mono">/hooks</span>
              {text(" 批准脚本", " in the TUI to approve scripts")}
            </Text>
          </Stack>
        </Group>
      </Stack>
    );
  }

  if (tool === "kimi") {
    return (
      <Stack gap="xs" style={{ flex: 1, minWidth: 0 }}>
        <Text size="xs" c="var(--on-surface-variant)">
          {text(
            "仅支持当前 Kimi Code；安装前会通过 kimi doctor 校验临时配置，旧 kimi-cli 不受支持且不会迁移 ~/.kimi。",
            "Only current Kimi Code is supported. A temporary config is validated with kimi doctor before installation; legacy kimi-cli is unsupported and ~/.kimi is never migrated.",
          )}
        </Text>
        <Text size="xs" c="var(--on-surface-variant)">
          {text(
            "自定义目录只决定 Hook 配置写入位置，不会自动切换本地 Kimi 的 KIMI_CODE_HOME、凭据或会话。",
            "The custom directory only selects where Hook config is managed; it does not change local KIMI_CODE_HOME, credentials, or sessions.",
          )}
        </Text>
        <Text size="xs" c="var(--on-surface-variant)">
          {text(
            "CLI-Manager 只删除带精确 owner 标记的条目，并保留用户与第三方 Hook。安装后新会话自动生效；活动 TUI 请执行 /reload。",
            "CLI-Manager removes only entries with its exact owner marker and preserves user and third-party hooks. New sessions pick up changes automatically; run /reload in active TUI sessions.",
          )}
        </Text>
      </Stack>
    );
  }

  if (tool === "pi") {
    return (
      <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Box style={{ color: "var(--success)", marginTop: 2 }}><Check size={16} /></Box>
          <Stack gap={2}>
            <Text size="xs" fw={500} c="var(--on-surface)">{text("安装内容", "Installed Content")}</Text>
            <Group gap="xs">
              <FileCode size={12} style={{ color: "var(--text-muted)" }} />
              <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">
                ~/.pi/agent/extensions/cli-manager-hook.ts
              </Text>
            </Group>
            <Group gap="xs">
              <FileCode size={12} style={{ color: "var(--text-muted)" }} />
              <Text size="xs" c="var(--on-surface-variant)">
                {text(
                  "监听 session_start / agent_start / agent_settled 并上报 CLI-Manager",
                  "Listens to session_start / agent_start / agent_settled and reports to CLI-Manager",
                )}
              </Text>
            </Group>
          </Stack>
        </Group>
        <Group gap="sm" wrap="nowrap" align="flex-start">
          <Box style={{ color: "var(--warning)", marginTop: 2 }}><AlertTriangle size={16} /></Box>
          <Stack gap={2}>
            <Text size="xs" fw={500} c="var(--on-surface)">{text("注意事项", "Notes")}</Text>
            <Text size="xs" c="var(--on-surface-variant)">
              {text(
                "• Pi 使用 Extension 机制，不是 Claude/Codex 的 shell hook 命令",
                "• Pi uses the Extension mechanism, not Claude/Codex shell hook commands",
              )}
            </Text>
            <Text size="xs" c="var(--on-surface-variant)">
              {text(
                "• 安装后新开的 Pi 会话会自动加载；已运行会话可执行 ",
                "• Newly started Pi sessions load it automatically; for existing sessions run ",
              )}
              <span className="font-mono">/reload</span>
            </Text>
            <Text size="xs" c="var(--on-surface-variant)">
              {text(
                "• 实时统计依赖 PTY 注入的 CLI_MANAGER_* 环境变量与 sessionId 绑定",
                "• Live stats require PTY-injected CLI_MANAGER_* env vars and sessionId binding",
              )}
            </Text>
          </Stack>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="sm" style={{ flex: 1, minWidth: 0 }}>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Box style={{ color: "var(--success)", marginTop: 2 }}><Check size={16} /></Box>
        <Stack gap={2}>
          <Text size="xs" fw={500} c="var(--on-surface)">{text("安装内容", "Installed Content")}</Text>
          <Text size="xs" c="var(--on-surface-variant)" ff="var(--font-ui-mono)">
            {text("~/.grok/hooks/cli-manager.json（不是 settings.json）", "~/.grok/hooks/cli-manager.json (not settings.json)")}
          </Text>
          <Text size="xs" c="var(--on-surface-variant)">
            {text("注册 __hook --source grok 事件；Grok 扫描 hooks/*.json", "Registers __hook --source grok events; Grok scans hooks/*.json")}
          </Text>
          <Text size="xs" c="var(--on-surface-variant)">
            {text(
              "~/.grok/config.toml：compat.claude.hooks / compat.cursor.hooks = false",
              "~/.grok/config.toml: compat.claude.hooks / compat.cursor.hooks = false",
            )}
          </Text>
        </Stack>
      </Group>
      <Group gap="sm" wrap="nowrap" align="flex-start">
        <Box style={{ color: "var(--warning)", marginTop: 2 }}><X size={16} /></Box>
        <Stack gap={2}>
          <Text size="xs" fw={500} c="var(--on-surface)">{text("删除时", "On Removal")}</Text>
          <Text size="xs" c="var(--on-surface-variant)">
            {text("• 仅移除 CLI-Manager 的 Grok hook 条目", "• Only removes CLI-Manager Grok hook entries")}
          </Text>
          <Text size="xs" c="var(--on-surface-variant)">
            {text("• 不恢复跨工具 hook 兼容（避免再次串线）", "• Does not re-enable cross-tool hook compatibility")}
          </Text>
        </Stack>
      </Group>
    </Stack>
  );
}

export function LegacyCliHookBody({
  tool,
  topSlot,
  modules,
  grokIsolationInstalled,
  openPathsSignal = 0,
  paths,
  dirLabel,
  dirPlaceholder,
  dirValue,
  onDirChange,
  onDirCommit,
  onSelectDir,
  chooseDirLabel,
  onInstall,
  installLabel,
  installDisabled,
  working,
  onUninstall,
  uninstallLabel,
  uninstallDisabled,
  onRefresh,
  loading,
  anyWorking,
}: LegacyCliHookBodyProps) {
  const { language } = useI18n();
  const text = (zh: string, en: string) => pickText(language, zh, en);
  const [pathsOpen, setPathsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    if (openPathsSignal > 0) setPathsOpen(true);
  }, [openPathsSignal]);

  return (
    <>
      {topSlot}

      <SimpleGrid cols={{ base: 2, sm: 3 }} spacing="sm">
        {modules.map(({ key, ...cardProps }) => (
          <HookCard key={key} {...cardProps} />
        ))}
      </SimpleGrid>

      {tool === "grok" && (
        <div className="hook-bridge-notice" data-tone={grokIsolationInstalled ? undefined : "warning"}>
          <Group gap="sm" wrap="nowrap" align="flex-start" style={{ flex: 1, minWidth: 0 }}>
            <Box style={{ color: grokIsolationInstalled ? "var(--success)" : "var(--warning)", marginTop: 2 }}>
              <ShieldAlert size={16} />
            </Box>
            <Stack gap={2}>
              <Text size="xs" fw={500} c="var(--on-surface)">
                {text("跨工具 Hook 隔离", "Cross-tool Hook Isolation")}
              </Text>
              <Text size="xs" c="var(--on-surface-variant)">
                {grokIsolationInstalled
                  ? text(
                      "已关闭 compat.claude.hooks 与 compat.cursor.hooks；卸载 Hook 时不会自动恢复。",
                      "compat.claude.hooks and compat.cursor.hooks are disabled; uninstall will not re-enable them.",
                    )
                  : text(
                      "安装 Grok Hook 后会写入 config.toml，禁止 Grok 读取 Claude/Cursor 的 hooks。",
                      "Installing Grok Hook writes config.toml so Grok no longer loads Claude/Cursor hooks.",
                    )}
              </Text>
            </Stack>
          </Group>
        </div>
      )}

      <div className="hook-bridge-well">
        <Group gap="xs" align="flex-end" wrap="wrap">
          <TextInput
            size="xs"
            style={{ flex: "1 1 240px", minWidth: 0 }}
            label={dirLabel}
            placeholder={dirPlaceholder}
            value={dirValue}
            onChange={(event) => onDirChange(event.currentTarget.value)}
            onBlur={(event) => onDirCommit(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onDirCommit(event.currentTarget.value);
            }}
            disabled={anyWorking}
          />
          <Button
            variant="light"
            color="cliPrimary"
            size="xs"
            onClick={onSelectDir}
            disabled={anyWorking}
            className="shrink-0"
          >
            {chooseDirLabel}
          </Button>
        </Group>

        <Group gap="xs">
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            onClick={() => setPathsOpen((prev) => !prev)}
            leftSection={pathsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          >
            {text("查看配置路径", "View Config Paths")}
          </Button>
          <Button
            variant="subtle"
            color="gray"
            size="xs"
            onClick={() => setInfoOpen((prev) => !prev)}
            leftSection={<HelpCircle size={14} />}
          >
            {text("安装说明", "Install Notes")}
          </Button>
        </Group>

        {pathsOpen && (
          <Stack gap="xs">
            {paths.map((item) => (
              <PathRow key={item.label} label={item.label} value={item.value} />
            ))}
          </Stack>
        )}

        {infoOpen && (
          <div className="hook-bridge-notice">
            <LegacyHookInstallNotes tool={tool} />
          </div>
        )}
      </div>

      <div className="hook-bridge-actions">
        <Button color="cliPrimary" size="xs" onClick={onInstall} disabled={installDisabled}>
          {working ? text("处理中...", "Processing...") : installLabel}
        </Button>
        <Button variant="light" color="red" size="xs" onClick={onUninstall} disabled={uninstallDisabled}>
          {uninstallLabel}
        </Button>
        <div className="hook-bridge-actions-trailing">
          <Button variant="default" color="gray" size="xs" onClick={onRefresh} disabled={anyWorking}>
            {loading ? text("刷新中...", "Refreshing...") : text("刷新状态", "Refresh Status")}
          </Button>
        </div>
      </div>
    </>
  );
}
