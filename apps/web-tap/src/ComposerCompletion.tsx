import { useEffect, useRef } from "react";
import { ChevronRight, File, Folder, Sparkles, X } from "lucide-react";
import type { useComposerCompletion } from "./useComposerCompletion";
import type { Translate } from "./i18n";

export function ComposerCompletion({ menu, t }: {
  menu: ReturnType<typeof useComposerCompletion>; t: Translate;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [menu.index, menu.items[menu.index]?.id]);
  if (!menu.open) return null;
  const skill = menu.token?.kind === "command";
  const title = skill ? "completionSkills" : "completionFiles";
  return <div className="tap-completion" onPointerDown={(event) => event.preventDefault()}>
    <div className="tap-completion-heading">
      <span>{t(title)}</span>
      <div>{menu.up && <button type="button" onClick={menu.up}>{t("completionParent")}</button>}
        <button type="button" onClick={menu.dismiss} aria-label={t("close")} title={t("close")}><X size={15} /></button></div>
    </div>
    <div ref={list} id={menu.id} className="tap-completion-list" role="listbox"
      aria-label={t(title)} aria-busy={menu.loading}>
      {menu.items.map((item, index) => <button type="button" key={item.id} id={`${menu.id}-${index}`} role="option"
        aria-selected={index === menu.index} tabIndex={-1} className="tap-completion-item" onClick={() => menu.select(item)}>
        {item.kind === "directory" ? <Folder size={16} /> : item.kind === "skill" ? <Sparkles size={16} /> : <File size={16} />}
        <span><b>{item.label}</b>{item.description && <small>{item.description}</small>}</span>
        {item.kind === "directory" && <ChevronRight size={15} />}
      </button>)}
    </div>
    {(menu.error || menu.loading || !menu.items.length) && <p className="tap-completion-state" role="status">
      {t(menu.error ?? (menu.loading ? "loading" : "completionEmpty"))}
      {["completionReadFailed", "completionSkillsReadFailed", "completionSkillsUnbound"].includes(menu.error ?? "")
        && <button type="button" onClick={menu.retry}>{t("retry")}</button>}
    </p>}
    <div className="tap-completion-footer">
      <span>{t(skill ? menu.limited ? "completionSkillsLimited" : "completionSkillNote"
        : menu.limited ? "completionLimited" : "completionFileNote")}</span>
    </div>
  </div>;
}
