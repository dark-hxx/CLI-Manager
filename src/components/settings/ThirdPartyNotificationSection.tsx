import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Divider,
  Group,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from "@mantine/core";
import {
  BellRing,
  Bot,
  ChevronDown,
  MessageCircle,
  Plus,
  Send,
  Smartphone,
  Trash2,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { pickByLanguage, useI18n, type AppLanguage } from "@/lib/i18n";
import {
  createThirdPartyHookTarget,
  PROVIDER_NAMES,
  THIRD_PARTY_HOOK_TARGET_LIMIT,
  THIRD_PARTY_NOTIFICATION_PROVIDERS,
  type ThirdPartyHookTarget,
  type ThirdPartyNotificationProvider,
} from "@/lib/thirdPartyNotifications";
import { useSettingsStore, type HookEventType } from "@/stores/settingsStore";

interface TestSendResult {
  accepted: boolean;
  provider: string;
  targetId: string;
  elapsedMs: number;
  httpStatus?: number | null;
  code?: string | null;
  message?: string | null;
  deliveryId?: string | null;
  errorCode?: string | null;
}

type FieldKind = "text" | "secret" | "number" | "csv" | "numberCsv" | "select";

interface ConfigField {
  key: string;
  kind: FieldKind;
  labelZh: string;
  labelEn: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
}

const EVENT_LABELS: Record<HookEventType, { zh: string; en: string }> = {
  SessionStart: { zh: "会话开始", en: "Session Start" },
  UserPromptSubmit: { zh: "提交请求", en: "Prompt Submit" },
  Notification: { zh: "需要关注", en: "Attention" },
  Stop: { zh: "任务完成", en: "Finished" },
  StopFailure: { zh: "任务失败", en: "Failed" },
  PermissionRequest: { zh: "待审批", en: "Approval" },
};

const EVENT_KEYS: HookEventType[] = [
  "SessionStart",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "StopFailure",
  "PermissionRequest",
];

const FIELD_SCHEMAS: Record<ThirdPartyNotificationProvider, ConfigField[]> = {
  dingtalk: [
    { key: "webhookUrl", kind: "secret", labelZh: "Webhook 地址", labelEn: "Webhook URL" },
    { key: "secret", kind: "secret", labelZh: "签名 Secret（可选）", labelEn: "Signing Secret (optional)" },
  ],
  feishu: [
    { key: "webhookUrl", kind: "secret", labelZh: "Webhook 地址", labelEn: "Webhook URL" },
    { key: "secret", kind: "secret", labelZh: "签名 Secret（可选）", labelEn: "Signing Secret (optional)" },
  ],
  wecom: [
    { key: "webhookUrl", kind: "secret", labelZh: "Webhook 地址", labelEn: "Webhook URL" },
  ],
  bark: [
    { key: "serverUrl", kind: "text", labelZh: "服务地址", labelEn: "Server URL", placeholder: "https://api.day.app" },
    { key: "deviceKey", kind: "secret", labelZh: "Device Key", labelEn: "Device Key" },
    { key: "group", kind: "text", labelZh: "分组（可选）", labelEn: "Group (optional)" },
    { key: "sound", kind: "text", labelZh: "声音（可选）", labelEn: "Sound (optional)" },
    { key: "level", kind: "text", labelZh: "级别（可选）", labelEn: "Level (optional)" },
  ],
  pushplus: [
    { key: "token", kind: "secret", labelZh: "Token", labelEn: "Token" },
    { key: "template", kind: "text", labelZh: "模板（可选）", labelEn: "Template (optional)" },
    { key: "channel", kind: "text", labelZh: "渠道（可选）", labelEn: "Channel (optional)" },
    { key: "topic", kind: "text", labelZh: "群组编码（可选）", labelEn: "Topic (optional)" },
  ],
  wxpusher: [
    { key: "spt", kind: "secret", labelZh: "SPT（推荐，和 AppToken 二选一）", labelEn: "SPT (recommended)" },
    { key: "appToken", kind: "secret", labelZh: "AppToken（可选）", labelEn: "AppToken (optional)" },
    { key: "uids", kind: "csv", labelZh: "UID 列表（逗号分隔）", labelEn: "UIDs (comma separated)" },
    { key: "topicIds", kind: "numberCsv", labelZh: "Topic ID 列表（逗号分隔）", labelEn: "Topic IDs (comma separated)" },
  ],
  serverchan: [
    { key: "sendKey", kind: "secret", labelZh: "SendKey", labelEn: "SendKey" },
  ],
  telegram: [
    { key: "botToken", kind: "secret", labelZh: "Bot Token", labelEn: "Bot Token" },
    { key: "chatId", kind: "text", labelZh: "Chat ID", labelEn: "Chat ID" },
    { key: "messageThreadId", kind: "number", labelZh: "Thread ID（可选）", labelEn: "Thread ID (optional)" },
  ],
  ntfy: [
    { key: "serverUrl", kind: "text", labelZh: "服务地址", labelEn: "Server URL", placeholder: "https://ntfy.sh" },
    { key: "topic", kind: "secret", labelZh: "Topic", labelEn: "Topic" },
    {
      key: "authType",
      kind: "select",
      labelZh: "认证方式",
      labelEn: "Auth Type",
      options: [
        { value: "none", label: "None" },
        { value: "bearer", label: "Bearer" },
        { value: "basic", label: "Basic" },
      ],
    },
    { key: "authToken", kind: "secret", labelZh: "Bearer Token（可选）", labelEn: "Bearer Token (optional)" },
    { key: "basicUsername", kind: "text", labelZh: "Basic 用户名（可选）", labelEn: "Basic Username (optional)" },
    { key: "basicPassword", kind: "secret", labelZh: "Basic 密码（可选）", labelEn: "Basic Password (optional)" },
    { key: "priority", kind: "text", labelZh: "优先级（可选）", labelEn: "Priority (optional)" },
    { key: "tags", kind: "text", labelZh: "标签（可选）", labelEn: "Tags (optional)" },
  ],
  gotify: [
    { key: "serverUrl", kind: "text", labelZh: "服务地址", labelEn: "Server URL" },
    { key: "appToken", kind: "secret", labelZh: "App Token", labelEn: "App Token" },
    { key: "priority", kind: "number", labelZh: "优先级（可选）", labelEn: "Priority (optional)" },
  ],
  custom: [
    {
      key: "method",
      kind: "select",
      labelZh: "请求方法",
      labelEn: "Method",
      options: [
        { value: "POST", label: "POST" },
        { value: "GET", label: "GET" },
      ],
    },
    { key: "url", kind: "secret", labelZh: "URL", labelEn: "URL" },
    {
      key: "bodyType",
      kind: "select",
      labelZh: "Body 类型",
      labelEn: "Body Type",
      options: [
        { value: "json", label: "JSON" },
        { value: "form", label: "Form" },
        { value: "text", label: "Text" },
      ],
    },
  ],
};

const PROVIDER_ICON_META: Record<ThirdPartyNotificationProvider, {
  color: string;
  bg: string;
  text?: string;
  icon?: LucideIcon;
}> = {
  dingtalk: { color: "#1476ff", bg: "rgba(20, 118, 255, 0.12)", text: "钉" },
  feishu: { color: "#00a6ff", bg: "rgba(0, 166, 255, 0.12)", text: "飞" },
  wecom: { color: "#1aad19", bg: "rgba(26, 173, 25, 0.12)", text: "企" },
  bark: { color: "#ff8a00", bg: "rgba(255, 138, 0, 0.12)", icon: Smartphone },
  pushplus: { color: "#20b26b", bg: "rgba(32, 178, 107, 0.12)", text: "P+" },
  wxpusher: { color: "#07c160", bg: "rgba(7, 193, 96, 0.12)", text: "Wx" },
  serverchan: { color: "#2f80ed", bg: "rgba(47, 128, 237, 0.12)", icon: Bot },
  telegram: { color: "#229ed9", bg: "rgba(34, 158, 217, 0.12)", icon: Send },
  ntfy: { color: "#6c47ff", bg: "rgba(108, 71, 255, 0.12)", icon: BellRing },
  gotify: { color: "#4f46e5", bg: "rgba(79, 70, 229, 0.12)", icon: MessageCircle },
  custom: { color: "#64748b", bg: "rgba(100, 116, 139, 0.14)", icon: Webhook },
};

function pick(language: AppLanguage, zh: string, en: string) {
  return pickByLanguage(language, zh, en);
}

function PlatformIcon({ provider, size = 20 }: { provider: ThirdPartyNotificationProvider; size?: number }) {
  const meta = PROVIDER_ICON_META[provider];
  const Icon = meta.icon;
  const fontSize = size <= 18 ? 9 : 10;
  return (
    <Box
      aria-hidden="true"
      className="inline-flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        color: meta.color,
        backgroundColor: meta.bg,
      }}
    >
      {Icon ? (
        <Icon size={Math.max(12, size - 8)} strokeWidth={2} />
      ) : (
        <Text size="xs" fw={700} lh={1} style={{ color: meta.color, fontSize }}>
          {meta.text}
        </Text>
      )}
    </Box>
  );
}

