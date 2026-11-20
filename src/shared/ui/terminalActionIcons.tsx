import { forwardRef, useId, type ComponentType, type ReactNode } from "react";
import type { LucideProps } from "lucide-react";
import { Command as ClassicCommand } from "lucide-react";
import * as Classic from "./icons";
import { useSettingsStore } from "../preferences/settingsStore";
import { Activity, ArrowLeftRight, BarChart3, Cpu, Folder, GitBranch, KNOCKOUT, Sheen, Solid, rect } from "./homeIcons";

/**
 * 终端操作侧栏图标：与首页/合并面板 Tab 同一套 SF Symbols 分层风格——
 * 实心剪影 + 顶部高光 + 白色镂空细节。
 * 面板类按钮（统计/系统资源/回放/Git/文件/供应商）直接复用合并面板 Tab 的图标，保证两处完全一致；
 * 其余动作按钮颜色取 currentColor，由 CSS 的 --terminal-action-color 按终端主题着色。
 * 经典模式原样返回 lucide 图标。
 */
function createActionIcon(name: string, Original: ComponentType<LucideProps>, body: (uid: string) => ReactNode) {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(function TerminalActionIcon(originalProps, ref) {
    const refined = useSettingsStore((state) => state.settingsIconStyle === "refined");
    const uid = useId().replace(/:/g, "");
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
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
        data-terminal-action-icon={name}
      >
        <Sheen uid={uid} />
        {body(uid)}
        {children}
      </svg>
    );
  });
  Icon.displayName = `TerminalAction${name}`;
  return Icon;
}

const TILE = rect(3, 3.5, 18, 17, 4.6);

export const NewTerminalIcon = createActionIcon("New", Classic.Plus, (uid) => (
  <>
    <Solid uid={uid} d={TILE} />
    <path d="M12 8.2v7.6M8.2 12h7.6" {...KNOCKOUT} strokeWidth="2" />
  </>
));

export const TemplatesIcon = createActionIcon("Templates", ClassicCommand, (uid) => (
  <>
    <Solid uid={uid} d={TILE} />
    <path
      d="M10.2 10.2h3.6v3.6h-3.6Zm0 0H8.6a1.6 1.6 0 1 1 1.6-1.6Zm3.6 0V8.6a1.6 1.6 0 1 1 1.6 1.6Zm0 3.6h1.6a1.6 1.6 0 1 1-1.6 1.6Zm-3.6 0v1.6a1.6 1.6 0 1 1-1.6-1.6Z"
      {...KNOCKOUT}
      strokeWidth="1.5"
    />
  </>
));

export const EnterFullscreenIcon = createActionIcon("EnterFullscreen", Classic.Maximize2, (uid) => (
  <>
    <Solid uid={uid} d={TILE} />
    <path
      d="M7.4 10.4V8.6a1.2 1.2 0 0 1 1.2-1.2h1.8m3.2 0h1.8a1.2 1.2 0 0 1 1.2 1.2v1.8m0 3.2v1.8a1.2 1.2 0 0 1-1.2 1.2h-1.8m-3.2 0H8.6a1.2 1.2 0 0 1-1.2-1.2v-1.8"
      {...KNOCKOUT}
      strokeWidth="1.8"
    />
  </>
));

export const ExitFullscreenIcon = createActionIcon("ExitFullscreen", Classic.Minimize2, (uid) => (
  <>
    <Solid uid={uid} d={TILE} />
    <path
      d="M10.4 7.4v1.8a1.2 1.2 0 0 1-1.2 1.2H7.4m9.2 0h-1.8a1.2 1.2 0 0 1-1.2-1.2V7.4m0 9.2v-1.8a1.2 1.2 0 0 1 1.2-1.2h1.8m-9.2 0h1.8a1.2 1.2 0 0 1 1.2 1.2v1.8"
      {...KNOCKOUT}
      strokeWidth="1.8"
    />
  </>
));

export const SessionHistoryIcon = createActionIcon("SessionHistory", Classic.ListClockIcon, (uid) => (
  <>
    <Solid uid={uid} d="M12 3a9 9 0 1 1 0 18 9 9 0 0 1 0-18Z" />
    <path d="M12 7.4v4.8l3.1 1.9" {...KNOCKOUT} strokeWidth="1.9" />
  </>
));

export const BackgroundTasksIcon = createActionIcon("BackgroundTasks", Classic.Layers, (uid) => (
  <>
    <path d="m3.8 12.4 7.4 3.9a1.7 1.7 0 0 0 1.6 0l7.4-3.9" strokeOpacity="0.75" />
    <path d="m3.8 16.4 7.4 3.9a1.7 1.7 0 0 0 1.6 0l7.4-3.9" strokeOpacity="0.5" />
    <Solid uid={uid} d="M11.2 3.4a1.7 1.7 0 0 1 1.6 0l7.4 3.9a.9.9 0 0 1 0 1.6l-7.4 3.9a1.7 1.7 0 0 1-1.6 0L3.8 8.9a.9.9 0 0 1 0-1.6Z" />
  </>
));

// 面板类：与合并面板 Tab（TerminalSidePanel）共用同一组件。
export const StatsIcon = BarChart3;
export const SystemResourcesIcon = Cpu;
export const ReplayIcon = Activity;
export const GitIcon = GitBranch;
export const FilesIcon = Folder;
export const ProvidersIcon = ArrowLeftRight;
