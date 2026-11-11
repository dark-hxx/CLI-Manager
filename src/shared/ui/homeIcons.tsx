import { forwardRef, useId, type ComponentType, type ReactNode } from "react";
import type { LucideProps } from "lucide-react";
import * as Classic from "./icons";
import {
  Command as ClassicCommand,
  Puzzle as ClassicPuzzle, Square as ClassicSquare, Ellipsis as ClassicEllipsis,
  PanelBottom as ClassicPanelBottom, PanelLeft as ClassicPanelLeft,
  PanelLeftClose as ClassicPanelLeftClose, PanelLeftOpen as ClassicPanelLeftOpen,
  PanelRight as ClassicPanelRight, PanelRightClose as ClassicPanelRightClose,
  PanelRightOpen as ClassicPanelRightOpen, PanelTop as ClassicPanelTop,
  PanelTopClose as ClassicPanelTopClose, PanelTopOpen as ClassicPanelTopOpen,
  RotateCcw as ClassicRotateCcw,
} from "lucide-react";
import { useSettingsStore } from "../preferences/settingsStore";

/**
 * 首页功能图标（v3）：仿 SF Symbols 分层渲染。
 * 对象类图标为实心剪影 + 顶部高光 + 白色镂空细节，面板类为外框 + 实心内嵌区，动作类保持线性；
 * 经典模式原样返回原图标。品牌、Shell、自定义项目标识不经过这里；
 * 状态类图标（警告、停止、同步、筛选、窗口按钮）保留 currentColor 以承载状态语义。
 */
interface HomeIconSpec {
  /** 精致模式主色；省略时继承外层文字颜色。 */
  color?: string;
  /** 低透明度实心底层路径（使用当前颜色）。 */
  wash?: string;
  /** 描边主体路径（使用当前颜色）。 */
  detail?: string;
  /** 自定义图形，提供时忽略 wash/detail；函数形式拿到实例唯一 id，用于渐变引用。 */
  body?: ReactNode | ((uid: string) => ReactNode);
}

/** 实心剪影 + 顶部白色高光，高光渐变按实例 id 引用，避免多实例串用。 */
function Solid({ uid, d, opacity }: { uid: string; d: string; opacity?: number }) {
  return (
    <g opacity={opacity}>
      <path d={d} fill="currentColor" stroke="none" />
      <path d={d} fill={`url(#${uid}-sheen)`} stroke="none" />
    </g>
  );
}

function Sheen({ uid }: { uid: string }) {
  return (
    <defs>
      <linearGradient id={`${uid}-sheen`} x1="0" y1="0" x2="0" y2="1">
        <stop stopColor="#fff" stopOpacity="0.34" />
        <stop offset="0.6" stopColor="#fff" stopOpacity="0" />
      </linearGradient>
    </defs>
  );
}

