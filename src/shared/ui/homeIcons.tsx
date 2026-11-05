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
 * 首页功能图标：精致模式使用苹果系统色板的多色图形，经典模式原样返回原图标。
 * 品牌、Shell、自定义项目标识不经过这里；状态类图标（警告、停止、同步）保留 currentColor。
 */
interface HomeIconSpec {
  /** 精致模式主色；省略时继承外层文字颜色。 */
  color?: string;
  /** 低透明度实心底层路径（使用当前颜色）。 */
  wash?: string;
  /** 描边主体路径（使用当前颜色）。 */
  detail?: string;
  /** 多色实体图形，提供时忽略 wash/detail；函数形式按实例生成唯一渐变 id。 */
  body?: ReactNode | ((uid: string) => ReactNode);
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
            {spec.wash ? <path d={spec.wash} fill="currentColor" fillOpacity="0.14" stroke="none" /> : null}
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

export const Activity = createHomeIcon(
  "Activity",
  Classic.Activity,
  {
    color: "#FF375F",
    body: <path d="M3 12h4l3-7 4 14 3-7h4" />,
  },
);

export const AlertTriangle = createHomeIcon(
  "AlertTriangle",
  Classic.AlertTriangle,
  {
    wash: "m12 3 10 17H2Z",
    detail: "m12 3 10 17H2ZM12 8v5m0 3h.01",
  },
);

export const ArrowLeftRight = createHomeIcon(
  "ArrowLeftRight",
  Classic.ArrowLeftRight,
  {
    color: "#5856D6",
    body: <path d="M4 7h15m-3-3 3 3-3 3M20 17H5m3-3-3 3 3 3" />,
  },
);

export const BarChart3 = createHomeIcon(
  "BarChart3",
  Classic.BarChart3,
  {
    color: "#34C759",
    body: (
      <>
        <rect x="4" y="12" width="3.5" height="8" rx="1.3" fill="currentColor" fillOpacity="0.4" stroke="none" />
        <rect x="10.2" y="4" width="3.5" height="16" rx="1.3" fill="currentColor" stroke="none" />
        <rect x="16.5" y="8" width="3.5" height="12" rx="1.3" fill="currentColor" fillOpacity="0.65" stroke="none" />
      </>
    ),
  },
);

export const Check = createHomeIcon(
  "Check",
  Classic.Check,
  {
    detail: "m5 12 4.5 4.5L19 7",
  },
);

export const ChevronDown = createHomeIcon(
  "ChevronDown",
  Classic.ChevronDown,
  {
    detail: "m6 9 6 6 6-6",
  },
);

export const ChevronRight = createHomeIcon(
  "ChevronRight",
  Classic.ChevronRight,
  {
    detail: "m9 6 6 6-6 6",
  },
);

export const CircleStop = createHomeIcon(
  "CircleStop",
  Classic.CircleStop,
  {
    wash: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z",
    detail: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 9h6v6H9Z",
  },
);

export const Cloud = createHomeIcon(
  "Cloud",
  Classic.Cloud,
  {
    body: (
      <>
        <path d="M7 18H6a4.5 4.5 0 0 1-.5-9A6.5 6.5 0 0 1 18 7.5a5.2 5.2 0 0 1 .5 10.4" />
        <path d="M9 14.5 12 11l3 3.5M12 11v9" />
      </>
    ),
  },
);

export const Copy = createHomeIcon(
  "Copy",
  Classic.Copy,
  {
    color: "#5AA8FF",
    body: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2.5" fill="currentColor" fillOpacity="0.16" stroke="none" />
        <rect x="8" y="8" width="12" height="12" rx="2.5" />
        <path d="M15 4H6.5A2.5 2.5 0 0 0 4 6.5V15" />
      </>
    ),
  },
);

export const Crosshair = createHomeIcon(
  "Crosshair",
  Classic.Crosshair,
  {
    color: "#5856D6",
    wash: "M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Z",
    detail: "M12 2v5m0 10v5M2 12h5m10 0h5M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm0 5v4m-2-2h4",
  },
);

export const Cpu = createHomeIcon(
  "Cpu",
  Classic.Cpu,
  {
    color: "#FF9F0A",
    body: (
      <>
        <rect x="6" y="6" width="12" height="12" rx="3" />
        <rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor" fillOpacity="0.16" stroke="none" />
        <path d="M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3" />
      </>
    ),
  },
);

