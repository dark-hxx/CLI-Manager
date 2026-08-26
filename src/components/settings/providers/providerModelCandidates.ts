import type {
  ComboboxParsedItem,
  ComboboxParsedItemGroup,
  OptionsFilter,
} from "@mantine/core";
import type { NativeProviderAppType } from "./nativeProviderTypes";
import { stripOneM } from "./providerModelValue";

/**
 * 模型下拉框的候选来源合并。
 *
 * `/v1/models` 只在「baseUrl 正确 + 密钥有效 + 供应商真的实现了该接口」时才拿得到，
 * 这三者任一不满足就会退化成让用户手敲模型 ID。所以候选按四级来源兜底，
 * 优先级从高到低：接口返回 > 表单已配置 > 本地价格表 > 同类供应商已用。
 *
 * 纯函数：不读 store、不碰 i18n。分组只返回稳定 id，文案由组件渲染时映射。
 */

export type ModelCandidateGroupId =
  | "fetched"
  | "configured"
  | "priceTable"
  | "peerProviders";

export interface ModelCandidateGroup {
  id: ModelCandidateGroupId;
  items: string[];
}

export interface ModelCandidateSources {
  /** `/v1/models` 本次返回的模型。 */
  fetched: readonly string[];
  /** 当前表单已填的模型值（兜底模型、各角色模型、供应商卡片上的 model）。 */
  configured: readonly string[];
  /** 本地 `model_prices` 表里的模型，建议先过 `priceTableModelsFor()` 粗筛。 */
  priceTableModels: readonly string[];
  /** 同 appType 其它供应商已经在用的模型。 */
  peerProviderModels: readonly string[];
}

/** 各 appType 在价格表里的模型名特征，用于把整表粗筛到相关的那一批。 */
const APP_TYPE_MODEL_HINTS: Record<NativeProviderAppType, readonly string[]> = {
  claude: ["claude"],
  codex: ["gpt", "codex", "o1", "o3", "o4"],
  grokbuild: ["grok"],
};

/**
 * 按 appType 粗筛价格表模型。
 *
 * `model_prices` 表没有 appType 字段，只能按模型名特征匹配。**筛不中时返回整表**——
 * 宁可让用户多翻几项，也不要给一个空下拉框把人逼回手敲。
 */
export function priceTableModelsFor(
  appType: NativeProviderAppType,
  models: readonly string[],
): string[] {
  const hints = APP_TYPE_MODEL_HINTS[appType] ?? [];
  const matched = models.filter((model) => {
    const lowered = model.toLowerCase();
    return hints.some((hint) => lowered.includes(hint));
  });
  const source = matched.length > 0 ? matched : models;
  return [...source].sort((left, right) => left.localeCompare(right));
}

/**
 * 合并候选来源。
 *
 * **接口返回优先且独占**：`/v1/models` 拿到结果时它就是权威列表，不再把本地维护的
 * 模型拼进去——混在一起会让用户分不清哪些是这个供应商真正支持的。只有接口没调过、
 * 调失败、或返回空时，才退回本地三路来源兜底。
 *
 * - 跨组去重：同一模型只出现在优先级最高的那一组里。
 * - 所有值先过 `stripOneM()`，候选里不出现 `[1M]` 后缀（后缀由各角色行的 checkbox 单独控制）。
 * - 空组不产出，避免下拉里出现只有标题的空分组。
 */
export function buildModelCandidates(sources: ModelCandidateSources): ModelCandidateGroup[] {
  const activeSources: ReadonlyArray<[ModelCandidateGroupId, readonly string[]]> =
    hasAnyModel(sources.fetched)
      ? [["fetched", sources.fetched]]
      : [
          ["configured", sources.configured],
          ["priceTable", sources.priceTableModels],
          ["peerProviders", sources.peerProviderModels],
        ];

  const seen = new Set<string>();
  const groups: ModelCandidateGroup[] = [];

  for (const [id, raw] of activeSources) {
    const items: string[] = [];
    for (const value of raw) {
      const model = stripOneM(value).trim();
      // 大小写按原样区分：模型 ID 理论上大小写敏感，不替用户合并。
      if (!model || seen.has(model)) continue;
      seen.add(model);
      items.push(model);
    }
    if (items.length > 0) groups.push({ id, items });
  }

  return groups;
}

function hasAnyModel(models: readonly string[]): boolean {
  return models.some((model) => stripOneM(model).trim().length > 0);
}

/**
 * 摊平成 Mantine `Autocomplete` 的分组 `data`。
 *
 * 模型字段用 `Autocomplete` 而非 `Select`：供应商的模型 ID 千奇百怪，必须允许用户
 * 直接敲一个不在任何来源里的值。Mantine 的 `Select` 即使开 `searchable` 也只能筛选
 * 既有选项、无法提交任意值；`Autocomplete` 才是「带建议的文本框」。
 */
export function modelCandidatesToSelectData(
  groups: readonly ModelCandidateGroup[],
  labelFor: (id: ModelCandidateGroupId) => string,
): Array<{ group: string; items: string[] }> {
  return groups.map((entry) => ({ group: labelFor(entry.id), items: [...entry.items] }));
}

/**
 * 模型字段的下拉过滤规则。
 *
 * `Autocomplete` 默认拿输入框现值当搜索词过滤选项。模型字段几乎总是已经填着一个值，
 * 默认行为会让下拉里**只剩当前这一项**，用户没法点开去选别的——这正是需要覆盖它的原因。
 *
 * 规则：输入值命中某个候选（即「用户没在搜，只是字段里有值」）时展示全部候选；
 * 用户真的敲了新内容时才按子串过滤。与 Mantine 官方分组可搜索示例同一套判定。
 *
 * 子串过滤结果为空时同样退回展示全部：已配置的模型未必在接口返回的列表里
 * （自建/聚合站尤其常见），否则点开字段只会看到一个空下拉。
 */
export const modelOptionsFilter: OptionsFilter = ({ options, search }) => {
  const query = search.trim().toLowerCase();
  if (!query || optionValues(options).some((value) => value.toLowerCase() === query)) {
    return options;
  }
  const matches = (value: string) => value.toLowerCase().includes(query);
  // 分组数据里每一项可能是单个选项，也可能是 { group, items }，两种都要处理。
  const filtered = options.flatMap<ComboboxParsedItem>((entry) => {
    if (!isOptionGroup(entry)) return matches(entry.value) ? [entry] : [];
    const items = entry.items.filter((item) => matches(item.value));
    return items.length > 0 ? [{ ...entry, items }] : [];
  });
  return optionValues(filtered).length > 0 ? filtered : options;
};

function isOptionGroup(entry: ComboboxParsedItem): entry is ComboboxParsedItemGroup {
  return "group" in entry;
}

function optionValues(options: readonly ComboboxParsedItem[]): string[] {
  return options.flatMap((entry) => (
    isOptionGroup(entry) ? entry.items.map((item) => item.value) : [entry.value]
  ));
}
