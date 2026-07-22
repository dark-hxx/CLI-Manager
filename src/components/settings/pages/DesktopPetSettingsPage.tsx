import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Group,
  SimpleGrid,
  Skeleton,
  Slider,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import {
  Archive,
  Cat,
  Check,
  Download,
  HardDrive,
  Info,
  RefreshCw,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { CliCat } from "../../desktop-pet/CliCat";
import { PetArtwork } from "../../desktop-pet/PetArtwork";
import { useAppConfirm } from "../../ui/useAppConfirm";
import {
  localizedPetText,
  type InstalledPet,
  type PetCatalogEntry,
  type PetCatalogResponse,
} from "../../../lib/desktopPet";
import { formatFileSize } from "../../../lib/utils";
import { useI18n, type TranslationKey } from "../../../lib/i18n";
import {
  BUILTIN_DESKTOP_PET_ID,
  DESKTOP_PET_SIZE_MAX_PERCENT,
  DESKTOP_PET_SIZE_MIN_PERCENT,
  DESKTOP_PET_SIZE_STEP_PERCENT,
  DESKTOP_PET_WORK_BOUNCE_MAX_PX,
  DESKTOP_PET_WORK_BOUNCE_MIN_PX,
  useSettingsStore,
  type DesktopPetSettings,
} from "../../../stores/settingsStore";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

interface ToggleRowProps {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ title, description, checked, disabled, ariaLabel, onChange }: ToggleRowProps) {
  return (
    <Group justify="space-between" align="flex-start" gap="lg" wrap="nowrap">
      <Box className="min-w-0 flex-1">
        <Text size="sm" fw={500} c="var(--on-surface)">
          {title}
        </Text>
        <Text mt={3} size="xs" c="var(--on-surface-variant)">
          {description}
        </Text>
      </Box>
      <Switch
        color="cliPrimary"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </Group>
  );
}

function petErrorMessage(error: unknown, t: Translate): string {
  const raw = String(error);
  if (raw.includes("pet_app_version_too_old")) return t("desktopPet.errors.appTooOld");
  if (raw.includes("pet_download_checksum_mismatch")) return t("desktopPet.errors.checksum");
  if (raw.includes("pet_uninstall_external_unsupported")) {
    return t("desktopPet.errors.externalUninstallUnsupported");
  }
  if (raw.includes("pet_import_size_invalid") || raw.includes("pet_archive_size_invalid")) {
    return t("desktopPet.errors.packageSize");
  }
  if (
    raw.includes("pet_archive_") ||
    raw.includes("pet_manifest_") ||
    raw.includes("pet_codex_") ||
    raw.includes("pet_svg_") ||
    raw.includes("pet_id_invalid")
  ) {
    return t("desktopPet.errors.invalidPackage");
  }
  if (
    raw.includes("pet_download_") ||
    raw.includes("pet_catalog_download_") ||
    raw.includes("pet_catalog_http_") ||
    raw.includes("pet_catalog_client_")
  ) {
    return t("desktopPet.errors.network");
  }
  return t("desktopPet.errors.generic", { error: raw });
}

