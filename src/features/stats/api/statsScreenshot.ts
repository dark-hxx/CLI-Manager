const MAX_PIXELS = 16_000_000;
const MAX_DIMENSION = 16_384;
const MAX_NODES = 10_000;
const MIN_PIXEL_RATIO = 2;
const MAX_PIXEL_RATIO = 3;

/**
 * 尺寸类属性：文本叶子节点的宽度/高度是“内容撑开”的结果，实测值往往与可容纳的文本宽度
 * 恰好相等；把它冻结成绝对像素后，光栅化时字体度量只要差零点几像素就会把文字挤到下一行
 * （统计长图里右上的“91 条”胶囊就是这么断行的）。这类节点保留 auto，让图片文档按同样的
 * flex/文本规则重新排版，非文本节点（图标、图表、色块）仍冻结尺寸以保住固定大小。
 */
const CONTENT_SIZED_PROPERTIES = new Set([
  "width", "height", "inline-size", "block-size",
]);

let exportStylePropertyCache: string[] | null = null;

/**
 * html-to-image 的 cloneCSSStyle 会把每个节点的**全部** computed style 重新写回克隆体，
 * 于是上面刻意留空的 width/height 又会被补回来，换行边界依旧被冻死。
 * 用 includeStyleProperties 收窄它的拷贝集合；其余属性与 html-to-image 的默认实现
 * （documentElement 的全部 computed style）保持一致，避免丢样式。
 */
function exportStyleProperties(): string[] {
  if (!exportStylePropertyCache) {
    exportStylePropertyCache = Array.from(getComputedStyle(document.documentElement))
      .filter((property) => !CONTENT_SIZED_PROPERTIES.has(property));
  }
  return exportStylePropertyCache;
}

/** Export at high density while scaling extreme long panels proportionally instead of clipping them. */
export function screenshotPixelRatio(width: number, height: number, deviceRatio: number): number {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("stats_screenshot_unavailable");
  }
  const ratio = Math.min(
    Math.max(MIN_PIXEL_RATIO, Number.isFinite(deviceRatio) ? deviceRatio : 1), MAX_PIXEL_RATIO,
    MAX_DIMENSION / width, MAX_DIMENSION / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
  if (ratio < 0.5) throw new Error("stats_screenshot_too_large");
  return ratio;
}

function snapshotPanel(source: HTMLElement): { host: HTMLDivElement; panel: HTMLElement } {
  const width = source.getBoundingClientRect().width;
  if (!source.isConnected || width <= 0) throw new Error("stats_screenshot_unavailable");
  const originals = [source, ...source.querySelectorAll<HTMLElement | SVGElement>("*")];
  if (originals.length > MAX_NODES) throw new Error("stats_screenshot_too_large");
  const panel = source.cloneNode(true) as HTMLElement;
  const clones = [panel, ...panel.querySelectorAll<HTMLElement | SVGElement>("*")];
  // Freeze inherited theme variables and pixels before any await/poll/tab change.
  originals.forEach((original, index) => {
    const clone = clones[index];
    const computed = getComputedStyle(original);
    const isTextLeaf = original.childElementCount === 0 && !(original instanceof HTMLCanvasElement)
      && (original.textContent ?? "").trim().length > 0;
    for (const property of Array.from(computed)) {
      if (isTextLeaf && CONTENT_SIZED_PROPERTIES.has(property)) continue;
      clone.style.setProperty(property, computed.getPropertyValue(property));
    }
    clone.style.setProperty("animation", "none", "important");
    clone.style.setProperty("transition", "none", "important");
    if (original instanceof HTMLCanvasElement && clone instanceof HTMLCanvasElement) {
      const context = clone.getContext("2d");
      if (!context) throw new Error("stats_screenshot_unavailable");
      context.drawImage(original, 0, 0);
    }
  });
  panel.querySelectorAll("[data-stats-screenshot-exclude], [role=dialog]").forEach((node) => node.remove());
  Object.assign(panel.style, {
    width: `${width}px`, height: "auto", minHeight: "0", maxHeight: "none",
    position: "relative", inset: "auto", overflow: "visible", flex: "none", margin: "0",
  });
  const scroll = panel.querySelector<HTMLElement>("[data-stats-screenshot-scroll]");
  if (!scroll) throw new Error("stats_screenshot_unavailable");
  Object.assign(scroll.style, { height: "auto", minHeight: "0", maxHeight: "none", overflow: "visible", flex: "none" });
  panel.querySelectorAll<HTMLElement>("[data-stats-screenshot-expand]").forEach((node) => {
    Object.assign(node.style, { height: "auto", maxHeight: "none", overflow: "visible" });
  });
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.inert = true;
  host.dataset.statsScreenshotHost = "";
  Object.assign(host.style, { position: "fixed", left: "-100000px", top: "0", pointerEvents: "none" });
  host.append(panel);
  document.body.append(host);
  return { host, panel };
}

export async function captureStatsImage(source: HTMLElement): Promise<HTMLCanvasElement> {
  const { host, panel } = snapshotPanel(source);
  try {
    const { toCanvas } = await import("html-to-image");
    await document.fonts.ready;
    const width = Math.ceil(panel.getBoundingClientRect().width);
    const height = Math.ceil(Math.max(panel.scrollHeight, panel.getBoundingClientRect().height));
    return await toCanvas(panel, {
      width, height,
      pixelRatio: screenshotPixelRatio(width, height, window.devicePixelRatio),
      preferredFontFormat: "woff2",
      style: { margin: "0" },
      includeStyleProperties: exportStyleProperties(),
    });
  } finally {
    host.remove();
  }
}
