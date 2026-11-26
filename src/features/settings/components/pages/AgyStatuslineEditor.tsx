import { useCallback, useEffect, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ActionIcon, Badge, Button, Card, Checkbox, Group, Select, Stack, Switch, Text, TextInput } from "@mantine/core";
import { ArrowDown, ArrowUp } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../../../../shared/i18n/index";
import { getOsPlatform } from "../../../../shared/platform/shell";
import { useAppConfirm } from "../../../../shared/ui/useAppConfirm";
import { StatuslinePreview, type StatuslinePreviewState } from "./StatuslinePreview";

const ITEMS = ["model", "directory", "state", "context", "input", "output"] as const;
type Item = (typeof ITEMS)[number];
type Mode = "native" | "custom" | "stacked";
type Layout = { items: Item[]; color: boolean };
type Ownership = "native" | "managed" | "external" | "drifted";
interface Status {
  revision: string;
  path: string;
  ownership: Ownership;
  mode: Mode;
  command: string | null;
  profiles: Record<string, Layout>;
  selected: string | null;
  layout: Layout;
}
type LeaveGuard = RefObject<(() => boolean | Promise<boolean>) | null>;
type Change =
  | { action: "saveProfile"; name: string; layout: Layout }
  | { action: "selectProfile"; name: string }
  | { action: "apply"; mode: Mode; layout: Layout; confirmed: boolean }
  | { action: "restore" };
const DEFAULT: Layout = { items: [...ITEMS], color: true };
const CARD = "border border-border bg-surface-container-low";

function errorKey(error: unknown) {
  switch (String(error)) {
    case "agy_changed": case "agy_not_owned": case "agy_confirm_required": return "agyLine.conflict";
    case "agy_invalid_config": case "agy_invalid_library": case "agy_config_too_large": return "agyLine.invalid";
    case "agy_invalid_name": case "agy_profile_limit": return "agyLine.profileError";
    case "agy_wsl_unavailable": case "agy_invalid_distro": case "agy_invalid_path": return "agyLine.pathError";
    default: return "agyLine.error";
  }
}

// 发行版仅在用户主动请求时枚举；切换目标时重建编辑器，绝不沿用上一目标的快照或确认。
export function AgyStatuslineEditor({ leaveGuard }: { leaveGuard: LeaveGuard }) {
  const { t } = useI18n();
  const [windows, setWindows] = useState(false);
  const [distros, setDistros] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [environment, setEnvironment] = useState("local");
  useEffect(() => { void getOsPlatform().then((os) => setWindows(os === "windows")).catch(() => {}); }, []);
  const list = async () => {
    setLoading(true);
    try { setDistros(await invoke<string[]>("provider_wsl_list_distros")); }
    catch (error) { toast.error(t(errorKey(error))); }
    finally { setLoading(false); }
  };
  return <Stack gap="sm">
    {windows && <Card className={CARD}>
      <Group align="end">
        <Select label={t("agyLine.target")} value={environment} allowDeselect={false}
          onChange={async (value) => { if (value && (!leaveGuard.current || await leaveGuard.current())) setEnvironment(value); }}
          data={[{ value: "local", label: t("agyLine.local") }, ...(distros ?? []).map((name) => ({ value: `wsl:${name}`, label: `WSL · ${name}` }))]} />
        <Button variant="light" size="xs" loading={loading} onClick={() => void list()}>{t("agyLine.wsl")}</Button>
      </Group>
      {distros && <Text size="xs" c="dimmed" mt="xs">{t("agyLine.wslHelp")}</Text>}
    </Card>}
    <TargetEditor key={environment} leaveGuard={leaveGuard} distro={environment === "local" ? null : environment.slice(4)} />
  </Stack>;
}

