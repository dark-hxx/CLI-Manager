import { useEffect, useRef, type CSSProperties } from "react";
import type { EChartsOption, EChartsType } from "echarts";

interface EChartProps {
  option: EChartsOption;
  className?: string;
  style?: CSSProperties;
}

let echartsPromise: Promise<typeof import("echarts")> | null = null;

function loadECharts() {
  echartsPromise ??= import("echarts");
  return echartsPromise;
}

// ECharts 自身无法解析 CSS 变量 / color-mix() 颜色字符串：初始渲染靠浏览器解析 SVG
// 属性尚能显示，但一旦进入 emphasis/blur 状态，ECharts 需自行解析颜色派生高亮色，
// 解析 `var(...)` / `color-mix(...)` 失败会得到空/透明色，导致悬浮时折线、柱状整体消失。
// 这里用一个隐藏探针元素把任意 CSS 颜色（含 var()/color-mix()）解析为具体 rgb 再交给 ECharts。
let colorProbe: HTMLSpanElement | null = null;

function getColorProbe(): HTMLSpanElement | null {
  if (typeof document === "undefined") return null;
  if (!colorProbe) {
    colorProbe = document.createElement("span");
    colorProbe.setAttribute("aria-hidden", "true");
    colorProbe.style.cssText =
      "position:absolute;left:-9999px;top:-9999px;width:0;height:0;visibility:hidden;pointer-events:none;";
    document.body.appendChild(colorProbe);
  }
  return colorProbe;
}

function resolveCssColor(value: string): string {
  if (!value.includes("var(") && !value.includes("color-mix(")) return value;
  const probe = getColorProbe();
  if (!probe) return value;
  probe.style.color = "";
  probe.style.color = value;
  // 无效颜色：浏览器忽略赋值，style.color 仍为空 → 保留原值，避免读到继承默认色。
  if (probe.style.color === "") return value;
  const resolved = getComputedStyle(probe).color;
  return resolved || value;
}

// 深度遍历 option，把字符串里的 var()/color-mix() 解析为具体 rgb。
// 跳过函数（formatter 等）——其运行时返回的 HTML 内联 var() 由浏览器在 tooltip DOM 中解析。
function deepResolveColors(input: unknown): unknown {
  if (typeof input === "string") return resolveCssColor(input);
  if (Array.isArray(input)) return input.map(deepResolveColors);
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      out[key] = typeof val === "function" ? val : deepResolveColors(val);
    }
    return out;
  }
  return input;
}

function resolveOption(option: EChartsOption): EChartsOption {
  return deepResolveColors(option) as EChartsOption;
}

export function EChart({ option, className, style }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const latestOptionRef = useRef(option);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;
    let themeObserver: MutationObserver | null = null;

    void loadECharts().then((echarts) => {
      if (disposed || !containerRef.current) return;
      const chart = echarts.init(containerRef.current, undefined, { renderer: "svg" });
      chartRef.current = chart;
      chart.setOption(resolveOption(latestOptionRef.current), { notMerge: true, lazyUpdate: true });
      resizeObserver = new ResizeObserver(() => chart.resize());
      resizeObserver.observe(containerRef.current);

      // 主题 / 调色板切换时，根元素的 data-theme / data-*-palette 属性变更，
      // CSS 变量随之改变 → 重新解析并下发颜色，确保图表跟随主题。
      themeObserver = new MutationObserver(() => {
        chartRef.current?.setOption(resolveOption(latestOptionRef.current), {
          notMerge: true,
          lazyUpdate: true,
        });
      });
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-light-palette", "data-dark-palette"],
      });
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    latestOptionRef.current = option;
    chartRef.current?.setOption(resolveOption(option), { notMerge: true, lazyUpdate: true });
  }, [option]);

  return <div ref={containerRef} className={className} style={style} />;
}
