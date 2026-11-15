import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { ArrowUp, ImagePlus, Keyboard, LoaderCircle, Plus, Square } from "lucide-react";
import { composerAction, modifyCharacter, type Modifiers } from "./input";
import { Menu } from "./Menu";
import { fill, type Translate } from "./i18n";
import { DRAFT_LIMIT } from "./completion";
import { useComposerCompletion, type CompletionContext } from "./useComposerCompletion";
import { ComposerCompletion } from "./ComposerCompletion";

/** Draft ownership is per account/device/session, independent of selected display mode. */
export function Composer({ storageKey, disabled, blocked, phone, cli, modifiers, clearModifiers, onPresence,
  onCharacter, onSend, onInterrupt, onDirect, onImage, completion, t }: {
  storageKey: string; disabled: boolean; blocked?: string; phone: boolean; cli: string;
  modifiers: Modifiers; clearModifiers: () => void;
  /** Focus and draft presence; the key strip steps aside while a message is being written. */
  onPresence?: (focused: boolean, drafting: boolean) => void;
  onCharacter: (bytes: string) => boolean; onSend: (text: string) => Promise<boolean>;
  onInterrupt: () => void; onDirect: () => void; onImage: (file: File) => Promise<string>; t: Translate;
  completion?: CompletionContext;
}) {
  const [draft, setDraft] = useState(() => { try { return localStorage.getItem(storageKey) ?? ""; } catch { return ""; } });
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [adding, setAdding] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const image = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [ime, setIme] = useState(false);
  const [caret, setCaret] = useState<[number, number]>([draft.length, draft.length]);
  const pendingCaret = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const mounted = useRef(true);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    try { if (draft) localStorage.setItem(storageKey, draft); else localStorage.removeItem(storageKey); } catch { /* Storage may be disabled. */ }
    const element = input.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${Math.min(phone ? 150 : 168, element.scrollHeight)}px`;
    }
  }, [draft, storageKey, phone]);
  const send = async () => {
    if (busy.current || disabled || composing.current || !draft.trim()) return;
    busy.current = true; setSending(true); setError("");
    const submitted = draft;
    try {
      const accepted = await onSend(submitted);
      if (mounted.current && accepted && draftRef.current === submitted) setDraft("");
      else if (mounted.current && !accepted) setError(t("sendFailed"));
    } catch (caught) {
      if (mounted.current) setError(caught instanceof Error && caught.message === "multiline_paste_unavailable"
        ? t("multiline_paste_unavailable") : t("unknownDelivery"));
    } finally { busy.current = false; if (mounted.current) setSending(false); }
  };
  // Tool buttons keep the textarea focused, so the phone keyboard does not drop and come back.
  const keepFocus = (event: PointerEvent) => event.preventDefault();
  const placeholder = blocked ?? fill(t("nextStep"), { agent: cli }) + (phone ? "" : t("desktopHint"));
  const [focused, setFocused] = useState(false);
  const menu = useComposerCompletion({ context: completion, scope: storageKey, text: draft, caret,
    enabled: focused && !disabled && !sending && !ime && !adding,
    onReplace: (text, position) => { pendingCaret.current = position; setDraft(text); setCaret([position, position]); },
  });
  useLayoutEffect(() => {
    if (pendingCaret.current === undefined) return;
    input.current?.focus();
    input.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = undefined;
  }, [draft, caret]);
  const presence = useRef(onPresence);
  presence.current = onPresence;
  useEffect(() => { presence.current?.(focused, Boolean(draft)); }, [focused, draft]);
  return <div className="tap-composer-wrap" onBlurCapture={(event) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
  }}>
    <ComposerCompletion menu={menu} t={t} />
    {error && <div className="tap-inline-error" role="alert"><span>{error}</span>
      <button type="button" onClick={() => setError("")}>{t("close")}</button></div>}
    <div className={`tap-composer${disabled ? " is-disabled" : ""}`}>
      <textarea ref={input} value={draft} maxLength={DRAFT_LIMIT} rows={1} aria-label={t("input")}
        role={completion?.enabled ? "combobox" : undefined} aria-autocomplete={completion?.enabled ? "list" : undefined}
        aria-expanded={completion?.enabled ? menu.open : undefined} aria-controls={menu.open ? menu.id : undefined}
        aria-activedescendant={menu.open && menu.items[menu.index] ? `${menu.id}-${menu.index}` : undefined}
        placeholder={placeholder} enterKeyHint={phone ? "enter" : "send"}
        onChange={(event) => {
          const { value, selectionStart, selectionEnd } = event.target;
          setDraft(value); setCaret([selectionStart, selectionEnd]);
        }}
        onSelect={(event) => setCaret([event.currentTarget.selectionStart, event.currentTarget.selectionEnd])}
        onFocus={() => setFocused(true)}
        onCompositionStart={() => { composing.current = true; setIme(true); }}
        onCompositionEnd={(event) => {
          composing.current = false; setIme(false); setCaret([event.currentTarget.selectionStart, event.currentTarget.selectionEnd]);
        }}
        onKeyDown={(event) => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
          if ((modifiers.ctrl || modifiers.alt) && event.key.length === 1 && !event.ctrlKey && !event.metaKey) {
            event.preventDefault();
            if (onCharacter(modifyCharacter(event.key, modifiers))) clearModifiers();
            return;
          }
          if (menu.key(event)) { event.preventDefault(); event.stopPropagation(); return; }
          if (composerAction(event, phone) === "send") { event.preventDefault(); void send(); }
        }} />
      {completion?.enabled && <p className="tap-completion-hint">{t("completionHint")}</p>}
      <div className="tap-composer-row">
        <div className="tap-composer-tools">
          <span className="tap-menu-anchor">
            <button type="button" className="tap-tool is-icon" aria-label={t("add")} title={t("add")}
              aria-haspopup="menu" aria-expanded={adding} disabled={disabled || sending} onPointerDown={keepFocus} onClick={() => setAdding(!adding)}>
              <Plus size={17} />
            </button>
            <Menu open={adding} onClose={() => setAdding(false)} label={t("add")} placement="up-start">
              <button type="button" role="menuitem" onClick={() => { setAdding(false); image.current?.click(); }}>
                <ImagePlus size={16} /><span>{t("uploadImage")}</span>
              </button>
              <button type="button" role="menuitem" onClick={() => { setAdding(false); onDirect(); }}>
                <Keyboard size={16} /><span>{t("direct")}</span>
              </button>
            </Menu>
          </span>
          <span className="tap-tool-seam" aria-hidden />
          <button type="button" className="tap-tool is-stop" title={t("interrupt")} aria-label={t("interrupt")}
            disabled={disabled} onPointerDown={keepFocus} onClick={onInterrupt}>
            <Square size={12} strokeWidth={2.2} /><span>{t("interrupt")}</span>
          </button>
        </div>
        <div className="tap-composer-send">
          <button type="button" className="tap-send" aria-label={t("send")} title={t("send")}
            disabled={disabled || sending || !draft.trim()} onPointerDown={keepFocus} onClick={() => void send()}>
            {sending ? <LoaderCircle size={17} className="tap-spin" /> : <ArrowUp size={18} strokeWidth={2.3} />}
          </button>
        </div>
      </div>
      <input ref={image} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/bmp" hidden onChange={async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || busy.current) return;
        busy.current = true; setSending(true); setError("");
        try {
          const path = await onImage(file);
          if (mounted.current) setDraft((text) => `${text}${text ? " " : ""}${path}`);
        } catch { if (mounted.current) setError(t("imageFailed")); }
        finally { busy.current = false; if (mounted.current) setSending(false); }
      }} />
    </div>
  </div>;
}