/** 圆角矩形转路径，供 Solid 复用。 */
function rect(x: number, y: number, w: number, h: number, r: number) {
  return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1-${r} ${r}h-${w - 2 * r}a${r} ${r} 0 0 1-${r}-${r}v-${h - 2 * r}a${r} ${r} 0 0 1 ${r}-${r}Z`;
}

/** 面板类：圆角外框 + 实心内嵌区，可选附加箭头。 */
function panel(inset: [number, number, number, number], extra?: string, secondary?: [number, number, number, number]) {
  return (uid: string) => (
    <>
      <Sheen uid={uid} />
      <rect x="3" y="4" width="18" height="16" rx="3.6" />
      <Solid uid={uid} d={rect(...inset, 1.3)} />
      {secondary ? <Solid uid={uid} d={rect(...secondary, 1.3)} opacity={0.35} /> : null}
      {extra ? <path d={extra} strokeWidth="1.8" /> : null}
    </>
  );
}

function createHomeIcon(
  name: string,
  Original: ComponentType<LucideProps>,
  spec: HomeIconSpec,
) {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(function HomeIcon(originalProps, ref) {
    const refined = useSettingsStore((state) => state.settingsIconStyle === "refined");
    const uid = useId().replace(/:/g, "");
    if (!refined) return <Original ref={ref} {...originalProps} />;
    const { size = 24, strokeWidth, absoluteStrokeWidth, children, style, ...props } = originalProps;
    const weight = strokeWidth ?? 1.65;
    const width = absoluteStrokeWidth ? Number(weight) * 24 / Number(size) : weight;
    const body = typeof spec.body === "function" ? spec.body(uid) : spec.body;
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={size}
        height={size}
        fill="none"
        stroke="currentColor"
        strokeWidth={width}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        {...props}
        style={spec.color ? { color: spec.color, ...style } : style}
        data-home-icon={name}
      >
        {body ?? (
          <>
            {spec.wash ? <path d={spec.wash} fill="currentColor" fillOpacity="0.16" stroke="none" /> : null}
            {spec.detail ? <path d={spec.detail} /> : null}
          </>
        )}
        {children}
      </svg>
    );
  });
  Icon.displayName = `Home${name}`;
  return Icon;
}

const KNOCKOUT = { stroke: "#fff", fill: "none" } as const;

export const Activity = createHomeIcon(
  "Activity",
  Classic.Activity,
  {
    color: "#FF375F",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <Solid uid={uid} d={rect(3, 3.5, 18, 17, 4.6)} />
        <path d="M6.4 12.4h2.5l1.8-3.7 2.6 7.1 1.8-3.4h2.5" {...KNOCKOUT} strokeWidth="1.8" />
      </>
    ),
  },
);

export const AlertTriangle = createHomeIcon(
  "AlertTriangle",
  Classic.AlertTriangle,
  {
    body: (
      <>
        <path d="M10.3 4.3a2 2 0 0 1 3.4 0l7.3 12.7a2 2 0 0 1-1.7 3H4.7a2 2 0 0 1-1.7-3Z" fill="currentColor" fillOpacity="0.16" />
        <path d="M12 9.3v4.2" strokeWidth="1.9" />
        <circle cx="12" cy="16.6" r="1.1" fill="currentColor" stroke="none" />
      </>
    ),
  },
);

export const ArrowLeftRight = createHomeIcon(
  "ArrowLeftRight",
  Classic.ArrowLeftRight,
  {
    color: "#5856D6",
    body: (
      <>
        <path d="M4.5 7.5h14.5m-3.4-3.4L19 7.5l-3.4 3.4" strokeWidth="1.85" />
        <path d="M19.5 16.5H5m3.4-3.4L5 16.5l3.4 3.4" strokeWidth="1.85" strokeOpacity="0.55" />
      </>
    ),
  },
);

export const BarChart3 = createHomeIcon(
  "BarChart3",
  Classic.BarChart3,
  {
    color: "#34C759",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <Solid uid={uid} d={rect(3.6, 12, 4.4, 8.5, 1.7)} opacity={0.5} />
        <Solid uid={uid} d={rect(9.8, 3.5, 4.4, 17, 1.7)} />
        <Solid uid={uid} d={rect(16, 8, 4.4, 12.5, 1.7)} opacity={0.75} />
      </>
    ),
  },
);

export const Check = createHomeIcon(
  "Check",
  Classic.Check,
  {
    detail: "m5.2 12.6 4.4 4.4L18.8 7.4",
  },
);

export const ChevronDown = createHomeIcon(
  "ChevronDown",
  Classic.ChevronDown,
  {
    detail: "m6.5 9.5 5.5 5.5 5.5-5.5",
  },
);

export const ChevronRight = createHomeIcon(
  "ChevronRight",
  Classic.ChevronRight,
  {
    detail: "m9.5 6.5 5.5 5.5-5.5 5.5",
  },
);

export const CircleStop = createHomeIcon(
  "CircleStop",
  Classic.CircleStop,
  {
    body: (
      <>
        <circle cx="12" cy="12" r="9" fill="currentColor" fillOpacity="0.16" />
        <rect x="8.9" y="8.9" width="6.2" height="6.2" rx="1.5" fill="currentColor" stroke="none" />
      </>
    ),
  },
);

export const Cloud = createHomeIcon(
  "Cloud",
  Classic.Cloud,
  {
    body: (
      <>
        <path d="M7.1 19.5h10.4a4.5 4.5 0 0 0 .8-8.93A6.2 6.2 0 0 0 6.4 9.3a5.1 5.1 0 0 0 .7 10.2Z" fill="currentColor" fillOpacity="0.16" />
        <path d="M12 17v-6.2m-2.6 2.5 2.6-2.6 2.6 2.6" strokeWidth="1.8" />
      </>
    ),
  },
);

export const Copy = createHomeIcon(
  "Copy",
  Classic.Copy,
  {
    body: (
      <>
        <path d="M15.5 7.6V5.7A2.7 2.7 0 0 0 12.8 3H5.7A2.7 2.7 0 0 0 3 5.7v7.1a2.7 2.7 0 0 0 2.7 2.7h1.9" strokeOpacity="0.55" />
        <rect x="8.5" y="8.5" width="12.5" height="12.5" rx="2.7" fill="currentColor" fillOpacity="0.16" />
      </>
    ),
  },
);

export const Crosshair = createHomeIcon(
  "Crosshair",
  Classic.Crosshair,
  {
    color: "#5856D6",
    body: (
      <>
        <circle cx="12" cy="12" r="7" fill="currentColor" fillOpacity="0.16" />
        <path d="M12 2.5V5m0 14v2.5M2.5 12H5m14 0h2.5" strokeWidth="1.8" />
        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
      </>
    ),
  },
);

export const Cpu = createHomeIcon(
  "Cpu",
  Classic.Cpu,
  {
    color: "#FF9F0A",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <path d="M9.5 2.8v2.4m5-2.4v2.4m-5 13.6v2.4m5-2.4v2.4M2.8 9.5h2.4m-2.4 5h2.4m13.6-5h2.4m-2.4 5h2.4" strokeWidth="1.8" strokeOpacity="0.6" />
        <Solid uid={uid} d={rect(5.2, 5.2, 13.6, 13.6, 3.2)} />
        <rect x="9.2" y="9.2" width="5.6" height="5.6" rx="1.3" {...KNOCKOUT} strokeWidth="1.5" />
      </>
    ),
  },
);

export const Filter = createHomeIcon(
  "Filter",
  Classic.Filter,
  {
    detail: "M4 7h16M7 12h10m-6.5 5h3",
  },
);

export const Folder = createHomeIcon(
  "Folder",
  Classic.Folder,
  {
    color: "var(--node-accent, #4B95FB)",
    body: (uid) => (
      <>
        <defs>
          <linearGradient id={`${uid}-folder-back`} x1="3" y1="4" x2="21" y2="10" gradientUnits="userSpaceOnUse">
            <stop style={{ stopColor: "color-mix(in srgb, var(--node-accent, #4B95FB) 80%, white)" }} />
            <stop offset="1" style={{ stopColor: "color-mix(in srgb, var(--node-accent, #4B95FB) 88%, black)" }} />
          </linearGradient>
          <linearGradient id={`${uid}-folder-front`} x1="12" y1="8.6" x2="12" y2="20" gradientUnits="userSpaceOnUse">
            <stop style={{ stopColor: "color-mix(in srgb, var(--node-accent, #4B95FB) 58%, white)" }} />
            <stop offset="1" stopColor="var(--node-accent, #4B95FB)" />
          </linearGradient>
        </defs>
        <path stroke="none" fill={`url(#${uid}-folder-back)`} d="M3 6.3A2.3 2.3 0 0 1 5.3 4h3.9c.62 0 1.22.25 1.66.7l1.5 1.5h6.34A2.3 2.3 0 0 1 21 8.5v9.2a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 17.7Z" />
        <path stroke="none" fill={`url(#${uid}-folder-front)`} d="M3 10.3a1.7 1.7 0 0 1 1.7-1.7h14.6a1.7 1.7 0 0 1 1.7 1.7v7.4a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 17.7Z" />
        <path d="M4.8 9.35h14.4" stroke="#fff" strokeOpacity="0.5" strokeWidth="0.9" fill="none" />
      </>
    ),
  },
);