export const Filter = createHomeIcon(
  "Filter",
  Classic.Filter,
  {
    wash: "M3 5h18l-7 8v6l-4 2v-8Z",
    detail: "M3 5h18l-7 8v6l-4 2v-8Z",
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
          <linearGradient id={`${uid}-folder-back`} x1="3" y1="4" x2="21" y2="9" gradientUnits="userSpaceOnUse">
            <stop style={{ stopColor: "color-mix(in srgb, var(--node-accent, #4B95FB) 72%, white)" }} />
            <stop offset="1" stopColor="var(--node-accent, #3D8BFD)" />
          </linearGradient>
          <linearGradient id={`${uid}-folder-front`} x1="3" y1="9" x2="21" y2="21" gradientUnits="userSpaceOnUse">
            <stop style={{ stopColor: "color-mix(in srgb, var(--node-accent, #4B95FB) 55%, white)" }} />
            <stop offset="1" stopColor="var(--node-accent, #4B95FB)" />
          </linearGradient>
        </defs>
        <path stroke="none" fill={`url(#${uid}-folder-back)`} d="M3 6.2A2.2 2.2 0 0 1 5.2 4h4.1c.66 0 1.3.26 1.77.73L12.6 6.3h6.2A2.2 2.2 0 0 1 21 8.5v9.3a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8Z" />
        <path stroke="none" fill={`url(#${uid}-folder-front)`} d="M3 9.6h18v8.2a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 17.8Z" />
        <path d="M3 9.6h18" stroke="#fff" strokeOpacity="0.38" strokeWidth="1" fill="none" />
      </>
    ),
  },
);

export const Terminal = createHomeIcon(
  "Terminal",
  Classic.Terminal,
  {
    color: "#34C759",
    body: (
      <>
        <defs>
          <linearGradient id="home-terminal-body" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#3A3A3F" />
            <stop offset="1" stopColor="#1A1A1D" />
          </linearGradient>
        </defs>
        <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="4" fill="url(#home-terminal-body)" stroke="none" />
        <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="4" fill="none" stroke="#fff" strokeOpacity="0.14" strokeWidth="1" />
        <path d="M7.1 8.8 11.2 12.1 7.1 15.4" stroke="#4ADE80" strokeWidth="2.2" fill="none" />
        <path d="M13.1 15.4h4.3" stroke="#F5F5F7" strokeOpacity="0.95" strokeWidth="2.2" fill="none" />
        <path d="M5.2 4.7h13.6" stroke="#fff" strokeOpacity="0.16" strokeWidth="1" fill="none" />
      </>
    ),
  },
);

export const TerminalSquare = createHomeIcon(
  "TerminalSquare",
  Classic.TerminalSquare,
  {
    color: "#34C759",
    body: (
      <>
        <defs>
          <linearGradient id="home-terminal-square-body" x1="3" y1="3" x2="21" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#3A3A3F" />
            <stop offset="1" stopColor="#1A1A1D" />
          </linearGradient>
        </defs>
        <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="4" fill="url(#home-terminal-square-body)" stroke="none" />
        <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="4" fill="none" stroke="#fff" strokeOpacity="0.14" strokeWidth="1" />
        <path d="M7.1 8.8 11.2 12.1 7.1 15.4" stroke="#4ADE80" strokeWidth="2.2" fill="none" />
        <path d="M13.1 15.4h4.3" stroke="#F5F5F7" strokeOpacity="0.95" strokeWidth="2.2" fill="none" />
      </>
    ),
  },
);

