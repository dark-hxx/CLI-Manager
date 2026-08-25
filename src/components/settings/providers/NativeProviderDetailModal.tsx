import { Badge, Group, Modal, Stack, Tabs, Text } from "@mantine/core";
import { useI18n } from "@/lib/i18n";
import { NativeProviderDocumentEditor } from "./NativeProviderDocumentEditor";
import { NativeProviderEditor } from "./NativeProviderEditor";
import { NativeProviderGlobalSection } from "./NativeProviderGlobalSection";
import { NativeProviderKeySection } from "./NativeProviderKeySection";
import {
  normalizeNativeProviderDetailView,
  type NativeProviderDetailView,
} from "./nativeProviderDetailView";
import type { UseNativeProviderCatalogResult } from "./useNativeProviderCatalog";
import type { UseNativeProviderHomeResult } from "./useNativeProviderHome";
import type {
  NativeProviderAppType,
  NativeProviderCommonConfig,
} from "./nativeProviderTypes";

interface NativeProviderDetailModalProps {
  opened: boolean;
  appType: NativeProviderAppType;
  catalog: UseNativeProviderCatalogResult;
  homeState: UseNativeProviderHomeResult;
  commonConfigDocument: NativeProviderCommonConfig | null;
  detailView: NativeProviderDetailView;
  onDetailViewChange: (view: NativeProviderDetailView) => void;
  onClose: () => void;
  onExitTransitionEnd: () => void;
  onEdit: () => void;
  onDelete: (providerId: string) => void;
  onActivateKey: (keyId: string) => Promise<void>;
  onDocumentDirtyChange: (dirty: boolean) => void;
  onGlobalApplied: () => void;
}

function ignoreProviderError(promise: Promise<unknown>): void {
  void promise.catch(() => undefined);
}

/**
 * 供应商详情弹窗。
 *
 * 主页面只保留极简的供应商列表，所有详情、密钥、完整配置与「应用到全局」都收进这里。
 * Tabs 保留 `keepMounted` + `display-none`：该模式只是隐藏 DOM，不会卸载或销毁内部
 * Monaco 实例（与 Mantine `Collapse` 默认的 Activity 模式不同），因此切页签不会丢
 * 未保存的编辑，也不会触发 `InstantiationService has been disposed`。
 * 弹窗关闭时 Mantine `Modal` 整体卸载子树，Monaco 随之干净释放。
 */
export function NativeProviderDetailModal({
  opened,
  appType,
  catalog,
  homeState,
  commonConfigDocument,
  detailView,
  onDetailViewChange,
  onClose,
  onExitTransitionEnd,
  onEdit,
  onDelete,
  onActivateKey,
  onDocumentDirtyChange,
  onGlobalApplied,
}: NativeProviderDetailModalProps) {
  const { t } = useI18n();
  const detail = catalog.detail;
  const providerId = detail?.card.id ?? null;

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      returnFocus={false}
      onExitTransitionEnd={onExitTransitionEnd}
      centered
      size="min(1100px, 94vw)"
      title={
        <Group gap="xs" wrap="nowrap" className="min-w-0">
          <Text fw={600} truncate className="min-w-0">
            {detail?.card.name ?? t("providerCatalog.detailModalTitle")}
          </Text>
          {detail?.card.isCurrent && (
            <Badge size="sm" color="cliPrimary" className="shrink-0">
              {t("providerCatalog.current")}
            </Badge>
          )}
        </Group>
      }
    >
      {/* 弹窗需要自己的滚动容器：密钥列表与 Monaco 预览都可能超出视口高度。
          与同页导入弹窗保持一致的 max-h + overflow-y-auto，也复原了改版前
          右侧详情面板由外层容器滚动、Monaco 自管内部滚动的两层结构。 */}
      <div className="max-h-[calc(100vh-11rem)] overflow-y-auto pr-1">
      <Tabs
        value={detailView}
        onChange={(value) => onDetailViewChange(normalizeNativeProviderDetailView(value))}
        keepMounted
        keepMountedMode="display-none"
      >
        <Tabs.List aria-label={t("providerCatalog.detailTabs.label")}>
          <Tabs.Tab value="basic">{t("providerCatalog.detailTabs.basic")}</Tabs.Tab>
          <Tabs.Tab value="effective" disabled={!detail}>{t("providerCatalog.detailTabs.effective")}</Tabs.Tab>
          <Tabs.Tab value="keys" disabled={!detail}>{t("providerCatalog.detailTabs.keys")}</Tabs.Tab>
          <Tabs.Tab value="documents" disabled={!detail}>{t("providerCatalog.detailTabs.documents")}</Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="basic" pt="sm">
          <Stack gap="md">
            <NativeProviderEditor
              view="basic"
              detail={detail}
              loading={catalog.detailLoading}
              action={catalog.action}
              commonConfig={commonConfigDocument}
              globalPreview={homeState.preview}
              onEdit={onEdit}
              onDelete={() => {
                if (providerId) onDelete(providerId);
              }}
              onEnabledChange={(enabled) => {
                if (providerId) ignoreProviderError(catalog.setProviderEnabled(providerId, enabled));
              }}
            />
            <NativeProviderGlobalSection
              state={homeState}
              providerId={providerId}
              onGlobalApplied={async () => onGlobalApplied()}
            />
          </Stack>
        </Tabs.Panel>

        <Tabs.Panel value="effective" pt="sm">
          <NativeProviderEditor
            view="effective"
            detail={detail}
            loading={catalog.detailLoading}
            action={catalog.action}
            commonConfig={commonConfigDocument}
            globalPreview={homeState.preview}
            onEdit={onEdit}
            onDelete={() => {
              if (providerId) onDelete(providerId);
            }}
            onEnabledChange={(enabled) => {
              if (providerId) ignoreProviderError(catalog.setProviderEnabled(providerId, enabled));
            }}
          />
        </Tabs.Panel>

        <Tabs.Panel value="keys" pt="sm">
          {detail && (
            <NativeProviderKeySection
              appType={appType}
              providerId={detail.card.id}
              keys={detail.keys}
              action={catalog.action}
              onCreate={catalog.createKey}
              onUpdate={catalog.updateKey}
              onReveal={(keyId) => catalog.revealKey(detail.card.id, keyId)}
              onActivate={onActivateKey}
              onSetEnabled={(keyId, enabled) => catalog.setKeyEnabled(detail.card.id, keyId, enabled)}
              onDelete={(keyId, replacementKeyId) => catalog.deleteKey(detail.card.id, keyId, replacementKeyId)}
              onReorder={(keyIds) => catalog.reorderKeys(detail.card.id, keyIds)}
            />
          )}
        </Tabs.Panel>

        <Tabs.Panel value="documents" pt="sm">
          {detail && (
            <NativeProviderDocumentEditor
              appType={appType}
              providerId={detail.card.id}
              documents={detail.documents}
              action={catalog.action}
              onDirtyChange={onDocumentDirtyChange}
              onSave={(kind, value) => catalog.updateDocument({
                appType,
                providerId: detail.card.id,
                kind,
                value,
              })}
            />
          )}
        </Tabs.Panel>
      </Tabs>
      </div>
    </Modal>
  );
}
