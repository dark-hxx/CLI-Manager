import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronUp, ImagePlus } from "lucide-react";
import type { TranslationKey } from "./i18n";

const TOOLBAR_COLLAPSED_KEY = "cli-manager.web.mobile-toolbar-collapsed";

function initialToolbarCollapsed(): boolean {
  try { return localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === "true"; } catch { return false; }
}

type Props = {
  enabled: boolean;
  t: (key: TranslationKey) => string;
  onFocus: () => void;
  onPaste: (text: string) => void;
  onKey: (key: string) => void;
  onImageUpload: (file: File) => void;
  onCollapsedChange?: (collapsed: boolean) => void;
};

export function MobileTerminalInput({ enabled, t, onFocus, onPaste, onKey, onImageUpload, onCollapsedChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(initialToolbarCollapsed);
  const [draft, setDraft] = useState("");
  const composing = useRef(false);
  const [directionPosition, setDirectionPosition] = useState<{ left: number; top: number } | null>(null);
  const directionButton = useRef<HTMLButtonElement>(null);
  const directionPad = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const directionId = useId();
  useEffect(() => { if (!enabled) setDirectionPosition(null); }, [enabled]);
  useEffect(() => {
    try { localStorage.setItem(TOOLBAR_COLLAPSED_KEY, String(toolbarCollapsed)); } catch { /* Browser storage can be disabled. */ }
    if (toolbarCollapsed) {
      setExpanded(false);
      setDirectionPosition(null);
    }
    const frame = requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
    return () => cancelAnimationFrame(frame);
  }, [toolbarCollapsed]);
  useEffect(() => { onCollapsedChange?.(toolbarCollapsed); }, [toolbarCollapsed, onCollapsedChange]);
  useEffect(() => {
    if (!directionPosition) return;
    const dismiss = (event: PointerEvent) => {
      if (!directionPad.current?.contains(event.target as Node) && !directionButton.current?.contains(event.target as Node)) setDirectionPosition(null);
    };
    const close = () => setDirectionPosition(null);
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    window.visualViewport?.addEventListener("resize", close);
    window.visualViewport?.addEventListener("scroll", close);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
      window.visualViewport?.removeEventListener("resize", close);
      window.visualViewport?.removeEventListener("scroll", close);
    };
  }, [directionPosition]);
  const send = () => {
    if (!enabled || composing.current || !draft) return;
    // Pasting newline into a shell without bracketed paste can execute it.
    onPaste(draft.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ""));
    setDraft("");
  };
  if (toolbarCollapsed) return <div className="mobile-terminal-input collapsed">
    <button className="mobile-terminal-input-expand" type="button" onClick={() => setToolbarCollapsed(false)}
      aria-label={t("mobileToolbarExpand")} title={t("mobileToolbarExpand")}><ChevronUp size={20} /></button>
  </div>;
  return <div className="mobile-terminal-input expanded">
    <div className="mobile-terminal-input-toolbar">
      <div className="mobile-terminal-input-tools">
      <button className="mobile-terminal-input-collapse" type="button" onClick={() => setToolbarCollapsed(true)}
        aria-label={t("mobileToolbarCollapse")} title={t("mobileToolbarCollapse")}><ChevronDown size={20} /></button>
      <button type="button" disabled={!enabled} onClick={onFocus} aria-label={t("mobileKeyboard")}>{t("mobileKeyboard")}</button>
      <button type="button" disabled={!enabled} onClick={() => imageInput.current?.click()} aria-label={t("mobileUploadImage")} title={t("mobileUploadImage")}><ImagePlus size={17} /></button>
      <button type="button" disabled={!enabled} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("mobileFallback")}</button>
      {([
        ["mobileTab", "\t", null], ["mobileEscape", "\x1b", null], ["mobileInterrupt", "\x03", null],
      ] as const).map(([label, key, glyph]) => <button key={label} type="button" disabled={!enabled}
        aria-label={t(label)} onPointerDown={(event) => event.preventDefault()}
        onClick={() => { if (enabled && !composing.current) onKey(key); }}>{glyph ?? t(label)}</button>)}
      </div>
      <button ref={directionButton} type="button" className="mobile-direction-toggle" disabled={!enabled}
        aria-expanded={Boolean(enabled && directionPosition)} aria-controls={directionId}
        onPointerDown={(event) => event.preventDefault()} onClick={() => {
          if (!enabled) return;
          if (directionPosition) { setDirectionPosition(null); return; }
          const rect = directionButton.current!.getBoundingClientRect();
          const viewport = window.visualViewport;
          const left = viewport?.offsetLeft ?? 0;
          const top = viewport?.offsetTop ?? 0;
          setDirectionPosition({ left: Math.max(left + 8, Math.min(rect.right - 156, left + (viewport?.width ?? innerWidth) - 164)), top: Math.max(top + 8, rect.top - 164) });
        }}>{t("mobileDirections")}</button>
      <button type="button" className="mobile-terminal-enter" disabled={!enabled} aria-label={t("mobileEnter")}
        onPointerDown={(event) => event.preventDefault()} onClick={() => { if (enabled && !composing.current) onKey("\r"); }}>{t("mobileEnter")}</button>
    </div>
    {enabled && directionPosition && createPortal(<div id={directionId} ref={directionPad} className="mobile-direction-pad" role="group" aria-label={t("mobileDirections")} style={directionPosition}>
      {([
        ["mobileArrowUp", "\x1b[A", "↑", "up"], ["mobileArrowLeft", "\x1b[D", "←", "left"],
        ["mobileArrowRight", "\x1b[C", "→", "right"], ["mobileArrowDown", "\x1b[B", "↓", "down"],
      ] as const).map(([label, key, glyph, direction]) => <button key={label} type="button" className={`direction-${direction}`} aria-label={t(label)}
        onPointerDown={(event) => event.preventDefault()} onClick={() => { if (enabled && !composing.current) onKey(key); }}>{glyph}</button>)}
    </div>, document.body)}
    {expanded && <div className="mobile-terminal-input-fallback">
      <textarea value={draft} disabled={!enabled} rows={2} style={{ fontSize: "16px" }}
        aria-label={t("mobileInput")} placeholder={t("mobileInputHint")}
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)} />
      <button type="button" disabled={!enabled || !draft} onPointerDown={(event) => event.preventDefault()} onClick={send}>{t("mobileSend")}</button>
    </div>}
  </div>;
}