export const FileCode = createHomeIcon(
  "FileCode",
  Classic.FileCode,
  {
    color: "#4B95FB",
    body: (
      <>
        <defs>
          <linearGradient id="home-file-body" x1="5" y1="3" x2="19" y2="21" gradientUnits="userSpaceOnUse">
            <stop stopColor="#F3F8FF" />
            <stop offset="1" stopColor="#DBE8FA" />
          </linearGradient>
          <linearGradient id="home-file-fold" x1="13" y1="3" x2="19" y2="9" gradientUnits="userSpaceOnUse">
            <stop stopColor="#8ECBFF" />
            <stop offset="1" stopColor="#4B95FB" />
          </linearGradient>
        </defs>
        <path stroke="#9DB4D6" strokeWidth="1" fill="url(#home-file-body)" d="M6.2 3h7.3l5.5 5.5v11.3a1.2 1.2 0 0 1-1.2 1.2H6.2A1.2 1.2 0 0 1 5 19.8V4.2A1.2 1.2 0 0 1 6.2 3Z" />
        <path stroke="none" fill="url(#home-file-fold)" d="M13.5 3 19 8.5 13.5 8.5Z" />
        <path d="M8.4 12.2h7.2" stroke="#3D8BFD" strokeWidth="1.5" fill="none" />
        <path d="M8.4 15.2h4.8" stroke="#B3BDCB" strokeWidth="1.4" fill="none" />
      </>
    ),
  },
);

export const FolderOpen = createHomeIcon(
  "FolderOpen",
  Classic.FolderOpen,
  {
    color: "#4B95FB",
    wash: "M3 10h19l-3 10H3Z",
    detail: "M3 10V6a2 2 0 0 1 2-2h5l2 3h6a2 2 0 0 1 2 2M3 10h19l-3 10H5a2 2 0 0 1-2-2Z",
  },
);

export const FolderPlus = createHomeIcon(
  "FolderPlus",
  Classic.FolderPlus,
  {
    color: "#4B95FB",
    wash: "M3 7h18v13H3Z",
    detail: "M3 9V6a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2ZM12 11v6m-3-3h6",
  },
);

export const GitBranch = createHomeIcon(
  "GitBranch",
  Classic.GitBranch,
  {
    color: "#FF9500",
    body: (
      <>
        <circle cx="6.5" cy="5" r="2.2" />
        <circle cx="6.5" cy="19" r="2.2" />
        <circle cx="17.5" cy="6.5" r="2.2" />
        <path d="M6.5 7.2v9.6m11-8.1v1.8a5 5 0 0 1-5 5h-1a5 5 0 0 0-5 1.5" />
      </>
    ),
  },
);

export const Handshake = createHomeIcon(
  "Handshake",
  Classic.Handshake,
  {
    color: "#5E5CE6",
    wash: "m3 8 5-4 4 2 4-2 5 4-3 8-6 4-6-4Z",
    detail: "m3 8 5-4 4 2 4-2 5 4-3 8-6 4-6-4Zm9-2-4 5 3 1 3-3 5 4M7 15l5 5",
  },
);

export const Link2 = createHomeIcon(
  "Link2",
  Classic.Link2,
  {
    detail: "m10 8 3-3a4.2 4.2 0 0 1 6 6l-3 3M8 10l-3 3a4.2 4.2 0 0 0 6 6l3-3m-6-2 8-8",
  },
);

export const ListClockIcon = createHomeIcon(
  "ListClockIcon",
  Classic.ListClockIcon,
  {
    color: "#6C5CE7",
    body: (
      <>
        <path d="M4.2 8.5A8 8 0 1 1 4 15M4 3.8v4.7h4.7" />
        <path d="M12 7.2v5l3.3 2" />
      </>
    ),
  },
);

export const Maximize2 = createHomeIcon(
  "Maximize2",
  Classic.Maximize2,
  {
    color: "#30B0C7",
    body: <path d="M4 9V5a1 1 0 0 1 1-1h4m6 0h4a1 1 0 0 1 1 1v4M4 15v4a1 1 0 0 0 1 1h4m6 0h4a1 1 0 0 0 1-1v-4" />,
  },
);

export const Minimize2 = createHomeIcon(
  "Minimize2",
  Classic.Minimize2,
  {
    color: "#30B0C7",
    detail: "M9 4v5H4m11-5v5h5M4 15h5v5m6 0v-5h5M4 4l5 5m6 6 5 5",
  },
);

export const Minus = createHomeIcon(
  "Minus",
  Classic.Minus,
  {
    detail: "M5 12h14",
  },
);

export const Palette = createHomeIcon(
  "Palette",
  Classic.Palette,
  {
    color: "#AF52DE",
    wash: "M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 1-3 2 2 0 0 1 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-9Z",
    detail: "M12 3a9 9 0 0 0 0 18h1a2 2 0 0 0 1-3 2 2 0 0 1 2-3h2a3 3 0 0 0 3-3 9 9 0 0 0-9-9ZM7 11h.01M10 7h.01M15 7h.01M18 11h.01",
  },
);

