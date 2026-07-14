import { Button, Group, Menu, Select, Text } from "@mantine/core";
import { Copy, MoreHorizontal, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { StatuslineProfileState } from "@/lib/statuslineProfiles";
import { useI18n } from "@/lib/i18n";
import { useAppPrompt } from "@/components/ui/useAppPrompt";
import { useAppConfirm } from "@/components/ui/useAppConfirm";

interface Props<T> {
  state: StatuslineProfileState<T> | null;
  dirty: boolean;
  busy: boolean;
  onSave: () => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onSwitch: (profileId: string) => Promise<void>;
  onRename: (profileId: string, name: string) => Promise<void>;
  onDuplicate: (profileId: string, name: string) => Promise<void>;
  onDelete: (profileId: string) => Promise<void>;
  onCaptureExternal: (name: string) => Promise<void>;
}

export function StatuslineProfileBar<T>({
  state,
  dirty,
  busy,
  onSave,
  onCreate,
  onSwitch,
  onRename,
  onDuplicate,
  onDelete,
  onCaptureExternal,
}: Props<T>) {
  const { t } = useI18n();
  const { prompt, promptDialog } = useAppPrompt();
  const { confirm, confirmDialog } = useAppConfirm();
  const active = state?.profiles.find((profile) => profile.id === state.activeProfileId);
  const profileName = (name: string) => name === "__current__" ? t("settings.statuslineProfiles.current") : name;
  const run = (action: () => Promise<void>) => action().catch((error) => toast.error(t("settings.statuslineProfiles.operationFailed"), { description: String(error) }));

  return (
    <>
      <Group gap="xs" wrap="nowrap">
        <Select
          value={state?.activeProfileId ?? null}
          data={(state?.profiles ?? []).map((profile) => ({ value: profile.id, label: profileName(profile.name) }))}
          onChange={(value) => {
            if (!value || value === state?.activeProfileId) return;
            void (async () => {
              if (dirty && !(await confirm({
                title: t("settings.statuslineProfiles.discardConfirm"),
                danger: true,
              }))) return;
              await run(() => onSwitch(value));
            })();
          }}
          placeholder={t("settings.statuslineProfiles.loading")}
          disabled={!state || busy}
          w={220}
          searchable
          aria-label={t("settings.statuslineProfiles.select")}
        />
        <Button leftSection={<Save size={15} />} onClick={() => void run(onSave)} disabled={!dirty || busy || !state}>
          {t("settings.statuslineProfiles.save")}
        </Button>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button variant="light" px="xs" disabled={!state || busy} aria-label={t("settings.statuslineProfiles.actions")}>
              <MoreHorizontal size={16} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<Plus size={14} />} onClick={() => {
              void prompt({ title: t("settings.statuslineProfiles.createPrompt") }).then((name) => {
                if (name) void run(() => onCreate(name));
              });
            }}>{t("settings.statuslineProfiles.create")}</Menu.Item>
            <Menu.Item leftSection={<Copy size={14} />} onClick={() => {
              if (!active) return;
              void prompt({
                title: t("settings.statuslineProfiles.duplicatePrompt"),
                initialValue: `${profileName(active.name)} Copy`,
              }).then((name) => {
                if (name) void run(() => onDuplicate(active.id, name));
              });
            }}>{t("settings.statuslineProfiles.duplicate")}</Menu.Item>
            <Menu.Item onClick={() => {
              if (!active) return;
              void prompt({
                title: t("settings.statuslineProfiles.renamePrompt"),
                initialValue: profileName(active.name),
              }).then((name) => {
                if (name && name !== active.name) void run(() => onRename(active.id, name));
              });
            }}>{t("settings.statuslineProfiles.rename")}</Menu.Item>
            <Menu.Divider />
            <Menu.Item color="red" leftSection={<Trash2 size={14} />} disabled>
              {t("settings.statuslineProfiles.deleteActive")}
            </Menu.Item>
            {(state?.profiles ?? []).filter((profile) => profile.id !== state?.activeProfileId).map((profile) => (
              <Menu.Item key={profile.id} color="red" leftSection={<Trash2 size={14} />} onClick={() => {
                void confirm({
                  title: t("settings.statuslineProfiles.deleteConfirm").replace("{name}", profileName(profile.name)),
                  danger: true,
                }).then((confirmed) => {
                  if (confirmed) void run(() => onDelete(profile.id));
                });
              }}>
                {t("settings.statuslineProfiles.deleteNamed").replace("{name}", profileName(profile.name))}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>
      {state?.externalPayload != null && (
        <Group justify="space-between" mt="xs" p="xs" className="rounded-lg border border-[var(--warning)] bg-surface-container-lowest">
          <Text size="xs">{t("settings.statuslineProfiles.externalDetected")}</Text>
          <Button size="xs" variant="light" onClick={() => {
            void prompt({ title: t("settings.statuslineProfiles.externalPrompt") }).then((name) => {
              if (name) void run(() => onCaptureExternal(name));
            });
          }}>{t("settings.statuslineProfiles.saveExternal")}</Button>
        </Group>
      )}
      {promptDialog}
      {confirmDialog}
    </>
  );
}
