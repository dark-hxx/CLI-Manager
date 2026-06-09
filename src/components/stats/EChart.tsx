import { useEffect, useRef } from "react";
import type { EChartsOption, EChartsType } from "echarts";

interface EChartProps {
  option: EChartsOption;
  className?: string;
}

let echartsPromise: Promise<typeof import("echarts")> | null = null;

function loadECharts() {
  echartsPromise ??= import("echarts");
  return echartsPromise;
}

export function EChart({ option, className }: EChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const latestOptionRef = useRef(option);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let resizeObserver: ResizeObserver | null = null;

    void loadECharts().then((echarts) => {
      if (disposed || !containerRef.current) return;
      const chart = echarts.init(containerRef.current, undefined, { renderer: "svg" });
      chartRef.current = chart;
      chart.setOption(latestOptionRef.current, { notMerge: true, lazyUpdate: true });
      resizeObserver = new ResizeObserver(() => chart.resize());
      resizeObserver.observe(containerRef.current);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    latestOptionRef.current = option;
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  return <div ref={containerRef} className={className} />;
}