export const Pencil = createHomeIcon(
  "Pencil",
  Classic.Pencil,
  {
    color: "#FF9500",
    body: <path d="m15 4 5 5M4 20l1-5L16 4a1.5 1.5 0 0 1 2 0l2 2a1.5 1.5 0 0 1 0 2L9 19ZM5 15l4 4" />,
  },
);

export const Pin = createHomeIcon(
  "Pin",
  Classic.Pin,
  {
    color: "#FF9F0A",
    body: (
      <>
        <path fill="currentColor" fillOpacity="0.16" stroke="none" d="M8 3.5h8l-1 6 3.5 4v1H5.5v-1l3.5-4Z" />
        <path d="M8 3.5h8l-1 6 3.5 4v1H5.5v-1l3.5-4ZM12 14.5v6" />
      </>
    ),
  },
);

export const Play = createHomeIcon(
  "Play",
  Classic.Play,
  {
    color: "#34C759",
    body: <path fill="currentColor" stroke="none" d="M7 5.3c0-1 .8-1.5 1.6-1l11.1 6.4c1 .6 1 1.9 0 2.5L8.6 19.6c-.8.5-1.6 0-1.6-1Z" />,
  },
);

export const Plus = createHomeIcon(
  "Plus",
  Classic.Plus,
  {
    color: "#3478F6",
    detail: "M12 5v14M5 12h14",
  },
);

export const Puzzle = createHomeIcon(
  "Puzzle",
  ClassicPuzzle,
  {
    color: "#AF52DE",
    wash: "M4 9V5h5V4a2 2 0 1 1 4 0v1h6v5h1a2 2 0 1 1 0 4h-1v6h-6v-1a2 2 0 0 0-4 0v1H4v-6a2.5 2.5 0 0 0 0-5Z",
    detail: "M4 9V5h5V4a2 2 0 1 1 4 0v1h6v5h1a2 2 0 1 1 0 4h-1v6h-6v-1a2 2 0 0 0-4 0v1H4v-6a2.5 2.5 0 0 0 0-5Z",
  },
);

export const Settings = createHomeIcon(
  "Settings",
  Classic.Settings,
  {
    color: "#8E8E93",
    body: (
      <>
        <path d="M4 6h9m4 0h3M4 12h3m4 0h9M4 18h9m4 0h3" />
        <rect x="13" y="3.5" width="4" height="5" rx="1.5" />
        <rect x="7" y="9.5" width="4" height="5" rx="1.5" />
        <rect x="13" y="15.5" width="4" height="5" rx="1.5" />
      </>
    ),
  },
);

export const Square = createHomeIcon(
  "Square",
  ClassicSquare,
  {
    wash: "M5 5h14v14H5Z",
    detail: "M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z",
  },
);

export const SquareSplitHorizontal = createHomeIcon(
  "SquareSplitHorizontal",
  Classic.SquareSplitHorizontal,
  {
    color: "#4B95FB",
    body: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M12 4v16" />
        <path fill="currentColor" fillOpacity="0.16" stroke="none" d="M4 5h7v14H4Z" />
      </>
    ),
  },
);

export const SquareSplitVertical = createHomeIcon(
  "SquareSplitVertical",
  Classic.SquareSplitVertical,
  {
    color: "#4B95FB",
    body: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M3 12h18" />
        <path fill="currentColor" fillOpacity="0.16" stroke="none" d="M4 5h16v7H4Z" />
      </>
    ),
  },
);

export const Trash2 = createHomeIcon(
  "Trash2",
  Classic.Trash2,
  {
    color: "#FF3B30",
    body: <path d="M4 6.5h16M9 6.5V4h6v2.5m-9 0 .8 12a2 2 0 0 0 2 1.5h6.4a2 2 0 0 0 2-1.5l.8-12M10 10v6m4-6v6" />,
  },
);

export const Undo2 = createHomeIcon(
  "Undo2",
  Classic.Undo2,
  {
    detail: "M4 4v6h6M4 10l4-4a7 7 0 1 1 1 12",
  },
);

export const X = createHomeIcon(
  "X",
  Classic.X,
  {
    detail: "m6 6 12 12M6 18 18 6",
  },
);