/** 深色圆角屏 + 绿色提示符；终端与终端方块共用同一造型。 */
function terminalBody(uid: string) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-home-terminal-body`} x1="12" y1="3.5" x2="12" y2="20.5" gradientUnits="userSpaceOnUse">
          <stop stopColor="#46464C" />
          <stop offset="1" stopColor="#1C1C1F" />
        </linearGradient>
      </defs>
      <rect x="2.75" y="3.5" width="18.5" height="17" rx="4.4" fill={`url(#${uid}-home-terminal-body)`} stroke="none" />
      <rect x="3.25" y="4" width="17.5" height="16" rx="3.9" fill="none" stroke="#fff" strokeOpacity="0.16" strokeWidth="1" />
      <path d="M7.2 8.9 10.9 12l-3.7 3.1" stroke="#32D74B" strokeWidth="2.1" fill="none" />
      <path d="M12.9 15.3h4.1" stroke="#F5F5F7" strokeWidth="2.1" fill="none" />
    </>
  );
}

export const Terminal = createHomeIcon(
  "Terminal",
  Classic.Terminal,
  {
    color: "#34C759",
    body: terminalBody,
  },
);

export const TerminalSquare = createHomeIcon(
  "TerminalSquare",
  Classic.TerminalSquare,
  {
    color: "#34C759",
    body: terminalBody,
  },
);