function ProviderOption({ provider }: { provider: ThirdPartyNotificationProvider }) {
  return (
    <Group gap="xs" wrap="nowrap">
      <PlatformIcon provider={provider} />
      <Text size="sm">{PROVIDER_NAMES[provider]}</Text>
    </Group>
  );
}

function configText(config: Record<string, unknown>, key: string): string {
  const value = config[key];
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return String(value);
  return typeof value === "string" ? value : "";
}

function pairLines(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (typeof item !== "object" || item === null) return "";
      const raw = item as Record<string, unknown>;
      const key = typeof raw.key === "string" ? raw.key : "";
      const val = typeof raw.value === "string" ? raw.value : "";
      return key ? `${key}=${val}` : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parsePairs(value: string): { key: string; value: string }[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      return index >= 0
        ? { key: line.slice(0, index).trim(), value: line.slice(index + 1).trim() }
        : { key: line, value: "" };
    })
    .filter((item) => item.key);
}

function parseFieldValue(kind: FieldKind, value: string): unknown {
  if (kind === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }
  if (kind === "csv") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  if (kind === "numberCsv") {
    return value
      .split(",")
      .map((item) => Number(item.trim()))
      .filter((item) => Number.isFinite(item));
  }
  return value;
}

function targetSummary(target: ThirdPartyHookTarget, language: AppLanguage): string {
  const enabledEvents = EVENT_KEYS.filter((event) => target.events[event])
    .map((event) => pick(language, EVENT_LABELS[event].zh, EVENT_LABELS[event].en));
  return enabledEvents.length
    ? enabledEvents.join(" / ")
    : pick(language, "未选择事件", "No event selected");
}

