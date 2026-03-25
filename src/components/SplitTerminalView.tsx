import { useRef, useCallback } from "react";
import { XTermTerminal } from "./XTermTerminal";
import { useTerminalStore, type SplitState } from "../stores/terminalStore";
import type { LightThemePalette, DarkThemePalette } from "../stores/settingsStore";

interface Props {
  sessionId: string;
  split: SplitState | undefined;
  isActive?: boolean;
  fontSize: number;
  fontFamily: string;
  resolvedTheme: "dark" | "light";
  terminalThemeName: string;
  lightThemePalette: LightThemePalette;
  darkThemePalette: DarkThemePalette;
}

export function SplitTerminalView({
  sessionId,
  split,
  isActive,
  fontSize,
  fontFamily,
  resolvedTheme,
  terminalThemeName,
  lightThemePalette,
  darkThemePalette,
}: Props) {
  const setSplitRatio = useTerminalStore((s) => s.setSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container || !split) return;

      const rect = container.getBoundingClientRect();
      const isH = split.direction === "horizontal";

      const onMove = (ev: MouseEvent) => {
        const ratio = isH
          ? (ev.clientX - rect.left) / rect.width
          : (ev.clientY - rect.top) / rect.height;
        setSplitRatio(sessionId, ratio);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = isH ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [sessionId, split, setSplitRatio],
  );

  if (!split) {
    return (
      <XTermTerminal
        sessionId={sessionId}
        isActive={isActive}
        fontSize={fontSize}
        fontFamily={fontFamily}
        resolvedTheme={resolvedTheme}
        terminalThemeName={terminalThemeName}
        lightThemePalette={lightThemePalette}
        darkThemePalette={darkThemePalette}
      />
    );
  }

  const isH = split.direction === "horizontal";
  const first = `${split.ratio * 100}%`;
  const second = `${(1 - split.ratio) * 100}%`;

  return (
    <div ref={containerRef} className="w-full h-full flex" style={{ flexDirection: isH ? "row" : "column" }}>
      <div className="overflow-hidden" style={{ [isH ? "width" : "height"]: first }}>
        <XTermTerminal
          sessionId={sessionId}
          isActive={isActive}
          fontSize={fontSize}
          fontFamily={fontFamily}
          resolvedTheme={resolvedTheme}
          terminalThemeName={terminalThemeName}
          lightThemePalette={lightThemePalette}
          darkThemePalette={darkThemePalette}
        />
      </div>
      <div
        onMouseDown={handleDragStart}
        className="shrink-0 hover:opacity-100 transition-colors"
        style={{
          [isH ? "width" : "height"]: "4px",
          backgroundColor: "var(--border)",
          cursor: isH ? "col-resize" : "row-resize",
        }}
      />
      <div className="overflow-hidden" style={{ [isH ? "width" : "height"]: second }}>
        <XTermTerminal
          sessionId={split.secondSessionId}
          isActive={isActive}
          fontSize={fontSize}
          fontFamily={fontFamily}
          resolvedTheme={resolvedTheme}
          terminalThemeName={terminalThemeName}
          lightThemePalette={lightThemePalette}
          darkThemePalette={darkThemePalette}
        />
      </div>
    </div>
  );
}
