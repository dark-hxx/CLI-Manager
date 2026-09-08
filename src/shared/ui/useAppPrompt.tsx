import { Button, Group, Modal, Stack, TextInput } from "@mantine/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/index";

interface AppPromptOptions {
  title: string;
  initialValue?: string;
  placeholder?: string;
  allowEmpty?: boolean;
}

export function useAppPrompt() {
  const { t } = useI18n();
  const [request, setRequest] = useState<AppPromptOptions | null>(null);
  const [value, setValue] = useState("");
  const resolverRef = useRef<((result: string | null) => void) | null>(null);

  const close = useCallback((result: string | null) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setRequest(null);
    resolve?.(result);
  }, []);

  useEffect(() => () => {
    resolverRef.current?.(null);
    resolverRef.current = null;
  }, []);

  const prompt = useCallback((options: AppPromptOptions) => new Promise<string | null>((resolve) => {
    resolverRef.current?.(null);
    resolverRef.current = resolve;
    setValue(options.initialValue ?? "");
    setRequest(options);
  }), []);

  const trimmedValue = value.trim();
  const promptDialog = (
    <Modal
      opened={request !== null}
      onClose={() => close(null)}
      title={request?.title ?? ""}
      centered
      size="sm"
    >
      <form onSubmit={(event) => {
        event.preventDefault();
        if (trimmedValue || request?.allowEmpty) close(trimmedValue);
      }}>
        <Stack gap="md">
          <TextInput
            value={value}
            onChange={(event) => setValue(event.currentTarget.value)}
            placeholder={request?.placeholder}
            aria-label={request?.title}
            data-autofocus
          />
          <Group justify="flex-end">
            <Button type="button" variant="subtle" onClick={() => close(null)}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={!request?.allowEmpty && !trimmedValue}>
              {t("common.confirm")}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );

  return { prompt, promptDialog };
}
