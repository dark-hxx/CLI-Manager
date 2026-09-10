import { useRef, useState } from "react";
import type { TranslationKey } from "./i18n";

type Props = {
  enabled: boolean;
  t: (key: TranslationKey) => string;
  onFocus: () => void;
  onPaste: (text: string) => void;
  onKey: (key: string) => void;
};

export function MobileTerminalInput({ enabled, t, onFocus, onPaste, onKey }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const composing = useRef(false);
  const send = () => {
    if (!enabled || composing.current || !draft) return;
    // Pasting newline into a shell without bracketed paste can execute it.
    onPaste(draft.replace(/[\r\n\t]+/g, " ").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, ""));
    setDraft("");
  };
  return <div className="mobile-terminal-input">
    <div className="mobile-terminal-input-toolbar">
      <button type="button" disabled={!enabled} onClick={onFocus} aria-label={t("mobileKeyboard")}>{t("mobileKeyboard")}</button>
      <button type="button" disabled={!enabled} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("mobileFallback")}</button>
      {([
        ["mobileEnter", "\r", null], ["mobileTab", "\t", null], ["mobileEscape", "\x1b", null], ["mobileInterrupt", "\x03", null],
        ["mobileArrowLeft", "\x1b[D", "←"], ["mobileArrowUp", "\x1b[A", "↑"],
        ["mobileArrowDown", "\x1b[B", "↓"], ["mobileArrowRight", "\x1b[C", "→"],
      ] as const).map(([label, key, glyph]) => <button key={label} type="button" disabled={!enabled}
        aria-label={t(label)} onPointerDown={(event) => event.preventDefault()}
        onClick={() => { if (enabled && !composing.current) onKey(key); }}>{glyph ?? t(label)}</button>)}
    </div>
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