export function ThirdPartyNotificationSection({ embedded = false }: { embedded?: boolean }) {
  const { language } = useI18n();
  const enabled = useSettingsStore((s) => s.thirdPartyHookNotificationsEnabled);
  const targets = useSettingsStore((s) => s.thirdPartyHookTargets);
  const updateSetting = useSettingsStore((s) => s.update);
  const [providerToAdd, setProviderToAdd] = useState<ThirdPartyNotificationProvider>("dingtalk");
  const [testingId, setTestingId] = useState<string | null>(null);
  const [expandedTargetIds, setExpandedTargetIds] = useState<Set<string>>(() => new Set());

  const providerOptions = useMemo(
    () => THIRD_PARTY_NOTIFICATION_PROVIDERS.map((provider) => ({ value: provider, label: PROVIDER_NAMES[provider] })),
    []
  );

  const saveTargets = (next: ThirdPartyHookTarget[]) => {
    void updateSetting("thirdPartyHookTargets", next);
  };

  const updateTarget = (id: string, patch: Partial<ThirdPartyHookTarget>) => {
    saveTargets(targets.map((target) => target.id === id ? { ...target, ...patch } : target));
  };

  const updateConfig = (target: ThirdPartyHookTarget, key: string, value: unknown) => {
    updateTarget(target.id, { config: { ...target.config, [key]: value } });
  };

  const addTarget = () => {
    if (targets.length >= THIRD_PARTY_HOOK_TARGET_LIMIT) {
      toast.warning(pick(language, "最多只能配置 20 个通知目标", "Up to 20 targets are supported"));
      return;
    }
    saveTargets([...targets, createThirdPartyHookTarget(providerToAdd)]);
  };

  const deleteTarget = (id: string) => {
    saveTargets(targets.filter((target) => target.id !== id));
    setExpandedTargetIds((current) => {
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const toggleTargetExpanded = (id: string) => {
    setExpandedTargetIds((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const testTarget = async (target: ThirdPartyHookTarget) => {
    setTestingId(target.id);
    try {
      const result = await invoke<TestSendResult>("third_party_notification_test_send", { target });
      if (result.accepted) {
        toast.success(pick(language, "测试发送成功", "Test sent"), {
          description: `${PROVIDER_NAMES[target.provider]} · ${result.elapsedMs}ms`,
        });
      } else {
        toast.error(pick(language, "测试发送失败", "Test failed"), {
          description: result.message ?? result.errorCode ?? "unknown_error",
        });
      }
    } catch (error) {
      toast.error(pick(language, "测试发送失败", "Test failed"), { description: String(error) });
    } finally {
      setTestingId(null);
    }
  };

  const content = (
    <Stack gap="md">
        <Group justify="space-between" align="flex-start" gap="md">
          <Group gap="sm" wrap="nowrap" className="min-w-0">
            <Box style={{ color: "var(--primary)", marginTop: 2 }}>
              <BellRing size={18} />
            </Box>
            <Box className="min-w-0">
              <Text size="sm" fw={600} c="var(--on-surface)">
                {pick(language, "三方 Hook 通知", "Third-party Hook Notifications")}
              </Text>
              <Text mt={4} size="xs" c="var(--on-surface-variant)">
                {pick(language, "CLI-Manager 收到 Hook 后异步批量通知外部平台；只发送摘要和事件图标，不发送 Prompt、终端输出或绝对路径。", "CLI-Manager fans out safe summaries asynchronously after receiving Hook events; prompts, terminal output, and absolute paths are not sent.")}
              </Text>
            </Box>
          </Group>
          <Group gap="xs" wrap="nowrap">
            <Badge variant="light" color={enabled ? "green" : "gray"} radius="xl">
              {enabled ? pick(language, "已启用", "Enabled") : pick(language, "已暂停", "Paused")}
            </Badge>
            <Badge variant="light" color="blue" radius="xl">
              {targets.length}/{THIRD_PARTY_HOOK_TARGET_LIMIT}
            </Badge>
            <Switch
              color="cliPrimary"
              checked={enabled}
              onChange={(event) => void updateSetting("thirdPartyHookNotificationsEnabled", event.currentTarget.checked)}
              aria-label={pick(language, "启用三方 Hook 通知", "Enable third-party Hook notifications")}
            />
          </Group>
        </Group>

        {!enabled && (
          <Card className="border border-border bg-surface-container-low" p="sm" radius="lg">
            <Text size="xs" c="var(--on-surface-variant)">
              {pick(language, "当前已暂停自动派发。已有通知目标和凭证会保留，需要时打开右上角开关即可恢复。", "Automatic delivery is paused. Targets and secrets are kept; turn on the switch to resume.")}
            </Text>
          </Card>
        )}

        <Group gap="xs" align="flex-end">
          <Select
            size="xs"
            label={pick(language, "通知方式", "Provider")}
            data={providerOptions}
            value={providerToAdd}
            leftSection={<PlatformIcon provider={providerToAdd} size={18} />}
            renderOption={({ option }) => (
              <ProviderOption provider={option.value as ThirdPartyNotificationProvider} />
            )}
            onChange={(value) => {
              if (value && THIRD_PARTY_NOTIFICATION_PROVIDERS.includes(value as ThirdPartyNotificationProvider)) {
                setProviderToAdd(value as ThirdPartyNotificationProvider);
              }
            }}
            className="min-w-[180px]"
          />
          <Button size="xs" leftSection={<Plus size={14} />} onClick={addTarget}>
            {pick(language, "新增通知目标", "Add Target")}
          </Button>
        </Group>

        <Text size="xs" c="var(--warning)">
          {pick(language, "凭证会随现有 settings.json 明文保存；界面遮罩只防止旁观，不等于加密。", "Secrets are stored in the existing settings.json; masking in the UI is not encryption.")}
        </Text>

        {targets.length === 0 ? (
          <Card className="border border-dashed border-border bg-surface-container-low" p="md" radius="lg">
            <Text size="xs" c="var(--on-surface-variant)">
              {pick(language, "暂无第三方通知目标。", "No third-party notification targets yet.")}
            </Text>
          </Card>
        ) : (
          <Stack gap="sm">
            {targets.map((target) => {
              const expanded = expandedTargetIds.has(target.id);
              return (
              <Card key={target.id} className="border border-border bg-surface-container-low" p="md" radius="lg">
                <Stack gap="sm">
                  <Group justify="space-between" align="flex-start" gap="md">
                    <Group gap="sm" className="min-w-0">
                      <Switch
                        checked={target.enabled}
                        onChange={(event) => updateTarget(target.id, { enabled: event.currentTarget.checked })}
                        aria-label={pick(language, "启用通知目标", "Enable target")}
                      />
                      <Box className="min-w-0">
                        <Group gap="xs">
                          <PlatformIcon provider={target.provider} size={18} />
                          <Text size="sm" fw={600} c="var(--on-surface)">
                            {target.name}
                          </Text>
                          <Badge size="xs" variant="light">{PROVIDER_NAMES[target.provider]}</Badge>
                        </Group>
                        <Text size="xs" c="var(--on-surface-variant)">
                          {targetSummary(target, language)}
                        </Text>
                      </Box>
                    </Group>
                    <Group gap={4}>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="gray"
                        onClick={() => toggleTargetExpanded(target.id)}
                        aria-label={expanded ? pick(language, "收起通知目标", "Collapse target") : pick(language, "展开通知目标", "Expand target")}
                      >
                        <ChevronDown
                          size={14}
                          className={`transition-transform ${expanded ? "rotate-180" : ""}`}
                        />
                      </ActionIcon>
                      <Button
                        size="compact-xs"
                        variant="light"
                        leftSection={<Send size={13} />}
                        loading={testingId === target.id}
                        onClick={() => void testTarget(target)}
                      >
                        {pick(language, "测试", "Test")}
                      </Button>
                      <ActionIcon
                        size="sm"
                        variant="subtle"
                        color="red"
                        onClick={() => deleteTarget(target.id)}
                        aria-label={pick(language, "删除通知目标", "Delete target")}
                      >
                        <Trash2 size={14} />
                      </ActionIcon>
                    </Group>
                  </Group>

                  {expanded && (
                    <>
                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                    <TextInput
                      size="xs"
                      label={pick(language, "名称", "Name")}
                      value={target.name}
                      onChange={(event) => updateTarget(target.id, { name: event.currentTarget.value })}
                    />
                    <Select
                      size="xs"
                      label={pick(language, "平台", "Provider")}
                      data={providerOptions}
                      value={target.provider}
                      leftSection={<PlatformIcon provider={target.provider} size={18} />}
                      renderOption={({ option }) => (
                        <ProviderOption provider={option.value as ThirdPartyNotificationProvider} />
                      )}
                      onChange={(value) => {
                        if (!value || !THIRD_PARTY_NOTIFICATION_PROVIDERS.includes(value as ThirdPartyNotificationProvider)) return;
                        const next = createThirdPartyHookTarget(value as ThirdPartyNotificationProvider);
                        updateTarget(target.id, {
                          provider: next.provider,
                          name: next.name,
                          config: next.config,
                        });
                      }}
                    />
                  </SimpleGrid>

                  <Group gap="xs">
                    {EVENT_KEYS.map((event) => (
                      <Checkbox
                        key={event}
                        size="xs"
                        checked={target.events[event]}
                        label={pick(language, EVENT_LABELS[event].zh, EVENT_LABELS[event].en)}
                        onChange={(change) => updateTarget(target.id, {
                          events: { ...target.events, [event]: change.currentTarget.checked },
                        })}
                      />
                    ))}
                  </Group>

                  <Divider />

                  <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                    {FIELD_SCHEMAS[target.provider].map((field) => (
                      field.kind === "secret" ? (
                        <PasswordInput
                          key={field.key}
                          size="xs"
                          label={pick(language, field.labelZh, field.labelEn)}
                          placeholder={field.placeholder}
                          value={configText(target.config, field.key)}
                          onChange={(event) => updateConfig(target, field.key, event.currentTarget.value)}
                        />
                      ) : field.kind === "select" ? (
                        <Select
                          key={field.key}
                          size="xs"
                          label={pick(language, field.labelZh, field.labelEn)}
                          data={field.options ?? []}
                          value={configText(target.config, field.key)}
                          onChange={(value) => updateConfig(target, field.key, value ?? "")}
                        />
                      ) : (
                        <TextInput
                          key={field.key}
                          size="xs"
                          label={pick(language, field.labelZh, field.labelEn)}
                          placeholder={field.placeholder}
                          value={configText(target.config, field.key)}
                          onChange={(event) => updateConfig(
                            target,
                            field.key,
                            parseFieldValue(field.kind, event.currentTarget.value)
                          )}
                        />
                      )
                    ))}
                  </SimpleGrid>

                  {target.provider === "custom" && (
                    <Stack gap="sm">
                      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
                        <Textarea
                          size="xs"
                          minRows={3}
                          label={pick(language, "Query 参数（每行 key=value）", "Query params (key=value per line)")}
                          value={pairLines(target.config.query)}
                          onChange={(event) => updateConfig(target, "query", parsePairs(event.currentTarget.value))}
                        />
                        <Textarea
                          size="xs"
                          minRows={3}
                          label={pick(language, "Headers（每行 key=value）", "Headers (key=value per line)")}
                          value={pairLines(target.config.headers)}
                          onChange={(event) => updateConfig(target, "headers", parsePairs(event.currentTarget.value))}
                        />
                      </SimpleGrid>
                      {target.config.bodyType === "form" ? (
                        <Textarea
                          size="xs"
                          minRows={3}
                          label={pick(language, "Form Body（每行 key=value）", "Form Body (key=value per line)")}
                          value={pairLines(target.config.formBody)}
                          onChange={(event) => updateConfig(target, "formBody", parsePairs(event.currentTarget.value))}
                        />
                      ) : target.config.bodyType === "text" ? (
                        <Textarea
                          size="xs"
                          minRows={3}
                          label={pick(language, "Text Body", "Text Body")}
                          value={typeof target.config.textBody === "string" ? target.config.textBody : "{{body}}"}
                          onChange={(event) => updateConfig(target, "textBody", event.currentTarget.value)}
                        />
                      ) : (
                        <Textarea
                          size="xs"
                          minRows={5}
                          label={pick(language, "JSON Body", "JSON Body")}
                          value={JSON.stringify(target.config.jsonBody ?? { title: "{{title}}", body: "{{body}}" }, null, 2)}
                          onChange={(event) => {
                            try {
                              updateConfig(target, "jsonBody", JSON.parse(event.currentTarget.value));
                            } catch {
                              updateConfig(target, "jsonBody", event.currentTarget.value);
                            }
                          }}
                        />
                      )}
                      <Text size="xs" c="var(--on-surface-variant)">
                        {pick(language, "可用变量：{{title}}、{{body}}、{{event}}、{{source}}、{{project}}、{{time}}、{{id}}。", "Variables: {{title}}, {{body}}, {{event}}, {{source}}, {{project}}, {{time}}, {{id}}.")}
                      </Text>
                    </Stack>
                  )}
                    </>
                  )}
                </Stack>
              </Card>
              );
            })}
          </Stack>
        )}
    </Stack>
  );

  if (embedded) {
    return content;
  }

  return (
    <section className="ui-surface-card rounded-2xl border border-border p-4">
      {content}
    </section>
  );
}