export const FileCode = createHomeIcon(
  "FileCode",
  Classic.FileCode,
  {
    color: "#4B95FB",
    body: (uid) => (
      <>
        <defs>
          <linearGradient id={`${uid}-file-body`} x1="12" y1="3" x2="12" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#FFFFFF" />
            <stop offset="1" stopColor="#E2ECFA" />
          </linearGradient>
          <linearGradient id={`${uid}-file-fold`} x1="14" y1="3" x2="19" y2="8.5" gradientUnits="userSpaceOnUse">
            <stop stopColor="#9BD1FF" />
            <stop offset="1" stopColor="#3D8BFD" />
          </linearGradient>
        </defs>
        <path stroke="#9FB6D8" strokeWidth="0.9" fill={`url(#${uid}-file-body)`} d="M7 3h6.7L19 8.3V19a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" />
        <path stroke="none" fill={`url(#${uid}-file-fold)`} d="M13.7 3 19 8.3h-3.5a1.8 1.8 0 0 1-1.8-1.8Z" />
        <path d="M8.4 12.3h7.2" stroke="#3D8BFD" strokeWidth="1.5" fill="none" />
        <path d="M8.4 15.4h4.8" stroke="#B3BDCB" strokeWidth="1.5" fill="none" />
      </>
    ),
  },
);

export const FolderOpen = createHomeIcon(
  "FolderOpen",
  Classic.FolderOpen,
  {
    color: "#4B95FB",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <Solid uid={uid} opacity={0.5} d="M3 6.3A2.3 2.3 0 0 1 5.3 4h3.9c.62 0 1.22.25 1.66.7l1.5 1.5h5.94A2.3 2.3 0 0 1 20.6 8.5V10H7.5a2.2 2.2 0 0 0-2.08 1.5L3 18.3Z" />
        <Solid uid={uid} d="M5.5 11.4A2 2 0 0 1 7.4 10h13.8a1.2 1.2 0 0 1 1.15 1.55l-2.1 6.9A2.2 2.2 0 0 1 18.15 20H4.3a1.2 1.2 0 0 1-1.15-1.55Z" />
      </>
    ),
  },
);

