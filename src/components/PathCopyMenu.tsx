import { ChevronRight, Copy, Link2, Sparkles } from "./icons";
import { copyText } from "../lib/aiClipboard";
import { formatAiPathBlock } from "../lib/aiPathFormatter";
import { formatProjectAbsolutePath, formatProjectRelativePath, type CopyPathKind, type ProjectPathContext } from "../lib/projectPathFormatter";
import { useI18n } from "../lib/i18n";
import { useEffect, useRef, useState } from "react";
import { ContextMenuItem } from "./ui/context-menu";

interface PathCopyMenuProps {
  project: ProjectPathContext;
  relativePath: string;
  kind: CopyPathKind;
}

export function PathCopyMenu({ project, relativePath, kind }: PathCopyMenuProps) {
  const { t } = useI18n();
  const [showFormats, setShowFormats] = useState(false);
  const firstFormatItemRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showFormats) return;
    const frame = window.requestAnimationFrame(() => firstFormatItemRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [showFormats]);

  const copy = (value: string, successMessage: string) => {
    void copyText(value, successMessage, t("files.toast.copyFailed"));
  };

  if (showFormats) {
    return (
      <div className="path-copy-menu-replacement context-menu file-explorer-menu">
        <ContextMenuItem
          ref={firstFormatItemRef}
          onSelect={() => copy(formatAiPathBlock(relativePath, kind), t("files.toast.aiPathCopied"))}
        >
          <Sparkles size={13} /> {t("files.menu.copyAiPath")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(formatProjectRelativePath(relativePath), t("files.toast.relativePathCopied"))}>
          <Link2 size={13} /> {t("files.menu.copyRelativePath")}
        </ContextMenuItem>
      </div>
    );
  }

  return (
    <>
      <ContextMenuItem onSelect={() => copy(formatProjectAbsolutePath(project, relativePath), t("files.toast.pathCopied"))}>
        <Copy size={13} /> {t("files.menu.copyPath")}
      </ContextMenuItem>
      <ContextMenuItem
        aria-haspopup="menu"
        aria-expanded={showFormats}
        onSelect={(event) => {
          event.preventDefault();
          setShowFormats(true);
        }}
      >
        <Copy size={13} />
        <span className="min-w-0 flex-1">{t("files.menu.copyPathAs")}</span>
        <ChevronRight size={12} aria-hidden="true" />
      </ContextMenuItem>
    </>
  );
}