export const Layers = createHomeIcon(
  "Layers",
  Classic.Layers,
  {
    color: "#AF52DE",
    body: (
      <>
        <path fill="currentColor" fillOpacity="0.16" stroke="none" d="m12 3 9 5-9 5-9-5Z" />
        <path d="m12 3 9 5-9 5-9-5Zm-9 10 9 5 9-5M3 18l9 5 9-5" transform="translate(0 -1) scale(1 .96)" />
      </>
    ),
  },
);

export const PanelLeft = createHomeIcon(
  "PanelLeft",
  ClassicPanelLeft,
  {
    color: "#5E5CE6",
    body: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path fill="currentColor" fillOpacity="0.16" stroke="none" d="M4 5h5v14H4Z" />
        <path d="M9 4v16m0-11h12" />
      </>
    ),
  },
);

export const PanelRight = createHomeIcon(
  "PanelRight",
  ClassicPanelRight,
  {
    color: "#5E5CE6",
    wash: "M15 4h6v16h-6Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16",
  },
);

export const PanelTop = createHomeIcon(
  "PanelTop",
  ClassicPanelTop,
  {
    color: "#5E5CE6",
    wash: "M3 4h18v5H3Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 9h18",
  },
);

export const PanelBottom = createHomeIcon(
  "PanelBottom",
  ClassicPanelBottom,
  {
    color: "#5E5CE6",
    wash: "M3 15h18v5H3Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 15h18",
  },
);

export const PanelLeftClose = createHomeIcon(
  "PanelLeftClose",
  ClassicPanelLeftClose,
  {
    color: "#5E5CE6",
    wash: "M3 4h6v16H3Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16m7-11-3 3 3 3",
  },
);

export const PanelLeftOpen = createHomeIcon(
  "PanelLeftOpen",
  ClassicPanelLeftOpen,
  {
    color: "#5E5CE6",
    wash: "M3 4h6v16H3Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM9 4v16m4-11 3 3-3 3",
  },
);

export const PanelRightClose = createHomeIcon(
  "PanelRightClose",
  ClassicPanelRightClose,
  {
    color: "#5E5CE6",
    wash: "M15 4h6v16h-6Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16M8 9l3 3-3 3",
  },
);

export const PanelRightOpen = createHomeIcon(
  "PanelRightOpen",
  ClassicPanelRightOpen,
  {
    color: "#5E5CE6",
    wash: "M15 4h6v16h-6Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16m-4-11-3 3 3 3",
  },
);

export const PanelTopClose = createHomeIcon(
  "PanelTopClose",
  ClassicPanelTopClose,
  {
    color: "#5E5CE6",
    wash: "M3 4h18v5H3Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 9h18m-12 7 3-3 3 3",
  },
);

export const PanelTopOpen = createHomeIcon(
  "PanelTopOpen",
  ClassicPanelTopOpen,
  {
    color: "#5E5CE6",
    wash: "M3 4h18v5H3Z",
    detail: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM3 9h18m-12 4 3 3 3-3",
  },
);

export const Ellipsis = createHomeIcon(
  "Ellipsis",
  ClassicEllipsis,
  {
    detail: "M5 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm7 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm7 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z",
  },
);

export const RotateCcw = createHomeIcon(
  "RotateCcw",
  ClassicRotateCcw,
  {
    color: "#30B0C7",
    body: <path d="M19 8a7.8 7.8 0 0 0-13-2L3.5 8.5m0-4.5v4.5H8M5 16a7.8 7.8 0 0 0 13 2l2.5-2.5m0 4.5v-4.5H16" />,
  },
);

export const Command = createHomeIcon(
  "Command",
  ClassicCommand,
  {
    color: "#FF375F",
    detail: "M8.5 8.5h7v7h-7Zm0 0H6a2.5 2.5 0 1 1 2.5-2.5Zm7 0V6A2.5 2.5 0 1 1 18 8.5Zm0 7H18a2.5 2.5 0 1 1-2.5 2.5Zm-7 0V18A2.5 2.5 0 1 1 6 15.5Z",
  },
);

export const Search = createHomeIcon(
  "Search",
  Classic.Search,
  {
    color: "#7C8798",
    body: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.3 15.3 4.7 4.7" />
      </>
    ),
  },
);