export const FolderPlus = createHomeIcon(
  "FolderPlus",
  Classic.FolderPlus,
  {
    color: "#4B95FB",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <Solid uid={uid} opacity={0.55} d="M3 6.3A2.3 2.3 0 0 1 5.3 4h3.9c.62 0 1.22.25 1.66.7l1.5 1.5h6.34A2.3 2.3 0 0 1 21 8.5V12H3Z" />
        <Solid uid={uid} d="M3 10.3a1.7 1.7 0 0 1 1.7-1.7h14.6a1.7 1.7 0 0 1 1.7 1.7v7.4a2.3 2.3 0 0 1-2.3 2.3H5.3A2.3 2.3 0 0 1 3 17.7Z" />
        <path d="M12 11.7v5.4m-2.7-2.7h5.4" {...KNOCKOUT} strokeWidth="1.8" />
      </>
    ),
  },
);

export const GitBranch = createHomeIcon(
  "GitBranch",
  Classic.GitBranch,
  {
    color: "#FF9500",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <path d="M7 7.4v9.2m10-7.6v.6a4 4 0 0 1-4 4h-2a4 4 0 0 0-4 3" strokeWidth="1.9" strokeOpacity="0.6" />
        <Solid uid={uid} d="M7 2.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z" />
        <Solid uid={uid} d="M7 16.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z" />
        <Solid uid={uid} d="M17 4.2a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z" />
      </>
    ),
  },
);

export const Handshake = createHomeIcon(
  "Handshake",
  Classic.Handshake,
  {
    color: "#5E5CE6",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <path fill="currentColor" fillOpacity="0.16" stroke="none" d="M5 5h6l3.5-1 4.5 2 1 8-6.5 6.5L5 13.5Z" />
        <Solid uid={uid} opacity={0.5} d="M2.4 3.6a.7.7 0 0 1 .78-.62l1.6.18a.7.7 0 0 1 .62.78l-1.1 10.1a.7.7 0 0 1-.78.62l-1.6-.18a.7.7 0 0 1-.62-.78Z" />
        <Solid uid={uid} opacity={0.5} d="M21.6 3.6a.7.7 0 0 0-.78-.62l-1.6.18a.7.7 0 0 0-.62.78l1.1 10.1a.7.7 0 0 0 .78.62l1.6-.18a.7.7 0 0 0 .62-.78Z" />
        <path d="M5 4.5h6m8.4.4-1.7.25a2 2 0 0 1-1.42-.25l-.47-.28a5.8 5.8 0 0 0-7.06.87L6.94 8.3a1 1 0 0 0 3 3l.88-.88a3 3 0 0 1 4.24 0L18.9 14.3M4.6 14.2l5.9 5.9a1 1 0 0 0 3-3m0 0 1 1a1 1 0 0 0 3-3l-2.5-2.5m2.5 2.5.6.6" />
      </>
    ),
  },
);

export const Link2 = createHomeIcon(
  "Link2",
  Classic.Link2,
  {
    detail: "M10.6 13.4a3.7 3.7 0 0 0 5.2 0l3-3a3.7 3.7 0 0 0-5.2-5.2l-1.1 1.1m.9 4.1a3.7 3.7 0 0 0-5.2 0l-3 3a3.7 3.7 0 0 0 5.2 5.2l1.1-1.1",
  },
);

export const ListClockIcon = createHomeIcon(
  "ListClockIcon",
  Classic.ListClockIcon,
  {
    color: "#5E5CE6",
    body: (
      <>
        <circle cx="12" cy="12" r="8.6" fill="currentColor" fillOpacity="0.16" stroke="none" />
        <path d="M3.4 12a8.6 8.6 0 1 0 2.5-6.1L3.4 8.4m0-4.6v4.6H8" />
        <path d="M12 7.5v4.8l3.2 1.9" strokeWidth="1.9" />
      </>
    ),
  },
);

export const Maximize2 = createHomeIcon(
  "Maximize2",
  Classic.Maximize2,
  {
    color: "#30B0C7",
    detail: "M4 9.2V6.6A2.6 2.6 0 0 1 6.6 4h2.6m5.6 0h2.6A2.6 2.6 0 0 1 20 6.6v2.6m0 5.6v2.6a2.6 2.6 0 0 1-2.6 2.6h-2.6m-5.6 0H6.6A2.6 2.6 0 0 1 4 17.4v-2.6",
  },
);

