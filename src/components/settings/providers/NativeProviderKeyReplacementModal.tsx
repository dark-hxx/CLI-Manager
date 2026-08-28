import { useEffect, useMemo, useState } from "react";
import { Alert, Group, Modal, Select, Stack, Text } from "@mantine/core";
import { AlertTriangle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";
import type { NativeProviderKeySummary } from "./nativeProviderTypes";

interface NativeProviderKeyReplacementModalProps {
  opened: boolean;
  activeKey: NativeProviderKeySummary | null;
  keys: NativeProviderKeySummary[];
  loading: boolean;
  onClose: () => void;
  onConfirm: (replacementKeyId: string) => Promise<void>;
}

export function NativeProviderKeyReplacementModal({
  opened,
  activeKey,
  keys,
  loading,
  onClose,
  onConfirm,
}: NativeProviderKeyReplacementModalProps) {
  const { t } = useI18n();
  const candidates = useMemo(
    () => keys.filter((key) => key.id !== activeKey?.id && key.enabled),
    [activeKey?.id, keys],
  );
  const [replacementKeyId, setReplacementKeyId] = useState<string | null>(null);

  useEffect(() => {
    if (opened) setReplacementKeyId(candidates[0]?.id ?? null);
  }, [candidates, opened]);

  if (!activeKey) return null;

  return (
    <Modal opened={opened} onClose={onClose} title={t("providerCatalog.replaceKeyTitle")} centered size="lg">
      <Stack gap="sm">
        <Text size="sm">{t("providerCatalog.replaceKeyMessage", { name: activeKey.label })}</Text>
        {candidates.length === 0 ? (
          <Alert color="yellow" variant="light" icon={<AlertTriangle size={16} />}>
            {t("providerCatalog.replaceKeyNoCandidates")}
          </Alert>
        ) : (
          <Select
            label={t("providerCatalog.replacementKeyLabel")}
            data={candidates.map((key) => ({ value: key.id, label: key.label }))}
            value={replacementKeyId}
            onChange={setReplacementKeyId}
            allowDeselect={false}
          />
        )}
        <Group justify="flex-end" mt="xs">
          <Button variant="subtle" color="gray" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            color="red"
            loading={loading}
            disabled={loading || !replacementKeyId || candidates.length === 0}
            onClick={() => replacementKeyId && void onConfirm(replacementKeyId).catch(() => undefined)}
          >
            {t("providerCatalog.replaceAndDelete")}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
