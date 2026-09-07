import { Accordion, Alert, Stack, Switch, Text } from "@mantine/core";
import { BrainCircuit } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { UseNativeProviderRoutingResult } from "./useNativeProviderRouting";

interface NativeProviderRectifierSectionProps {
  state: UseNativeProviderRoutingResult;
}

export function NativeProviderRectifierSection({ state }: NativeProviderRectifierSectionProps) {
  const { t } = useI18n();
  const rectifier = state.rectifierConfig;
  const optimizer = state.optimizerConfig;
  const routeEnabled = state.state?.persisted.service.serviceEnabled ?? false;
  const busy = Boolean(state.action);

  return (
    <Accordion.Item value="rectifier">
      <Accordion.Control icon={<BrainCircuit size={16} />}>
        {t("providerCatalog.routing.rectifier.title")}
      </Accordion.Control>
      <Accordion.Panel>
        <Stack gap="sm">
          <Text size="sm" c="dimmed">
            {t("providerCatalog.routing.rectifier.description")}
          </Text>
          <Alert color={routeEnabled ? "blue" : "gray"} variant="light">
            {t(routeEnabled
              ? "providerCatalog.routing.rectifier.routeEnabled"
              : "providerCatalog.routing.rectifier.routeDisabled")}
          </Alert>
          <Switch
            label={t("providerCatalog.routing.rectifier.enabled")}
            description={t("providerCatalog.routing.rectifier.enabledDescription")}
            checked={rectifier?.enabled ?? false}
            disabled={!rectifier || busy}
            onChange={(event) => rectifier && void state.setRectifierConfig({
              ...rectifier,
              enabled: event.currentTarget.checked,
            })}
          />
          <Switch
            label={t("providerCatalog.routing.rectifier.thinkingSignature")}
            checked={rectifier?.requestThinkingSignature ?? false}
            disabled={!rectifier || busy}
            onChange={(event) => rectifier && void state.setRectifierConfig({
              ...rectifier,
              requestThinkingSignature: event.currentTarget.checked,
            })}
          />
          <Switch
            label={t("providerCatalog.routing.rectifier.thinkingBudget")}
            checked={rectifier?.requestThinkingBudget ?? false}
            disabled={!rectifier || busy}
            onChange={(event) => rectifier && void state.setRectifierConfig({
              ...rectifier,
              requestThinkingBudget: event.currentTarget.checked,
            })}
          />
          <Switch
            label={t("providerCatalog.routing.rectifier.mediaFallback")}
            checked={rectifier?.requestMediaFallback ?? false}
            disabled={!rectifier || busy}
            onChange={(event) => rectifier && void state.setRectifierConfig({
              ...rectifier,
              requestMediaFallback: event.currentTarget.checked,
            })}
          />
          <Switch
            label={t("providerCatalog.routing.rectifier.mediaHeuristic")}
            description={t("providerCatalog.routing.rectifier.mediaHeuristicDescription")}
            checked={rectifier?.requestMediaHeuristic ?? false}
            disabled={!rectifier || busy}
            onChange={(event) => rectifier && void state.setRectifierConfig({
              ...rectifier,
              requestMediaHeuristic: event.currentTarget.checked,
            })}
          />

          <Text fw={600} size="sm" mt="xs">
            {t("providerCatalog.routing.optimizer.title")}
          </Text>
          <Text size="sm" c="dimmed">
            {t("providerCatalog.routing.optimizer.description")}
          </Text>
          <Switch
            label={t("providerCatalog.routing.optimizer.enabled")}
            checked={optimizer?.enabled ?? false}
            disabled={!optimizer || busy}
            onChange={(event) => optimizer && void state.setOptimizerConfig({
              ...optimizer,
              enabled: event.currentTarget.checked,
            })}
          />
          <Switch
            label={t("providerCatalog.routing.optimizer.thinking")}
            checked={optimizer?.thinkingOptimizer ?? false}
            disabled={!optimizer || busy}
            onChange={(event) => optimizer && void state.setOptimizerConfig({
              ...optimizer,
              thinkingOptimizer: event.currentTarget.checked,
            })}
          />
          <Switch
            label={t("providerCatalog.routing.optimizer.cache")}
            checked={optimizer?.cacheInjection ?? false}
            disabled={!optimizer || busy}
            onChange={(event) => optimizer && void state.setOptimizerConfig({
              ...optimizer,
              cacheInjection: event.currentTarget.checked,
            })}
          />
          <Alert color="gray" variant="light">
            {t("providerCatalog.routing.optimizer.nonBedrock")}
          </Alert>
        </Stack>
      </Accordion.Panel>
    </Accordion.Item>
  );
}
