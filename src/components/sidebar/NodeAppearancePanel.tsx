import { useEffect, useMemo, useState } from "react";
import data from "@emoji-mart/data";
import {
  NODE_ACCENT_TOKENS,
  NODE_BRAND_ICON_DEFINITIONS,
  isNodeBrandIconKey,
  isSingleCharMark,
  nodeAccentVar,
  nodeBrandIconSource,
  type NodeBrandIconKey,
} from "../../lib/nodeAppearance";
import { useI18n, type TranslationKey } from "../../lib/i18n";
import { Popover, PopoverAnchor, PopoverContent } from "../ui/popover";

const NODE_BRAND_LABEL_KEYS: Record<NodeBrandIconKey, TranslationKey> = {
  "brand-feishu": "sidebar.appearance.brandFeishu",
  "brand-xiaohongshu": "sidebar.appearance.brandXiaohongshu",
  "brand-bilibili": "sidebar.appearance.brandBilibili",
};

const EMOJI_CATEGORY_META = [
  { id: "people", icon: "🙂", labelKey: "sidebar.appearance.emojiCategoryPeople" },
  { id: "nature", icon: "🐻", labelKey: "sidebar.appearance.emojiCategoryNature" },
  { id: "foods", icon: "🍎", labelKey: "sidebar.appearance.emojiCategoryFoods" },
  { id: "activity", icon: "⚽", labelKey: "sidebar.appearance.emojiCategoryActivity" },
  { id: "places", icon: "🚗", labelKey: "sidebar.appearance.emojiCategoryPlaces" },
  { id: "objects", icon: "💡", labelKey: "sidebar.appearance.emojiCategoryObjects" },
  { id: "symbols", icon: "🔣", labelKey: "sidebar.appearance.emojiCategorySymbols" },
  { id: "flags", icon: "🏳️", labelKey: "sidebar.appearance.emojiCategoryFlags" },
  { id: "brands", icon: "✦", labelKey: "sidebar.appearance.brandCategory" },
] as const satisfies readonly { id: string; icon: string; labelKey: TranslationKey }[];

type EmojiCategoryId = (typeof EMOJI_CATEGORY_META)[number]["id"];

interface EmojiMartEmoji {
  id: string;
  name: string;
  keywords: string[];
  skins: Array<{ native?: string }>;
}

interface EmojiMartData {
  categories: Array<{ id: string; emojis: string[] }>;
  emojis: Record<string, EmojiMartEmoji>;
}

const EMOJI_DATA = data as unknown as EmojiMartData;

interface NodeAppearancePanelProps {
  /** 当前 `icon` 列的值（可能是单字符标记或内置图标 key）。 */
  icon: string;
  /** 当前 `color` 列的值（调色板 token 或空串）。 */
  color: string;
  /** 只回传发生变化的字段；空串表示"恢复自动"。 */
  onChange: (next: { icon?: string; color?: string }) => void;
  /** 选中颜色后是否需要调用方收起容器（右键菜单场景用）。 */
  onAfterPick?: () => void;
}

/**
 * 外观编辑面板：10 色调色板 + 自动 + 点击打开 Emoji 选择器 + 自定义标记输入。
 * 位置无关，既可放进右键菜单内联展开，也可塞进 Popover。
 */
