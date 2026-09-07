import {
  Badge,
  Card,
  Group,
  Stack,
  Text,
} from "@mantine/core";
import { Check, Eye } from "lucide-react";
import { useAppConfirm } from "@/components/ui/useAppConfirm";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type { UseNativeProviderHomeResult } from "./useNativeProviderHome";
import type { NativeProviderGlobalCurrent } from "./nativeProviderTypes";
import { providerGlobalTargetRoot } from "./nativeProviderGlobalView";

type GlobalState = Pick<
  UseNativeProviderHomeResult,
  "current" | "preview" | "homeDraftDirty" | "loading" | "action" | "previewGlobal" | "applyGlobal"
>;

interface NativeProviderGlobalSectionProps {
  state: GlobalState;
  providerId: string | null;
  onGlobalApplied?: () => Promise<void>;
}

export function NativeProviderGlobalSection({
  state,
  providerId,
  onGlobalApplied,
}: NativeProviderGlobalSectionProps) {
  const { t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm({ zIndex: 220 });
  const busy = Boolean(state.action) || state.loading;
  const homeDraftDirty = state.homeDraftDirty;

  const applyGlobal = async () => {
    const preview = state.preview ?? await state.previewGlobal();
    if (!preview) return;
    const confirmed = await confirm({
      title: t("providerCatalog.global.confirmTitle"),
      message: t("providerCatalog.global.confirmMessage", {
        provider: preview.providerName,
        home: providerGlobalTargetRoot(preview),
      }),
      confirmText: t("providerCatalog.global.apply"),
      danger: true,
    });
    if (confirmed) {
      const result = await state.applyGlobal(preview);
      if (result) await onGlobalApplied?.();
    }
  };

  return (
    <>
      <Card withBorder radius="lg" padding="md" className="border-border/70 bg-surface-container-low">
        <Stack gap="sm">
          <Stack gap={2}>
            <Text fw={600}>{t("providerCatalog.global.title")}</Text>
            <Text size="xs" c="dimmed">{t("providerCatalog.global.description")}</Text>
            <Text size="xs" c="dimmed">{t("providerCatalog.activeKeyChanged")}</Text>
          </Stack>
          {state.current && <CurrentSummary current={state.current} />}
          <Group gap="xs" wrap="wrap" className="min-w-0">
            <Button
              size="sm"
              variant="light"
              color="cliPrimary"
              leftSection={<Eye size={15} />}
              className="shrink-0"
              loading={state.action === "preview-global"}
              disabled={busy || homeDraftDirty || !providerId}
              onClick={() => void state.previewGlobal()}
            >
              {t("providerCatalog.global.preview")}
            </Button>
            <Button
              size="sm"
              color="cliPrimary"
              leftSection={<Check size={15} />}
              className="shrink-0"
              loading={state.action === "apply-global"}
              disabled={busy || homeDraftDirty || !providerId}
              onClick={() => void applyGlobal().catch(() => undefined)}
            >
              {t("providerCatalog.global.apply")}
            </Button>
          </Group>
          {!providerId && <Text size="xs" c="dimmed">{t("providerCatalog.global.providerRequired")}</Text>}
          {homeDraftDirty && (
            <Text size="xs" c="yellow">{t("providerCatalog.global.saveHomeBeforeApply")}</Text>
          )}
          {state.preview && (
            <Stack gap="xs">
              <Text size="xs" c="dimmed">
                {t("providerCatalog.global.previewFingerprint", { fingerprint: state.preview.fingerprint })}
              </Text>
              {state.preview.targets.map((target) => (
                <Group key={target.target} justify="space-between" wrap="nowrap" className="rounded-md border border-border/50 px-2 py-1">
                  <Stack gap={0} miw={0}>
                    <Text size="sm" truncate>{target.target}</Text>
                    <Text size="xs" c="dimmed" truncate>{target.path}</Text>
                    <Text size="xs" c="dimmed" truncate>
                      {t("providerCatalog.global.liveFingerprint", { fingerprint: target.liveFingerprint })}
                    </Text>
                    <Text size="xs" c="dimmed" truncate>
                      {t("providerCatalog.global.desiredFingerprint", { fingerprint: target.desiredFingerprint })}
                    </Text>
                    <Text size="xs" c="dimmed" truncate title={target.ownedFields.join(", ")}>
                      {t("providerCatalog.global.ownedFields", { fields: target.ownedFields.join(", ") })}
                    </Text>
                  </Stack>
                  <Badge color={target.changed ? "yellow" : "green"}>
                    {target.changed
                      ? t(target.action === "create"
                        ? "providerCatalog.global.create"
                        : "providerCatalog.global.update")
                      : t("providerCatalog.global.unchanged")}
                  </Badge>
                </Group>
              ))}
            </Stack>
          )}
        </Stack>
      </Card>
      {confirmDialog}
    </>
  );
}

function CurrentSummary({ current }: { current: NativeProviderGlobalCurrent }) {
  const { t } = useI18n();
  const stateKey = currentStateKey(current.state);
  const changedTargets = current.targets.filter((target) => target.changed).length;
  return (
    <Group justify="space-between" align="center" wrap="nowrap" className="rounded-lg border border-border/60 bg-surface-container-lowest px-3 py-2">
      <Stack gap={1} miw={0}>
        <Text size="xs" c="dimmed">{t("providerCatalog.global.currentTitle")}</Text>
        <Text size="sm" fw={600} truncate>
          {current.providerName ?? t("providerCatalog.global.currentNotSet")}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {current.activeKeyPresent
            ? t("providerCatalog.global.currentKeyReady")
            : t("providerCatalog.global.currentKeyMissing")}
          {changedTargets > 0 && ` · ${t("providerCatalog.global.currentDriftCount", { count: changedTargets })}`}
        </Text>
      </Stack>
      <Badge color={currentStateColor(current.state)}>{t(stateKey)}</Badge>
    </Group>
  );
}

function currentStateKey(state: string): TranslationKey {
  switch (state) {
    case "applied": return "providerCatalog.global.currentApplied";
    case "drifted": return "providerCatalog.global.currentDrifted";
    case "key_missing": return "providerCatalog.global.currentKeyMissingState";
    case "recovery_pending": return "providerCatalog.global.currentRecoveryPending";
    case "unavailable": return "providerCatalog.global.currentUnavailable";
    default: return "providerCatalog.global.currentNotSet";
  }
}

function currentStateColor(state: string): string {
  switch (state) {
    case "applied": return "green";
    case "recovery_pending": return "red";
    case "drifted":
    case "key_missing": return "yellow";
    default: return "gray";
  }
}