function TargetEditor({ distro, leaveGuard }: { distro: string | null; leaveGuard: LeaveGuard }) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const [status, setStatus] = useState<Status | null>(null);
  const [reload, setReload] = useState(0);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [layout, setLayout] = useState<Layout>(DEFAULT);
  const [baseline, setBaseline] = useState<Layout>(DEFAULT);
  const [mode, setMode] = useState<Mode>("custom");
  const [name, setName] = useState("");
  const [profile, setProfile] = useState<string | null>(null);
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState(false);
  const [state, setState] = useState<StatuslinePreviewState>({ themeId: "", width: 100 });
  const dirty = JSON.stringify(layout) !== JSON.stringify(baseline);

  // 只读打开；晚到的发行版/刷新结果不能重置当前草稿。
  useEffect(() => {
    let live = true;
    setStatus(null); setLoadError(null);
    void invoke<Status>("agy_statusline_load", { distro }).then((result) => {
      if (!live) return;
      setStatus(result); setLayout(result.layout); setBaseline(result.layout); setMode(result.mode);
      setName(result.selected ?? ""); setProfile(result.selected);
    }).catch((error: unknown) => { if (live) setLoadError(error); });
    return () => { live = false; };
  }, [distro, reload]);

  // 预览 IPC 没有命令、目标目录或真实会话参数，后端仅用固定样例；丢弃旧布局的迟到结果。
  useEffect(() => {
    let live = true;
    void invoke<string>("agy_statusline_preview", { layout, width: state.width }).then((text) => {
      if (live) { setPreview(text); setPreviewError(false); }
    }).catch(() => { if (live) { setPreview(""); setPreviewError(true); } });
    return () => { live = false; };
  }, [layout, state.width]);

  // 保存只是保存方案；显式应用/恢复才触碰 agy 配置，接口总是带确认时的版本。
  const mutate = async (op: Change) => {
    if (!status || busy) return;
    setBusy(true);
    try {
      const next = await invoke<Status>("agy_statusline_change", { distro, revision: status.revision, op });
      setStatus(next);
      if (op.action === "saveProfile" || op.action === "selectProfile") {
        setProfile(next.selected); setName(next.selected ?? ""); setBaseline(next.layout);
        if (op.action === "selectProfile") setLayout(next.layout);
      } else { setMode(next.mode); }
      if (op.action !== "selectProfile") toast.success(t(op.action === "saveProfile" ? "agyLine.saved" : op.action === "apply" ? "agyLine.applied" : "agyLine.restored"));
    } catch (error) { toast.error(t(errorKey(error))); }
    finally { setBusy(false); }
  };
  const apply = async () => {
    if (!status) return;
    const foreign = status.ownership === "external" || status.ownership === "drifted";
    if (foreign && !await confirm({ title: t("agyLine.confirm"), message: t("agyLine.confirmBody"), danger: true })) return;
    await mutate({ action: "apply", mode, layout, confirmed: foreign });
  };
  const save = async () => {
    if (!status) return;
    if (Object.prototype.hasOwnProperty.call(status.profiles, name.trim()) && !await confirm({ title: t("agyLine.overwrite") })) return;
    await mutate({ action: "saveProfile", name: name.trim(), layout });
  };
  // 切换方案和刷新仅在用户允许丢弃修改后替换草稿，不隐式应用。
  const canDiscard = useCallback(() => !busy && (!dirty || confirm({ title: t("agyLine.discard"), danger: true })), [busy, dirty, confirm, t]);
  useEffect(() => {
    leaveGuard.current = canDiscard;
    return () => { leaveGuard.current = null; };
  }, [leaveGuard, canDiscard]);
  const select = async (value: string | null) => {
    if (!value || !status || !Object.prototype.hasOwnProperty.call(status.profiles, value) || !await canDiscard()) return;
    await mutate({ action: "selectProfile", name: value });
  };
  const shift = (index: number, direction: -1 | 1) => {
    const items = [...layout.items];
    const next = index + direction;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    setLayout({ ...layout, items });
  };
  const ordered = [...layout.items, ...ITEMS.filter((item) => !layout.items.includes(item))];
  return <Stack gap="sm">
    <Card className={CARD}>
      <Group justify="space-between" align="start">
        <Stack gap={2}>
          <Text fw={600}>{t("agyLine.title")}</Text>
          {status && <><Text size="xs" c="dimmed" style={{ overflowWrap: "anywhere" }}>{status.path}</Text>
            <Text size="sm">{t("agyLine.live")}: {t(`agyLine.${status.mode}`)}</Text>
            <Badge variant="light" color={status.ownership === "managed" ? "teal" : "gray"}>{t(`agyLine.ownership.${status.ownership}`)}</Badge></>}
        </Stack>
        <Button size="xs" variant="subtle" disabled={busy} onClick={async () => { if (await canDiscard()) setReload((v) => v + 1); }}>{t("agyLine.refresh")}</Button>
      </Group>
      {status?.command && <Text size="xs" mt="xs" style={{ overflowWrap: "anywhere" }}>{t("agyLine.command")}: <code>{status.command}</code></Text>}
      {loadError != null && <Text size="sm" c="red" role="alert">{t(errorKey(loadError))}</Text>}
    </Card>
    <Text size="sm" c="dimmed">{t("agyLine.sample")}</Text>
    <StatuslinePreview text={preview} state={state} onChange={setState} emptyText={t(previewError ? "settings.statusline.previewFailed" : "settings.statusline.previewEmpty")} ariaLabel={t("agyLine.title")} />
    <Card className={CARD}><Stack gap="sm">
      <Group align="end">
        <Select label={t("agyLine.profile")} value={profile} disabled={busy || !status} data={Object.keys(status?.profiles ?? {})}
          allowDeselect={false} onChange={(value) => void select(value)} />
        <TextInput label={t("agyLine.name")} value={name} maxLength={80} onChange={(event) => setName(event.currentTarget.value)} />
        <Button size="xs" variant="light" disabled={!status || busy || !name.trim()} onClick={() => void save()}>{t("agyLine.save")}</Button>
        {dirty && <Badge variant="light">{t("agyLine.dirty")}</Badge>}
      </Group>
      <Text fw={600} size="sm">{t("agyLine.items")}</Text>
      {ordered.map((item) => {
        const idx = layout.items.indexOf(item);
        return <Group key={item} justify="space-between">
          <Checkbox label={t(`agyLine.${item}`)} checked={idx >= 0} onChange={() => setLayout({ ...layout, items: idx < 0 ? [...layout.items, item] : layout.items.filter((i) => i !== item) })} />
          {idx >= 0 && <Group gap={4}>
            <ActionIcon variant="subtle" disabled={idx === 0} aria-label={`${t("agyLine.up")} · ${t(`agyLine.${item}`)}`} onClick={() => shift(idx, -1)}><ArrowUp size={16} /></ActionIcon>
            <ActionIcon variant="subtle" disabled={idx + 1 === layout.items.length} aria-label={`${t("agyLine.down")} · ${t(`agyLine.${item}`)}`} onClick={() => shift(idx, 1)}><ArrowDown size={16} /></ActionIcon>
          </Group>}
        </Group>;
      })}
      <Switch label={t("agyLine.color")} checked={layout.color} onChange={(event) => setLayout({ ...layout, color: event.currentTarget.checked })} />
      <Group align="end">
        <Select label={t("agyLine.mode")} value={mode} allowDeselect={false} data={(["native", "custom", "stacked"] as const).map((value) => ({ value, label: t(`agyLine.${value}`) }))}
          onChange={(value) => { if (value === "native" || value === "custom" || value === "stacked") setMode(value); }} />
        <Button disabled={!status || busy} onClick={() => void apply()}>{t("agyLine.apply")}</Button>
        <Button variant="light" disabled={status?.ownership !== "managed" || busy} onClick={() => void mutate({ action: "restore" })}>{t("agyLine.restore")}</Button>
      </Group>
    </Stack></Card>
    {confirmDialog}
  </Stack>;
}