export function NodeAppearancePanel({ icon, color, onChange, onAfterPick }: NodeAppearancePanelProps) {
  const { language, t } = useI18n();
  const [markDraft, setMarkDraft] = useState(icon);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [activeEmojiCategory, setActiveEmojiCategory] = useState<EmojiCategoryId>("people");
  const [emojiQuery, setEmojiQuery] = useState("");
  const selectedBrand = isNodeBrandIconKey(markDraft) ? markDraft : null;
  const markInvalid = !selectedBrand && markDraft.trim() !== "" && !isSingleCharMark(markDraft.trim());

  useEffect(() => {
    setMarkDraft(icon);
  }, [icon]);

  const commitMark = () => {
    const next = markDraft.trim();
    // Brand marks use an image background in the compact input, so its text value is empty.
    if (isNodeBrandIconKey(icon) && next === "") return;
    if (next === icon) return;
    if (next !== "" && !isSingleCharMark(next)) return;
    onChange({ icon: next });
  };

  const pickMark = (mark: string) => {
    setMarkDraft(mark);
    if (mark !== icon) onChange({ icon: mark });
    setPickerOpen(false);
    onAfterPick?.();
  };

  const visibleEmoji = useMemo(() => {
    const query = emojiQuery.trim().toLocaleLowerCase(language === "zh-CN" ? "zh-CN" : "en-US");
    const category = EMOJI_DATA.categories.find((item) => item.id === activeEmojiCategory);
    const source = query
      ? Object.values(EMOJI_DATA.emojis)
      : (category?.emojis ?? []).map((emojiId) => EMOJI_DATA.emojis[emojiId]).filter(Boolean);

    return source.filter((emoji) => {
      const native = emoji.skins[0]?.native;
      if (!native) return false;
      if (!query) return true;
      return [emoji.id, emoji.name, ...emoji.keywords]
        .join(" ")
        .toLocaleLowerCase(language === "zh-CN" ? "zh-CN" : "en-US")
        .includes(query);
    });
  }, [activeEmojiCategory, emojiQuery, language]);

  const pickColor = (token: string) => {
    if (token !== color) onChange({ color: token });
    onAfterPick?.();
  };

  const markInputValue = selectedBrand ? "" : markDraft;

  return (
    <div className="ui-appearance-panel" onMouseDown={(event) => event.stopPropagation()}>
      <div className="ui-appearance-swatches" role="group" aria-label={t("sidebar.appearance.colorLabel")}>
        <button
          type="button"
          className="ui-appearance-swatch ui-appearance-default"
          style={{ backgroundColor: "var(--accent)" }}
          data-selected={color === "" ? "true" : "false"}
          title={t("sidebar.appearance.default")}
          aria-label={t("sidebar.appearance.default")}
          aria-pressed={color === ""}
          onClick={() => pickColor("")}
        />
        {NODE_ACCENT_TOKENS.map((token, index) => (
          <button
            key={token}
            type="button"
            className="ui-appearance-swatch"
            style={{ backgroundColor: nodeAccentVar(token) }}
            data-selected={color === token ? "true" : "false"}
            title={t("sidebar.appearance.colorOption", { index: index + 1 })}
            aria-label={t("sidebar.appearance.colorOption", { index: index + 1 })}
            aria-pressed={color === token}
            onClick={() => pickColor(token)}
          />
        ))}
      </div>
      <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <PopoverAnchor asChild>
          <input
            className="ui-appearance-mark-input ui-focus-ring"
            value={markInputValue}
            style={selectedBrand ? { backgroundImage: `url(${nodeBrandIconSource(selectedBrand)})` } : undefined}
            data-brand={selectedBrand ? "true" : undefined}
            aria-label={t("sidebar.appearance.markLabel")}
            aria-invalid={markInvalid}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            onFocus={() => setPickerOpen(true)}
            onClick={() => setPickerOpen(true)}
            onChange={(event) => setMarkDraft(event.target.value)}
            onBlur={commitMark}
            onKeyDown={(event) => {
              if (selectedBrand && (event.key === "Backspace" || event.key === "Delete")) {
                event.preventDefault();
                setMarkDraft("");
                onChange({ icon: "" });
                return;
              }
              if (event.key === "Enter") {
                event.preventDefault();
                commitMark();
                onAfterPick?.();
              }
              if (event.key === "Escape") setMarkDraft(icon);
            }}
          />
        </PopoverAnchor>
        <PopoverContent
          className="ui-appearance-picker-popover"
          data-node-appearance-picker="true"
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <div className="ui-appearance-picker" data-node-appearance-picker="true">
            <div className="ui-appearance-picker-tabs" role="tablist" aria-label={t("sidebar.appearance.emojiCategoriesLabel")}>
              {EMOJI_CATEGORY_META.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className="ui-appearance-picker-tab"
                  role="tab"
                  aria-selected={activeEmojiCategory === category.id}
                  aria-label={t(category.labelKey)}
                  title={t(category.labelKey)}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setEmojiQuery("");
                    setActiveEmojiCategory(category.id);
                  }}
                >
                  {category.icon}
                </button>
              ))}
            </div>
            <div className="ui-appearance-picker-search-wrap">
              <input
                type="search"
                className="ui-appearance-picker-search ui-focus-ring"
                value={emojiQuery}
                onChange={(event) => setEmojiQuery(event.target.value)}
                placeholder={t("sidebar.appearance.emojiSearchPlaceholder")}
                aria-label={t("sidebar.appearance.emojiSearchLabel")}
              />
            </div>
            <div className="ui-appearance-picker-content">
              <p className="ui-appearance-picker-title">
                {emojiQuery
                  ? t("sidebar.appearance.emojiSearchResults")
                  : t(EMOJI_CATEGORY_META.find((category) => category.id === activeEmojiCategory)?.labelKey ?? "sidebar.appearance.emojiCategoryPeople")}
              </p>
              <div className="ui-appearance-picker-scroll">
                {activeEmojiCategory === "brands" && !emojiQuery ? (
                  <div className="ui-appearance-picker-brand-grid">
                    {NODE_BRAND_ICON_DEFINITIONS.map((brand) => (
                      <button
                        key={brand.key}
                        type="button"
                        className="ui-appearance-picker-brand-button"
                        aria-label={t(NODE_BRAND_LABEL_KEYS[brand.key])}
                        title={t(NODE_BRAND_LABEL_KEYS[brand.key])}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pickMark(brand.key)}
                      >
                        <img src={nodeBrandIconSource(brand.key)} alt="" aria-hidden="true" />
                      </button>
                    ))}
                  </div>
                ) : visibleEmoji.length > 0 ? (
                  <div className="ui-appearance-picker-grid">
                    {visibleEmoji.map((emoji) => {
                      const native = emoji.skins[0]?.native;
                      if (!native) return null;
                      return (
                        <button
                          key={emoji.id}
                          type="button"
                          className="ui-appearance-emoji-button"
                          aria-label={t("sidebar.appearance.emojiSelect", { emoji: native })}
                          title={t("sidebar.appearance.emojiSelect", { emoji: native })}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => pickMark(native)}
                        >
                          {native}
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <p className="ui-appearance-picker-empty">{t("sidebar.appearance.emojiSearchEmpty")}</p>
                )}
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
      {markInvalid && <p className="ui-appearance-hint">{t("sidebar.appearance.markInvalid")}</p>}
    </div>
  );
}
