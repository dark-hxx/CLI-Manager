import { forwardRef, type ComponentType, type ReactNode } from "react";
import type { LucideProps } from "lucide-react";
import { Command as ClassicCommand } from "lucide-react";
import * as Classic from "./icons";
import { useSettingsStore } from "../preferences/settingsStore";

/**
 * 终端操作侧栏的精致图标：仿 SF Symbols 分层渲染，整套只用一种构造——
 * 统一粗细的描边 + 主体 18% 淡色铺底，不用实心块、高光或白色镂空，
 * 颜色全部取 currentColor，由 CSS 的 --terminal-action-color 按终端主题着色。
 * 经典模式原样返回 lucide 图标。
 */
const STROKE = 1.7;

function Wash({ d }: { d: string }) {
  return <path d={d} fill="currentColor" fillOpacity="0.18" stroke="none" />;
}

function createActionIcon(name: string, Original: ComponentType<LucideProps>, body: ReactNode) {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(function TerminalActionIcon(originalProps, ref) {
    const refined = useSettingsStore((state) => state.settingsIconStyle === "refined");
    if (!refined) return <Original ref={ref} {...originalProps} />;
    const { size = 24, strokeWidth: _strokeWidth, absoluteStrokeWidth: _absolute, children, ...props } = originalProps;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
        data-terminal-action-icon={name}
      >
        {body}
        {children}
      </svg>
    );
  });
  Icon.displayName = `TerminalAction${name}`;
  return Icon;
}

const TILE = "M8 3.5h8A4.5 4.5 0 0 1 20.5 8v8a4.5 4.5 0 0 1-4.5 4.5H8A4.5 4.5 0 0 1 3.5 16V8A4.5 4.5 0 0 1 8 3.5Z";

export const NewTerminalIcon = createActionIcon("New", Classic.Plus, (
  <>
    <Wash d={TILE} />
    <path d={TILE} />
    <path d="M12 8.4v7.2M8.4 12h7.2" />
  </>
));

export const TemplatesIcon = createActionIcon("Templates", ClassicCommand, (
  <>
    <Wash d="M9.2 9.2h5.6v5.6H9.2Z" />
    <path d="M9.2 9.2h5.6v5.6H9.2Zm0 0H6.8a2.4 2.4 0 1 1 2.4-2.4Zm5.6 0V6.8a2.4 2.4 0 1 1 2.4 2.4Zm0 5.6h2.4a2.4 2.4 0 1 1-2.4 2.4Zm-5.6 0v2.4a2.4 2.4 0 1 1-2.4-2.4Z" />
  </>
));

const FULLSCREEN_WASH = "M9 7h6a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z";

export const EnterFullscreenIcon = createActionIcon("EnterFullscreen", Classic.Maximize2, (
  <>
    <Wash d={FULLSCREEN_WASH} />
    <path d="M4 9V7a3 3 0 0 1 3-3h2m6 0h2a3 3 0 0 1 3 3v2m0 6v2a3 3 0 0 1-3 3h-2m-6 0H7a3 3 0 0 1-3-3v-2" />
  </>
));

export const ExitFullscreenIcon = createActionIcon("ExitFullscreen", Classic.Minimize2, (
  <>
    <Wash d={FULLSCREEN_WASH} />
    <path d="M9 4v2a3 3 0 0 1-3 3H4m11-5v2a3 3 0 0 0 3 3h2m0 6h-2a3 3 0 0 0-3 3v2m-6 0v-2a3 3 0 0 0-3-3H4" />
  </>
));

export const SessionHistoryIcon = createActionIcon("SessionHistory", Classic.ListClockIcon, (
  <>
    <Wash d="M12 3.6a8.4 8.4 0 1 1 0 16.8 8.4 8.4 0 0 1 0-16.8Z" />
    <path d="M3.6 12a8.4 8.4 0 1 0 2.46-5.94L3.6 8.5m0-4.6v4.6h4.6" />
    <path d="M12 7.8v4.4l2.9 1.8" />
  </>
));

export const ReplayIcon = createActionIcon("Replay", Classic.Activity, (
  <>
    <Wash d={TILE} />
    <path d={TILE} />
    <path d="M7 12.4h2.2l1.7-3.5 2.4 6.4 1.6-2.9H17" />
  </>
));

const FOLDER = "M3.5 7.2a2.7 2.7 0 0 1 2.7-2.7h2.9c.7 0 1.4.3 1.9.8l1.2 1.2h5.6a2.7 2.7 0 0 1 2.7 2.7v7.6a2.7 2.7 0 0 1-2.7 2.7H6.2a2.7 2.7 0 0 1-2.7-2.7Z";