export const Minimize2 = createHomeIcon(
  "Minimize2",
  Classic.Minimize2,
  {
    color: "#30B0C7",
    detail: "M9.2 4v2.6a2.6 2.6 0 0 1-2.6 2.6H4m10.8-5.2v2.6a2.6 2.6 0 0 0 2.6 2.6H20m0 5.6h-2.6a2.6 2.6 0 0 0-2.6 2.6V20m-5.6 0v-2.6a2.6 2.6 0 0 0-2.6-2.6H4",
  },
);

export const Minus = createHomeIcon(
  "Minus",
  Classic.Minus,
  {
    detail: "M5.5 12h13",
  },
);

export const Palette = createHomeIcon(
  "Palette",
  Classic.Palette,
  {
    color: "#AF52DE",
    body: (
      <>
        <path
          d="M12 3a9 9 0 0 0 0 18c1.05 0 1.8-.85 1.8-1.85 0-.5-.2-.92-.5-1.27a1.85 1.85 0 0 1 1.38-3.08h2.12A4.2 4.2 0 0 0 21 10.6C21 6.40 17 3 12 3Z"
          fill="currentColor"
          fillOpacity="0.16"
        />
        <circle cx="7.4" cy="11.4" r="1.55" fill="#FF3B30" stroke="none" />
        <circle cx="9.6" cy="7.2" r="1.55" fill="#FF9500" stroke="none" />
        <circle cx="14.4" cy="7.2" r="1.55" fill="#34C759" stroke="none" />
        <circle cx="17.1" cy="10.9" r="1.55" fill="#007AFF" stroke="none" />
      </>
    ),
  },
);

export const Pencil = createHomeIcon(
  "Pencil",
  Classic.Pencil,
  {
    color: "#FF9500",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <Solid uid={uid} d="M15.9 4a2.1 2.1 0 0 1 3 0l1.1 1.1a2.1 2.1 0 0 1 0 3L9.2 18.9l-4.7 1.3a.55.55 0 0 1-.68-.68l1.3-4.7Z" />
        <path d="m14 5.9 4.1 4.1" {...KNOCKOUT} strokeWidth="1.4" />
      </>
    ),
  },
);

export const Pin = createHomeIcon(
  "Pin",
  Classic.Pin,
  {
    color: "#FF9F0A",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <path d="M12 14.4v6.4" strokeWidth="1.9" strokeOpacity="0.6" />
        <Solid uid={uid} d="M8.7 3h6.6a.9.9 0 0 1 .72 1.44L15 5.8v3.6l2.65 2.9a1 1 0 0 1-.74 1.68H7.1a1 1 0 0 1-.74-1.68L9 9.4V5.8L7.98 4.44A.9.9 0 0 1 8.7 3Z" />
      </>
    ),
  },
);

export const Play = createHomeIcon(
  "Play",
  Classic.Play,
  {
    color: "#34C759",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <Solid uid={uid} d="M7 5.3c0-1 .9-1.6 1.75-1.1l11.1 6.6c.85.5.85 1.85 0 2.35L8.75 19.8C7.9 20.3 7 19.7 7 18.7Z" />
      </>
    ),
  },
);

export const Plus = createHomeIcon(
  "Plus",
  Classic.Plus,
  {
    color: "#007AFF",
    detail: "M12 5v14M5 12h14",
  },
);

export const Puzzle = createHomeIcon(
  "Puzzle",
  ClassicPuzzle,
  {
    color: "#AF52DE",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <Solid uid={uid} d="M9.25 4.75a2.25 2.25 0 0 1 4.5 0V6H16a1.5 1.5 0 0 1 1.5 1.5v3h1.25a2.25 2.25 0 0 1 0 4.5H17.5v3.5A1.5 1.5 0 0 1 16 20h-2.75v-1a1.75 1.75 0 0 0-3.5 0v1H5a1.5 1.5 0 0 1-1.5-1.5V15h1a2.25 2.25 0 0 0 0-4.5h-1v-3A1.5 1.5 0 0 1 5 6h4.25Z" />
      </>
    ),
  },
);

