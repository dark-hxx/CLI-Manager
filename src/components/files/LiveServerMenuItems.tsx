import { useEffect } from "react";
import { toast } from "sonner";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { tauriLiveServerClient } from "../../lib/liveServerClient";
import type { Project, ProjectFileEntry } from "../../lib/types";
import { createLiveServerStore } from "../../stores/liveServerStore";
import { CircleStop, Globe } from "../icons";
import { ContextMenuItem, ContextMenuSeparator } from "../ui/context-menu";

type Translate = ReturnType<typeof useI18n>["t"];

const LIVE_SERVER_ERROR_KEYS: Readonly<Record<string, TranslationKey>> = Object.freeze({
  root_not_absolute: "files.liveServer.error.invalidRoot",
  root_canonicalize_failed: "files.liveServer.error.invalidRoot",
  root_not_directory: "files.liveServer.error.invalidRoot",
  wsl_live_server_unsupported: "files.liveServer.error.unsupportedEnvironment",
  path_contains_backslash: "files.liveServer.error.invalidPath",
  path_contains_current_segment: "files.liveServer.error.invalidPath",
  path_contains_parent_segment: "files.liveServer.error.invalidPath",
  path_contains_empty_segment: "files.liveServer.error.invalidPath",
  path_is_absolute: "files.liveServer.error.invalidPath",
  path_empty: "files.liveServer.error.invalidPath",
  invalid_url_encoding: "files.liveServer.error.invalidPath",
  path_outside_root: "files.liveServer.error.outsideRoot",
  entry_not_html: "files.liveServer.error.notHtml",
  entry_not_found: "files.liveServer.error.notFound",
  listener_bind_failed: "files.liveServer.error.listener",
  listener_config_failed: "files.liveServer.error.listener",
  listener_address_failed: "files.liveServer.error.listener",
  watcher_init_failed: "files.liveServer.error.watcher",
  watch_failed: "files.liveServer.error.watcher",
  browser_open_failed: "files.liveServer.error.browser",
  lock_poisoned: "files.liveServer.error.internal",
});

const useLiveServerStore = createLiveServerStore(tauriLiveServerClient);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function translateError(error: unknown, t: Translate): string {
  const message = errorMessage(error);
  const code = message.split(":", 1)[0].trim();
  const key = LIVE_SERVER_ERROR_KEYS[code];
  return key ? `${t(key)} (${message})` : t("files.liveServer.error.unknown", { error: message });
}

type LiveServerFileTarget = Pick<ProjectFileEntry, "kind" | "name" | "path">;

export function isLiveServerHtmlEntry(project: Project | null, entry: LiveServerFileTarget): boolean {
  if (project?.environment_type !== "local" || entry.kind !== "file") return false;
  return /\.html?$/i.test(entry.name);
}

export function LiveServerStatusBridge({ project }: { readonly project: Project }) {
  const hydrate = useLiveServerStore((state) => state.hydrate);

  useEffect(() => {
    if (project.environment_type !== "local") return;
    void hydrate(project.path).catch((error) => {
      console.error("[live_server] status hydration failed", error);
    });
  }, [hydrate, project.environment_type, project.path]);

  return null;
}

export function LiveServerFileMenuItem({
  project,
  entry,
}: {
  readonly project: Project | null;
  readonly entry: LiveServerFileTarget;
}) {
  const { t } = useI18n();
  const pending = useLiveServerStore((state) => project ? state.projects[project.path]?.pending ?? null : null);
  const startAndOpen = useLiveServerStore((state) => state.startAndOpen);
  if (!project || !isLiveServerHtmlEntry(project, entry)) return null;

  const open = async () => {
    try {
      const result = await startAndOpen(project.path, entry.path);
      const key = result.reused ? "files.liveServer.toast.reused" : "files.liveServer.toast.opened";
      toast.success(t(key), { description: result.url });
    } catch (error) {
      toast.error(t("files.liveServer.toast.openFailed"), { description: translateError(error, t) });
    }
  };

  return (
    <>
      <ContextMenuItem disabled={pending !== null} onSelect={() => void open()}>
        <Globe size={13} /> {t(pending === "start" ? "files.liveServer.opening" : "files.liveServer.open")}
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}

export function LiveServerRootMenuItem({ project }: { readonly project: Project }) {
  const { t } = useI18n();
  const session = useLiveServerStore((state) => state.projects[project.path]?.session ?? null);
  const pending = useLiveServerStore((state) => state.projects[project.path]?.pending ?? null);
  const stop = useLiveServerStore((state) => state.stop);
  if (project.environment_type !== "local" || !session) return null;

  const stopServer = async () => {
    try {
      await stop(project.path);
      toast.success(t("files.liveServer.toast.stopped"));
    } catch (error) {
      toast.error(t("files.liveServer.toast.stopFailed"), { description: translateError(error, t) });
    }
  };

  return (
    <>
      <ContextMenuSeparator />
      <ContextMenuItem disabled={pending !== null} onSelect={() => void stopServer()}>
        <CircleStop size={13} /> {t(pending === "stop" ? "files.liveServer.stopping" : "files.liveServer.stop")}
      </ContextMenuItem>
    </>
  );
}