export const FilesIcon = createActionIcon("Files", Classic.Folder, (
  <>
    <Wash d={FOLDER} />
    <path d={FOLDER} />
    <path d="M3.5 10h17" strokeOpacity="0.55" />
  </>
));

export const GitIcon = createActionIcon("Git", Classic.GitBranch, (
  <>
    <Wash d="M7 3.6a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Zm0 12.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Zm10-12.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6Z" />
    <circle cx="7" cy="5.9" r="2.3" />
    <circle cx="7" cy="18.1" r="2.3" />
    <circle cx="17" cy="5.9" r="2.3" />
    <path d="M7 8.2v7.6m10-7.6v.4a4 4 0 0 1-4 4h-2a4 4 0 0 0-4 3.2" />
  </>
));

export const StatsIcon = createActionIcon("Stats", Classic.BarChart3, (
  <>
    <Wash d="M5.6 12.5h1.8a1.3 1.3 0 0 1 1.3 1.3v5.4a1.3 1.3 0 0 1-1.3 1.3H5.6a1.3 1.3 0 0 1-1.3-1.3v-5.4a1.3 1.3 0 0 1 1.3-1.3Zm5.5-8.5h1.8a1.3 1.3 0 0 1 1.3 1.3v13.9a1.3 1.3 0 0 1-1.3 1.3h-1.8a1.3 1.3 0 0 1-1.3-1.3V5.3A1.3 1.3 0 0 1 11.1 4Zm5.5 4.5h1.8a1.3 1.3 0 0 1 1.3 1.3v9.4a1.3 1.3 0 0 1-1.3 1.3h-1.8a1.3 1.3 0 0 1-1.3-1.3V9.8a1.3 1.3 0 0 1 1.3-1.3Z" />
    <rect x="4.3" y="12.5" width="4.4" height="8" rx="1.3" />
    <rect x="9.8" y="4" width="4.4" height="16.5" rx="1.3" />
    <rect x="15.3" y="8.5" width="4.4" height="12" rx="1.3" />
  </>
));

export const ProvidersIcon = createActionIcon("Providers", Classic.ArrowLeftRight, (
  <>
    <path d="M6.5 9.5h11m-2.6-2.6 2.6 2.6-2.6 2.6" />
    <path d="M17.5 14.5h-11m2.6-2.6-2.6 2.6 2.6 2.6" strokeOpacity="0.6" />
  </>
));

export const SystemResourcesIcon = createActionIcon("SystemResources", Classic.Cpu, (
  <>
    <Wash d="M8.2 5.5h7.6a2.7 2.7 0 0 1 2.7 2.7v7.6a2.7 2.7 0 0 1-2.7 2.7H8.2a2.7 2.7 0 0 1-2.7-2.7V8.2a2.7 2.7 0 0 1 2.7-2.7Z" />
    <rect x="5.5" y="5.5" width="13" height="13" rx="2.7" />
    <rect x="9.4" y="9.4" width="5.2" height="5.2" rx="1.1" />
    <path d="M9.6 2.8v2.7m4.8-2.7v2.7m-4.8 13v2.7m4.8-2.7v2.7M2.8 9.6h2.7m-2.7 4.8h2.7m13-4.8h2.7m-2.7 4.8h2.7" strokeOpacity="0.6" />
  </>
));

export const BackgroundTasksIcon = createActionIcon("BackgroundTasks", Classic.Layers, (
  <>
    <Wash d="M11.2 3.7a1.7 1.7 0 0 1 1.6 0l7.1 3.7a.9.9 0 0 1 0 1.6l-7.1 3.7a1.7 1.7 0 0 1-1.6 0L4.1 9a.9.9 0 0 1 0-1.6Z" />
    <path d="M11.2 3.7a1.7 1.7 0 0 1 1.6 0l7.1 3.7a.9.9 0 0 1 0 1.6l-7.1 3.7a1.7 1.7 0 0 1-1.6 0L4.1 9a.9.9 0 0 1 0-1.6Z" />
    <path d="m4 12.6 7.2 3.8a1.7 1.7 0 0 0 1.6 0l7.2-3.8" strokeOpacity="0.75" />
    <path d="m4 16.4 7.2 3.8a1.7 1.7 0 0 0 1.6 0l7.2-3.8" strokeOpacity="0.5" />
  </>
));
