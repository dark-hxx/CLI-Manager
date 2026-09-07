import { Modal, Stack, Text, TextInput } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { NativeProviderButton as Button } from "./NativeProviderButton";

interface NativeProviderKeyRevealModalProps {
  opened: boolean;
  label: string;
  value: string;
  onClose: () => void;
}

export function NativeProviderKeyRevealModal({
  opened,
  label,
  value,
  onClose,
}: NativeProviderKeyRevealModalProps) {
  const { t } = useI18n();

  return (
    <Modal opened={opened} onClose={onClose} title={t("providerCatalog.revealKeyTitle", { name: label })} centered size="lg">
      <Stack gap="sm">
        <Text size="sm" c="dimmed">{t("providerCatalog.revealWarning")}</Text>
        <TextInput
          label={t("providerCatalog.revealedApiKeyLabel")}
          value={value}
          readOnly
          autoFocus
          styles={{ input: { fontFamily: "var(--font-mono, ui-monospace, monospace)" } }}
        />
        <Button variant="subtle" color="gray" onClick={onClose}>
          {t("common.close")}
        </Button>
      </Stack>
    </Modal>
  );
}