export const Settings = createHomeIcon(
  "Settings",
  Classic.Settings,
  {
    color: "#8E8E93",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <path d="M4 6.5h16M4 12h16M4 17.5h16" strokeWidth="1.8" strokeOpacity="0.45" />
        <Solid uid={uid} d="M15 4a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" />
        <Solid uid={uid} d="M9 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" />
        <Solid uid={uid} d="M14 15a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Z" />
      </>
    ),
  },
);

export const Square = createHomeIcon(
  "Square",
  ClassicSquare,
  {
    detail: "M7.6 5h8.8A2.6 2.6 0 0 1 19 7.6v8.8a2.6 2.6 0 0 1-2.6 2.6H7.6A2.6 2.6 0 0 1 5 16.4V7.6A2.6 2.6 0 0 1 7.6 5Z",
  },
);

export const SquareSplitHorizontal = createHomeIcon(
  "SquareSplitHorizontal",
  Classic.SquareSplitHorizontal,
  {
    color: "#007AFF",
    body: panel([5.6, 6.6, 5.6, 10.8], undefined, [12.8, 6.6, 5.6, 10.8]),
  },
);

export const SquareSplitVertical = createHomeIcon(
  "SquareSplitVertical",
  Classic.SquareSplitVertical,
  {
    color: "#007AFF",
    body: panel([5.6, 6.6, 12.8, 4.6], undefined, [5.6, 12.8, 12.8, 4.6]),
  },
);

export const Trash2 = createHomeIcon(
  "Trash2",
  Classic.Trash2,
  {
    color: "#FF3B30",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <path d="M4 6.3h16M9.2 6.1V4.9a1.4 1.4 0 0 1 1.4-1.4h2.8a1.4 1.4 0 0 1 1.4 1.4v1.2" strokeWidth="1.8" />
        <Solid uid={uid} d="M5.7 8.6h12.6l-.86 10.1A2.1 2.1 0 0 1 15.35 20.6h-6.7a2.1 2.1 0 0 1-2.09-1.9Z" />
        <path d="M10 11.6v5.6m4-5.6v5.6" {...KNOCKOUT} strokeWidth="1.5" />
      </>
    ),
  },
);