function PetPreview({
  src,
  pet,
  alt,
  builtin = false,
}: {
  src?: string | null;
  pet?: InstalledPet | null;
  alt: string;
  builtin?: boolean;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [pet?.baseDir, src]);

  return (
    <Box
      className="grid h-28 w-full place-items-center overflow-hidden rounded-xl"
      style={{
        background:
          "radial-gradient(circle at 50% 42%, color-mix(in srgb, var(--primary) 16%, transparent), transparent 68%), var(--surface-container-lowest)",
        border: "1px solid color-mix(in srgb, var(--border) 28%, transparent)",
      }}
    >
      {builtin || (!src && !pet) || failed ? (
        <CliCat className="h-20 w-28 overflow-visible text-primary" animated={false} ariaLabel={alt} />
      ) : pet ? (
        <PetArtwork
          pet={pet}
          alt={alt}
          width={96}
          height={96}
          animated={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <img
          className="h-24 w-24 object-contain"
          src={src ?? undefined}
          alt={alt}
          draggable={false}
          onError={() => setFailed(true)}
        />
      )}
    </Box>
  );
}

interface InstalledPetCardProps {
  pet: InstalledPet;
  selected: boolean;
  busy: boolean;
  onSelect: () => void;
  onUninstall: () => void;
}

function InstalledPetCard({ pet, selected, busy, onSelect, onUninstall }: InstalledPetCardProps) {
  const { language, t } = useI18n();
  const name = localizedPetText(pet.manifest.name, language);
  const description = localizedPetText(pet.manifest.description, language);
  const codexFormat = pet.format === "codex";

  return (
    <Card withBorder radius="lg" padding="md" className="ui-surface-card">
      <Stack gap="sm">
        <PetPreview pet={pet} alt={t("desktopPet.settings.previewAlt", { name })} />
        <Box>
          <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
            <Text className="truncate" size="sm" fw={600} c="var(--on-surface)">
              {name}
            </Text>
            {selected ? (
              <Badge size="xs" color="cliPrimary" variant="light" leftSection={<Check size={11} />}>
                {t("desktopPet.settings.selected")}
              </Badge>
            ) : null}
          </Group>
          <Text mt={3} size="xs" c="var(--on-surface-variant)" lineClamp={2}>
            {description}
          </Text>
        </Box>
        <Group gap={6} wrap="wrap">
          <Badge size="xs" variant="outline">
            {codexFormat
              ? t("desktopPet.settings.codexFormat", {
                  version: pet.manifest.spriteVersionNumber ?? 1,
                })
              : `v${pet.manifest.version}`}
          </Badge>
          <Badge size="xs" variant="light" color={pet.source === "codex" ? "blue" : "gray"}>
            {pet.source === "codex"
              ? t("desktopPet.settings.sourceCodexDirectory")
              : t("desktopPet.settings.sourceCliManagerDirectory")}
          </Badge>
        </Group>
        <Text size="xs" c="var(--text-muted)">
          {codexFormat
            ? pet.source === "codex"
              ? t("desktopPet.settings.codexManagedDescription")
              : t("desktopPet.settings.codexImportedDescription")
            : `${pet.manifest.author} · ${pet.manifest.license}`}
        </Text>
        {pet.removable ? (
          <Group gap="xs" grow>
            <Button
              size="xs"
              variant={selected ? "light" : "filled"}
              color="cliPrimary"
              disabled={selected || busy}
              onClick={onSelect}
            >
              {selected ? t("desktopPet.settings.selected") : t("desktopPet.settings.select")}
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="red"
              disabled={busy}
              leftSection={<Trash2 size={13} />}
              onClick={onUninstall}
            >
              {t("desktopPet.settings.uninstall")}
            </Button>
          </Group>
        ) : (
          <Button
            size="xs"
            variant={selected ? "light" : "filled"}
            color="cliPrimary"
            disabled={selected || busy}
            onClick={onSelect}
          >
            {selected ? t("desktopPet.settings.selected") : t("desktopPet.settings.select")}
          </Button>
        )}
      </Stack>
    </Card>
  );
}

interface CatalogPetCardProps {
  entry: PetCatalogEntry;
  installed: InstalledPet | null;
  selected: boolean;
  busy: boolean;
  onInstall: () => void;
  onSelect: () => void;
}

function CatalogPetCard({ entry, installed, selected, busy, onInstall, onSelect }: CatalogPetCardProps) {
  const { language, t } = useI18n();
  const name = localizedPetText(entry.name, language);
  const description = localizedPetText(entry.description, language);
  const updateAvailable = installed
    ? entry.version.localeCompare(installed.manifest.version, undefined, {
        numeric: true,
        sensitivity: "base",
      }) > 0
    : false;
  const preview = entry.previewDataUrl || entry.previewUrl;

  return (
    <Card withBorder radius="lg" padding="md" className="ui-surface-card">
      <Stack gap="sm">
        <PetPreview src={preview} alt={t("desktopPet.settings.previewAlt", { name })} />
        <Box>
          <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
            <Text className="truncate" size="sm" fw={600} c="var(--on-surface)">
              {name}
            </Text>
            {installed ? (
              <Badge size="xs" color={updateAvailable ? "orange" : "green"} variant="light">
                {updateAvailable
                  ? t("desktopPet.settings.updateAvailable")
                  : t("desktopPet.settings.installedBadge")}
              </Badge>
            ) : null}
          </Group>
          <Text mt={3} size="xs" c="var(--on-surface-variant)" lineClamp={2}>
            {description}
          </Text>
        </Box>
        <Group gap={6} wrap="wrap">
          <Badge size="xs" variant="outline">v{entry.version}</Badge>
          <Text size="xs" c="var(--text-muted)">
            {entry.author} · {entry.license} · {formatFileSize(entry.sizeBytes)}
          </Text>
        </Group>
        {installed && !updateAvailable ? (
          <Button
            size="xs"
            color="cliPrimary"
            variant={selected ? "light" : "filled"}
            disabled={selected || busy}
            leftSection={selected ? <Check size={13} /> : undefined}
            onClick={onSelect}
          >
            {selected ? t("desktopPet.settings.selected") : t("desktopPet.settings.select")}
          </Button>
        ) : (
          <Button
            size="xs"
            color="cliPrimary"
            loading={busy}
            leftSection={<Download size={13} />}
            onClick={onInstall}
          >
            {busy
              ? updateAvailable
                ? t("desktopPet.settings.updating")
                : t("desktopPet.settings.installing")
              : updateAvailable
                ? t("desktopPet.settings.update")
                : t("desktopPet.settings.install")}
          </Button>
        )}
      </Stack>
    </Card>
  );
}

function SectionHeader({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Group justify="space-between" align="flex-start" gap="md" wrap="nowrap">
      <Group align="flex-start" gap="sm" wrap="nowrap">
        <Box mt={2} c="var(--primary)">{icon}</Box>
        <Box>
          <Text size="sm" fw={600} c="var(--on-surface)">{title}</Text>
          <Text mt={3} size="xs" c="var(--on-surface-variant)">{description}</Text>
        </Box>
      </Group>
      {action}
    </Group>
  );
}

function upsertInstalled(pets: InstalledPet[], next: InstalledPet): InstalledPet[] {
  return [...pets.filter((pet) => pet.manifest.id !== next.manifest.id), next]
    .sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export function DesktopPetSettingsPage() {
  const { language, t } = useI18n();
  const { confirm, confirmDialog } = useAppConfirm();
  const desktopPet = useSettingsStore((state) => state.desktopPet);
  const updateSetting = useSettingsStore((state) => state.update);
  const [catalog, setCatalog] = useState<PetCatalogResponse | null>(null);
  const [installedPets, setInstalledPets] = useState<InstalledPet[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busyPetId, setBusyPetId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sizeDraft, setSizeDraft] = useState(desktopPet.size);
  const [workingBounceDistanceDraft, setWorkingBounceDistanceDraft] = useState(
    desktopPet.workingBounceDistancePx
  );

  const patch = useCallback(async (delta: Partial<DesktopPetSettings>) => {
    const current = useSettingsStore.getState().desktopPet;
    await updateSetting("desktopPet", { ...current, ...delta });
  }, [updateSetting]);

  useEffect(() => {
    setSizeDraft(desktopPet.size);
  }, [desktopPet.size]);

  useEffect(() => {
    setWorkingBounceDistanceDraft(desktopPet.workingBounceDistancePx);
  }, [desktopPet.workingBounceDistancePx]);

  const commitWorkingBounceDistance = useCallback((value: number) => {
    const next = Math.round(Math.min(
      DESKTOP_PET_WORK_BOUNCE_MAX_PX,
      Math.max(DESKTOP_PET_WORK_BOUNCE_MIN_PX, value)
    ));
    setWorkingBounceDistanceDraft(next);
    void patch({ workingBounceDistancePx: next });
  }, [patch]);

  const commitSize = useCallback((value: number) => {
    const next = Math.round(
      Math.min(DESKTOP_PET_SIZE_MAX_PERCENT, Math.max(DESKTOP_PET_SIZE_MIN_PERCENT, value))
      / DESKTOP_PET_SIZE_STEP_PERCENT
    ) * DESKTOP_PET_SIZE_STEP_PERCENT;
    setSizeDraft(next);
    void patch({ size: next });
  }, [patch]);

  const loadPets = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setLoadError(null);
    try {
      const [nextCatalog, nextInstalled] = await Promise.all([
        invoke<PetCatalogResponse>("desktop_pet_catalog", { refresh }),
        invoke<InstalledPet[]>("desktop_pet_list_installed"),
      ]);
      setCatalog(nextCatalog);
      setInstalledPets(nextInstalled);
    } catch (error) {
      setLoadError(petErrorMessage(error, t));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [t]);

  useEffect(() => {
    void loadPets(false);
  }, [loadPets]);

  const scanInstalledPets = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    try {
      const nextInstalled = await invoke<InstalledPet[]>("desktop_pet_list_installed");
      setInstalledPets(nextInstalled);
      toast.success(t("desktopPet.settings.scanSuccess", { count: nextInstalled.length }));
    } catch (error) {
      toast.error(t("desktopPet.settings.operationFailed"), {
        description: petErrorMessage(error, t),
      });
    } finally {
      setScanning(false);
    }
  }, [scanning, t]);

  const installedById = useMemo(
    () => new Map(installedPets.map((pet) => [pet.manifest.id, pet])),
    [installedPets]
  );
  const selectedInstalledPet = desktopPet.petId === BUILTIN_DESKTOP_PET_ID
    ? null
    : installedById.get(desktopPet.petId) ?? null;
  const currentPetName = selectedInstalledPet
    ? localizedPetText(selectedInstalledPet.manifest.name, language)
    : t("desktopPet.settings.builtinName");
  const currentPetDescription = selectedInstalledPet
    ? localizedPetText(selectedInstalledPet.manifest.description, language)
    : t("desktopPet.settings.builtinDescription");
  const selectedMissing =
    desktopPet.petId !== BUILTIN_DESKTOP_PET_ID && !selectedInstalledPet && !loading;

  const handleSelect = async (petId: string, name: string) => {
    try {
      await patch({ petId });
      toast.success(t("desktopPet.settings.selectSuccess", { name }));
    } catch (error) {
      toast.error(t("desktopPet.settings.operationFailed"), {
        description: petErrorMessage(error, t),
      });
    }
  };

  const handleInstall = async (entry: PetCatalogEntry) => {
    if (busyPetId) return;
    const previous = installedById.get(entry.id);
    const name = localizedPetText(entry.name, language);
    setBusyPetId(entry.id);
    try {
      const installed = await invoke<InstalledPet>("desktop_pet_install", { petId: entry.id });
      setInstalledPets((pets) => upsertInstalled(pets, installed));
      await patch({ petId: entry.id });
      toast.success(
        previous
          ? t("desktopPet.settings.updateSuccess", { name })
          : t("desktopPet.settings.installSuccess", { name })
      );
    } catch (error) {
      toast.error(t("desktopPet.settings.operationFailed"), {
        description: petErrorMessage(error, t),
      });
    } finally {
      setBusyPetId(null);
    }
  };

  const handleUninstall = async (pet: InstalledPet) => {
    if (busyPetId) return;
    const name = localizedPetText(pet.manifest.name, language);
    const confirmed = await confirm({
      title: t("desktopPet.settings.uninstallConfirmTitle"),
      message: t("desktopPet.settings.uninstallConfirmMessage", { name }),
      confirmText: t("desktopPet.settings.uninstall"),
      danger: true,
    });
    if (!confirmed) return;
    setBusyPetId(pet.manifest.id);
    try {
      await invoke("desktop_pet_uninstall", { petId: pet.manifest.id });
      const remaining = await invoke<InstalledPet[]>("desktop_pet_list_installed");
      setInstalledPets(remaining);
      const replacementAvailable = remaining.some(
        (item) => item.manifest.id === pet.manifest.id
      );
      if (
        useSettingsStore.getState().desktopPet.petId === pet.manifest.id &&
        !replacementAvailable
      ) {
        await patch({ petId: BUILTIN_DESKTOP_PET_ID });
      }
      toast.success(t("desktopPet.settings.uninstallSuccess", { name }));
    } catch (error) {
      toast.error(t("desktopPet.settings.operationFailed"), {
        description: petErrorMessage(error, t),
      });
    } finally {
      setBusyPetId(null);
    }
  };

  const handleImport = async () => {
    if (importing) return;
    let selected: string | string[] | null;
    try {
      selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [
          {
            name: t("desktopPet.settings.packageFilter"),
            extensions: ["clipet", "zip"],
          },
        ],
      });
    } catch (error) {
      toast.error(t("desktopPet.settings.operationFailed"), {
        description: petErrorMessage(error, t),
      });
      return;
    }
    if (!selected || typeof selected !== "string") return;
    setImporting(true);
    try {
      const installed = await invoke<InstalledPet>("desktop_pet_import", { path: selected });
      setInstalledPets((pets) => upsertInstalled(pets, installed));
      await patch({ petId: installed.manifest.id });
      const name = localizedPetText(installed.manifest.name, language);
      toast.success(t("desktopPet.settings.importSuccess", { name }));
    } catch (error) {
      toast.error(t("desktopPet.settings.operationFailed"), {
        description: petErrorMessage(error, t),
      });
    } finally {
      setImporting(false);
    }
  };

  const handleResetPosition = async () => {
    try {
      await patch({ position: null });
      await invoke("desktop_pet_window_reset_position");
      toast.success(t("desktopPet.settings.resetPositionSuccess"));
    } catch (error) {
      toast.error(t("desktopPet.settings.operationFailed"), {
        description: petErrorMessage(error, t),
      });
    }
  };

  const catalogSourceKey: TranslationKey = catalog?.source === "remote"
    ? "desktopPet.settings.sourceRemote"
    : catalog?.source === "bundled"
      ? "desktopPet.settings.sourceBundled"
      : "desktopPet.settings.sourceCache";

  return (
    <Stack gap="md">
      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <Group justify="space-between" align="flex-start" gap="lg" wrap="nowrap">
            <Group align="center" gap="md" wrap="nowrap" className="min-w-0">
              <Box className="w-28 shrink-0">
                <PetPreview
                  pet={selectedInstalledPet}
                  builtin={!selectedInstalledPet}
                  alt={t("desktopPet.settings.previewAlt", { name: currentPetName })}
                />
              </Box>
              <Box className="min-w-0">
                <Badge
                  size="xs"
                  color="cliPrimary"
                  variant="light"
                  leftSection={<Cat size={11} />}
                >
                  {t("desktopPet.settings.currentPet")}
                </Badge>
                <Text mt={6} size="lg" fw={650} c="var(--on-surface)">
                  {currentPetName}
                </Text>
                <Text mt={3} size="xs" c="var(--on-surface-variant)">
                  {currentPetDescription}
                </Text>
              </Box>
            </Group>
            <Switch
              size="md"
              color="cliPrimary"
              checked={desktopPet.enabled}
              aria-label={
                desktopPet.enabled
                  ? t("desktopPet.settings.disableAria")
                  : t("desktopPet.settings.enableAria")
              }
              onChange={(event) => void patch({ enabled: event.currentTarget.checked })}
            />
          </Group>

          {selectedMissing ? (
            <Alert
              color="orange"
              variant="light"
              icon={<Info size={16} />}
              title={t("desktopPet.settings.selectedMissingTitle")}
            >
              <Group justify="space-between" align="center" gap="sm">
                <Text size="xs">{t("desktopPet.settings.selectedMissingDescription")}</Text>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() =>
                    void handleSelect(
                      BUILTIN_DESKTOP_PET_ID,
                      t("desktopPet.settings.builtinName")
                    )
                  }
                >
                  {t("desktopPet.settings.useBuiltin")}
                </Button>
              </Group>
            </Alert>
          ) : null}

          <Stack gap={8}>
            <Group justify="space-between" align="center" gap="md" wrap="nowrap">
              <Box className="min-w-0 flex-1">
                <Text size="sm" fw={500} c="var(--on-surface)">
                  {t("desktopPet.settings.size")}
                </Text>
                <Text mt={2} size="xs" c="var(--on-surface-variant)">
                  {t("desktopPet.settings.sizeDescription")}
                </Text>
              </Box>
              <Text
                size="xs"
                ff="var(--font-ui-mono)"
                c="var(--on-surface)"
                className="tabular-nums"
              >
                {sizeDraft}%
              </Text>
            </Group>
            <Slider
              min={DESKTOP_PET_SIZE_MIN_PERCENT}
              max={DESKTOP_PET_SIZE_MAX_PERCENT}
              step={DESKTOP_PET_SIZE_STEP_PERCENT}
              value={sizeDraft}
              onChange={setSizeDraft}
              onChangeEnd={commitSize}
              label={(value) => `${value}%`}
              color="cliPrimary"
              aria-label={t("desktopPet.settings.size")}
              marks={[
                { value: 40, label: "40%" },
                { value: 100, label: "100%" },
                { value: 150, label: "150%" },
              ]}
              mb="lg"
            />
          </Stack>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <SectionHeader
            icon={<Cat size={18} />}
            title={t("desktopPet.settings.behaviorTitle")}
            description={t("desktopPet.settings.behaviorDescription")}
          />
          <ToggleRow
            title={t("desktopPet.settings.alwaysOnTop")}
            description={t("desktopPet.settings.alwaysOnTopDescription")}
            checked={desktopPet.alwaysOnTop}
            ariaLabel={t("desktopPet.settings.alwaysOnTop")}
            onChange={(checked) => void patch({ alwaysOnTop: checked })}
          />
          <ToggleRow
            title={t("desktopPet.settings.showActionMenu")}
            description={t("desktopPet.settings.showActionMenuDescription")}
            checked={desktopPet.showActionMenu}
            ariaLabel={t("desktopPet.settings.showActionMenu")}
            onChange={(checked) => void patch({ showActionMenu: checked })}
          />
          <ToggleRow
            title={t("desktopPet.settings.openOnHover")}
            description={t("desktopPet.settings.openOnHoverDescription")}
            checked={desktopPet.openOnHover}
            ariaLabel={t("desktopPet.settings.openOnHover")}
            onChange={(checked) => void patch({ openOnHover: checked })}
          />
          <Stack gap={8}>
            <ToggleRow
              title={t("desktopPet.settings.workingBounce")}
              description={t("desktopPet.settings.workingBounceDescription")}
              checked={desktopPet.workingBounceEnabled}
              ariaLabel={t("desktopPet.settings.workingBounce")}
              onChange={(checked) => void patch({ workingBounceEnabled: checked })}
            />
            <Stack gap={6} pl="sm">
              <Group justify="space-between" align="center">
                <Text size="xs" c="var(--on-surface-variant)">
                  {t("desktopPet.settings.workingBounceDistance")}
                </Text>
                <Text
                  size="xs"
                  ff="var(--font-ui-mono)"
                  c={desktopPet.workingBounceEnabled ? "var(--on-surface)" : "var(--text-muted)"}
                  className="tabular-nums"
                >
                  {workingBounceDistanceDraft}px
                </Text>
              </Group>
              <Slider
                min={DESKTOP_PET_WORK_BOUNCE_MIN_PX}
                max={DESKTOP_PET_WORK_BOUNCE_MAX_PX}
                step={1}
                value={workingBounceDistanceDraft}
                disabled={!desktopPet.workingBounceEnabled}
                onChange={setWorkingBounceDistanceDraft}
                onChangeEnd={commitWorkingBounceDistance}
                label={(value) => `${value}px`}
                color="cliPrimary"
                aria-label={t("desktopPet.settings.workingBounceDistance")}
              />
            </Stack>
          </Stack>
          <ToggleRow
            title={t("desktopPet.settings.showStatus")}
            description={t("desktopPet.settings.showStatusDescription")}
            checked={desktopPet.showStatus}
            ariaLabel={t("desktopPet.settings.showStatus")}
            onChange={(checked) => void patch({ showStatus: checked })}
          />
          <ToggleRow
            title={t("desktopPet.settings.showSessionName")}
            description={t("desktopPet.settings.showSessionNameDescription")}
            checked={desktopPet.showSessionName}
            disabled={!desktopPet.showStatus}
            ariaLabel={t("desktopPet.settings.showSessionName")}
            onChange={(checked) => void patch({ showSessionName: checked })}
          />
          <ToggleRow
            title={t("desktopPet.settings.autoHideFullscreen")}
            description={t("desktopPet.settings.autoHideFullscreenDescription")}
            checked={desktopPet.autoHideFullscreen}
            ariaLabel={t("desktopPet.settings.autoHideFullscreen")}
            onChange={(checked) => void patch({ autoHideFullscreen: checked })}
          />
          <ToggleRow
            title={t("desktopPet.settings.lockPosition")}
            description={t("desktopPet.settings.lockPositionDescription")}
            checked={desktopPet.lockPosition}
            ariaLabel={t("desktopPet.settings.lockPosition")}
            onChange={(checked) => void patch({ lockPosition: checked })}
          />
          <Group justify="flex-end">
            <Button
              size="xs"
              variant="light"
              color="gray"
              leftSection={<RotateCcw size={14} />}
              onClick={() => void handleResetPosition()}
            >
              {t("desktopPet.settings.resetPosition")}
            </Button>
          </Group>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <SectionHeader
            icon={<HardDrive size={18} />}
            title={t("desktopPet.settings.installedTitle")}
            description={t("desktopPet.settings.installedDescription")}
            action={
              <Group gap="xs" wrap="nowrap">
                <Button
                  size="xs"
                  variant="subtle"
                  color="gray"
                  loading={scanning}
                  leftSection={<RefreshCw size={14} />}
                  onClick={() => void scanInstalledPets()}
                >
                  {t("desktopPet.settings.rescan")}
                </Button>
                <Button
                  size="xs"
                  variant="light"
                  color="cliPrimary"
                  loading={importing}
                  leftSection={<Upload size={14} />}
                  onClick={() => void handleImport()}
                >
                  {importing
                    ? t("desktopPet.settings.importing")
                    : t("desktopPet.settings.import")}
                </Button>
              </Group>
            }
          />
          <Alert color="blue" variant="light" icon={<Archive size={16} />}>
            <Text size="xs">
              {t("desktopPet.settings.storageDescription", {
                managedPath: "~/.cli-manager/pets",
                codexPath: "~/.codex/pets",
                downloadUrl1: "https://codex-pets.net/",
                downloadUrl2: "https://petdex.dev/",
                downloadUrl3: "https://codexpets.net/",
              })}
            </Text>
          </Alert>
          <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
            <Card withBorder radius="lg" padding="md" className="ui-surface-card">
              <Stack gap="sm">
                <PetPreview
                  builtin
                  alt={t("desktopPet.settings.previewAlt", {
                    name: t("desktopPet.settings.builtinName"),
                  })}
                />
                <Box>
                  <Group justify="space-between" align="center" gap="xs" wrap="nowrap">
                    <Text size="sm" fw={600} c="var(--on-surface)">
                      {t("desktopPet.settings.builtinName")}
                    </Text>
                    <Badge size="xs" variant="light">
                      {t("desktopPet.settings.builtinBadge")}
                    </Badge>
                  </Group>
                  <Text mt={3} size="xs" c="var(--on-surface-variant)" lineClamp={2}>
                    {t("desktopPet.settings.builtinDescription")}
                  </Text>
                </Box>
                <Button
                  size="xs"
                  color="cliPrimary"
                  variant={
                    desktopPet.petId === BUILTIN_DESKTOP_PET_ID ? "light" : "filled"
                  }
                  disabled={desktopPet.petId === BUILTIN_DESKTOP_PET_ID}
                  leftSection={
                    desktopPet.petId === BUILTIN_DESKTOP_PET_ID
                      ? <Check size={13} />
                      : undefined
                  }
                  onClick={() =>
                    void handleSelect(
                      BUILTIN_DESKTOP_PET_ID,
                      t("desktopPet.settings.builtinName")
                    )
                  }
                >
                  {desktopPet.petId === BUILTIN_DESKTOP_PET_ID
                    ? t("desktopPet.settings.selected")
                    : t("desktopPet.settings.select")}
                </Button>
              </Stack>
            </Card>
            {installedPets.map((pet) => (
              <InstalledPetCard
                key={pet.manifest.id}
                pet={pet}
                selected={desktopPet.petId === pet.manifest.id}
                busy={busyPetId === pet.manifest.id}
                onSelect={() =>
                  void handleSelect(
                    pet.manifest.id,
                    localizedPetText(pet.manifest.name, language)
                  )
                }
                onUninstall={() => void handleUninstall(pet)}
              />
            ))}
          </SimpleGrid>
        </Stack>
      </section>

      <section className="ui-surface-card rounded-2xl border border-border p-4">
        <Stack gap="md">
          <SectionHeader
            icon={<Download size={18} />}
            title={t("desktopPet.settings.catalogTitle")}
            description={t("desktopPet.settings.catalogDescription")}
            action={
              <Button
                size="xs"
                variant="light"
                color="cliPrimary"
                loading={refreshing}
                leftSection={<RefreshCw size={14} />}
                onClick={() => void loadPets(true)}
              >
                {refreshing
                  ? t("desktopPet.settings.refreshing")
                  : t("desktopPet.settings.refresh")}
              </Button>
            }
          />

          {catalog ? (
            <Group gap="xs">
              <Badge size="xs" variant="light">{t(catalogSourceKey)}</Badge>
              <Text size="xs" c="var(--text-muted)">
                {t("desktopPet.settings.catalogCount", { count: catalog.items.length })}
              </Text>
            </Group>
          ) : null}

          {catalog?.warning ? (
            <Alert
              color="orange"
              variant="light"
              icon={<Info size={16} />}
              title={t("desktopPet.settings.catalogFallbackTitle")}
            >
              <Text size="xs">{t("desktopPet.settings.catalogFallbackDescription")}</Text>
            </Alert>
          ) : null}

          {loadError ? (
            <Alert
              color="red"
              variant="light"
              title={t("desktopPet.settings.catalogLoadFailed")}
            >
              <Stack gap="xs">
                <Text size="xs">{loadError}</Text>
                <Button
                  size="xs"
                  variant="light"
                  color="red"
                  onClick={() => void loadPets(true)}
                >
                  {t("common.retry")}
                </Button>
              </Stack>
            </Alert>
          ) : null}

          {loading ? (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
              {[0, 1, 2].map((index) => (
                <Card key={index} withBorder radius="lg" padding="md">
                  <Stack gap="sm">
                    <Skeleton height={112} radius="md" />
                    <Skeleton height={14} width="65%" />
                    <Skeleton height={28} />
                  </Stack>
                </Card>
              ))}
            </SimpleGrid>
          ) : catalog && catalog.items.length > 0 ? (
            <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
              {catalog.items.map((entry) => {
                const installed = installedById.get(entry.id) ?? null;
                return (
                  <CatalogPetCard
                    key={entry.id}
                    entry={entry}
                    installed={installed}
                    selected={desktopPet.petId === entry.id}
                    busy={busyPetId === entry.id}
                    onInstall={() => void handleInstall(entry)}
                    onSelect={() =>
                      void handleSelect(
                        entry.id,
                        localizedPetText(entry.name, language)
                      )
                    }
                  />
                );
              })}
            </SimpleGrid>
          ) : !loadError ? (
            <Box className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
              <Text size="sm" c="var(--on-surface-variant)">
                {t("desktopPet.settings.catalogEmpty")}
              </Text>
            </Box>
          ) : null}
        </Stack>
      </section>
      {confirmDialog}
    </Stack>
  );
}