export const Undo2 = createHomeIcon(
  "Undo2",
  Classic.Undo2,
  {
    detail: "M8.8 13.8 4 9l4.8-4.8M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  },
);

export const X = createHomeIcon(
  "X",
  Classic.X,
  {
    detail: "m6.5 6.5 11 11m0-11-11 11",
  },
);

export const Layers = createHomeIcon(
  "Layers",
  Classic.Layers,
  {
    color: "#AF52DE",
    body: (uid) => (
      <>
        <Sheen uid={uid} />
        <path d="m3.8 16.4 8.2 4.3 8.2-4.3" strokeWidth="1.8" strokeOpacity="0.4" />
        <path d="m3.8 12.4 8.2 4.3 8.2-4.3" strokeWidth="1.8" strokeOpacity="0.7" />
        <Solid uid={uid} d="M11.3 3.4a1.5 1.5 0 0 1 1.4 0l7.5 3.9a.8.8 0 0 1 0 1.4l-7.5 3.9a1.5 1.5 0 0 1-1.4 0L3.8 8.7a.8.8 0 0 1 0-1.4Z" />
      </>
    ),
  },
);

export const PanelLeft = createHomeIcon(
  "PanelLeft",
  ClassicPanelLeft,
  { color: "#5E5CE6", body: panel([5.6, 6.6, 4.4, 10.8]) },
);

export const PanelRight = createHomeIcon(
  "PanelRight",
  ClassicPanelRight,
  { color: "#5E5CE6", body: panel([14, 6.6, 4.4, 10.8]) },
);

export const PanelTop = createHomeIcon(
  "PanelTop",
  ClassicPanelTop,
  { color: "#5E5CE6", body: panel([5.6, 6.6, 12.8, 3.8]) },
);

export const PanelBottom = createHomeIcon(
  "PanelBottom",
  ClassicPanelBottom,
  { color: "#5E5CE6", body: panel([5.6, 13.6, 12.8, 3.8]) },
);

export const PanelLeftClose = createHomeIcon(
  "PanelLeftClose",
  ClassicPanelLeftClose,
  { color: "#5E5CE6", body: panel([5.6, 6.6, 4.4, 10.8], "m15.4 9.5-2.5 2.5 2.5 2.5") },
);

export const PanelLeftOpen = createHomeIcon(
  "PanelLeftOpen",
  ClassicPanelLeftOpen,
  { color: "#5E5CE6", body: panel([5.6, 6.6, 4.4, 10.8], "m12.9 9.5 2.5 2.5-2.5 2.5") },
);

export const PanelRightClose = createHomeIcon(
  "PanelRightClose",
  ClassicPanelRightClose,
  { color: "#5E5CE6", body: panel([14, 6.6, 4.4, 10.8], "m8.6 9.5 2.5 2.5-2.5 2.5") },
);

export const PanelRightOpen = createHomeIcon(
  "PanelRightOpen",
  ClassicPanelRightOpen,
  { color: "#5E5CE6", body: panel([14, 6.6, 4.4, 10.8], "m11.1 9.5-2.5 2.5 2.5 2.5") },
);

export const PanelTopClose = createHomeIcon(
  "PanelTopClose",
  ClassicPanelTopClose,
  { color: "#5E5CE6", body: panel([5.6, 6.6, 12.8, 3.8], "m9.5 15.1 2.5-2.5 2.5 2.5") },
);

export const PanelTopOpen = createHomeIcon(
  "PanelTopOpen",
  ClassicPanelTopOpen,
  { color: "#5E5CE6", body: panel([5.6, 6.6, 12.8, 3.8], "m9.5 12.6 2.5 2.5 2.5-2.5") },
);

export const Ellipsis = createHomeIcon(
  "Ellipsis",
  ClassicEllipsis,
  {
    body: (
      <g fill="currentColor" stroke="none">
        <circle cx="5.5" cy="12" r="1.6" />
        <circle cx="12" cy="12" r="1.6" />
        <circle cx="18.5" cy="12" r="1.6" />
      </g>
    ),
  },
);

export const RotateCcw = createHomeIcon(
  "RotateCcw",
  ClassicRotateCcw,
  {
    color: "#30B0C7",
    body: (
      <>
        <path d="M19.2 9.2A7.8 7.8 0 0 0 5.6 7.4L3.8 9.4m0-4.6v4.6h4.6" />
        <path d="M4.8 14.8a7.8 7.8 0 0 0 13.6 1.8l1.8-2m0 4.6v-4.6h-4.6" strokeOpacity="0.55" />
      </>
    ),
  },
);

export const Command = createHomeIcon(
  "Command",
  ClassicCommand,
  {
    color: "#FF375F",
    body: (
      <>
        <rect x="9" y="9" width="6" height="6" fill="currentColor" fillOpacity="0.16" stroke="none" />
        <path d="M9 9h6v6H9Zm0 0H6.5A2.5 2.5 0 1 1 9 6.5Zm6 0V6.5A2.5 2.5 0 1 1 17.5 9Zm0 6h2.5a2.5 2.5 0 1 1-2.5 2.5Zm-6 0v2.5A2.5 2.5 0 1 1 6.5 15Z" strokeWidth="1.8" />
      </>
    ),
  },
);

export const Search = createHomeIcon(
  "Search",
  Classic.Search,
  {
    color: "#7C8798",
    body: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" fill="currentColor" fillOpacity="0.12" />
        <path d="m15.4 15.4 4.6 4.6" strokeWidth="2.1" />
      </>
    ),
  },
);
