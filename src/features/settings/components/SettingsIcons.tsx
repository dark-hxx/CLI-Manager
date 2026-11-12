import type { ComponentType, ReactNode, SVGProps } from "react";
import type { LucideIcon } from "lucide-react";
import { useSettingsStore } from "../../../shared/preferences/settingsStore";

export interface SettingsGlyphProps extends Omit<SVGProps<SVGSVGElement>, "width" | "height"> {
  size?: number | string;
}

export type SettingsIconComponent = ComponentType<SettingsGlyphProps>;

/** 设置分类 id；与 SettingsModal 的 SettingsTab 保持一致。 */
export type SettingsNavIconKey =
  | "general"
  | "extensions"
  | "desktop-pet"
  | "developer"
  | "sidebar"
  | "terminal-theme"
  | "shortcuts"
  | "templates"
  | "native-providers"
  | "sponsors"
  | "model-pricing"
  | "cc-connect"
  | "ssh-hosts"
  | "sync"
  | "history-sources"
  | "hooks"
  | "statusline"
  | "terminal-status-bar"
  | "command-suggestions"
  | "about";

/** 彩色圆角砖：底色固定，符号固定白色，不参与 currentColor 继承。 */
function NavTile({ color, size = 18, children, ...rest }: { color: string } & SettingsGlyphProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="#fff"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      <rect x="1" y="1.5" width="22" height="22" rx="6" fill="#000" fillOpacity=".12" stroke="none" />
      <rect x="1" y="1" width="22" height="22" rx="6" fill={color} stroke="none" />
      <path d="M7 1.5h10a5.5 5.5 0 0 1 5.5 5.5v3.5c-6 2-15 2-21 0V7A5.5 5.5 0 0 1 7 1.5Z" fill="#fff" fillOpacity=".1" stroke="none" />
      <rect x="1.5" y="1.5" width="21" height="21" rx="6" stroke="#fff" strokeOpacity=".2" strokeWidth=".75" />
      {children}
    </svg>
  );
}

/** 页面内单色图标：24 网格、1.7 描边、继承 currentColor。 */
function Glyph({ size = 24, children, ...rest }: SettingsGlyphProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* 导航：彩色圆角砖                                                    */
/* ------------------------------------------------------------------ */

function GeneralIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#748195" {...props}>
      <path d="m10 5-.5 2-1.6.9-2-.5-1.8 3 1.5 1.4v1.8l-1.5 1.4 1.8 3 2-.5 1.6.9.5 2h4l.5-2 1.6-.9 2 .5 1.8-3-1.5-1.4v-1.8l1.5-1.4-1.8-3-2 .5-1.6-.9L14 5Z" />
      <circle cx="12" cy="12.7" r="2.7" />
    </NavTile>
  );
}

function TerminalThemeIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#38465C" {...props}>
      <rect x="5" y="6" width="14" height="12" rx="2" strokeOpacity=".55" />
      <path d="m8 10 2.5 2L8 14M13 14h3" />
    </NavTile>
  );
}

function ShortcutsIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#7162D9" {...props}>
      <path d="M9.5 9.5h5v5h-5zM9.5 9.5H7.8A2.3 2.3 0 1 1 10 7.2v2.3M14.5 9.5V7.8a2.3 2.3 0 1 1 2.3 2.2h-2.3M14.5 14.5h1.7a2.3 2.3 0 1 1-2.2 2.3v-2.3M9.5 14.5v1.7a2.3 2.3 0 1 1-2.3-2.2h2.3" />
    </NavTile>
  );
}

function TemplatesIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#D58A32" {...props}>
      <path d="M8 5h6l4 4v10H8a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z" />
      <path d="M14 5v4h4M9 12h6M9 15h4" />
    </NavTile>
  );
}

function NativeProvidersIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#9561CE" {...props}>
      <path d="m12 5 6.5 3.5v7L12 19l-6.5-3.5v-7Z" fill="#fff" fillOpacity=".12" />
      <path d="m5.5 8.5 6.5 3.7 6.5-3.7M12 12.2V19" />
    </NavTile>
  );
}

function ExtensionsIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#D99235" {...props}>
      <path d="M5.5 10V7h4V5.8a2 2 0 0 1 4 0V7h4v4h1.2a2 2 0 0 1 0 4h-1.2v4h-4v-1.2a2 2 0 0 0-4 0V19h-4v-4" />
      <path d="M5.5 10a2.5 2.5 0 0 1 0 5" />
    </NavTile>
  );
}

function ModelPricingIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#389F76" {...props}>
      <ellipse cx="12" cy="7.5" rx="6" ry="2.5" fill="#fff" fillOpacity=".15" />
      <path d="M6 7.5v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4M6 11.5v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4" />
    </NavTile>
  );
}

function RemoteConnectionsIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#328EB8" {...props}>
      <path d="M9 14.5H7a4 4 0 0 1 0-8h4M15 9.5h2a4 4 0 0 1 0 8h-4M8.5 12h7" />
    </NavTile>
  );
}

function SshHostsIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#6266BF" {...props}>
      <rect x="5" y="5" width="14" height="14" rx="2.5" />
      <path d="M5 9h14m-11 3 2.5 2L8 16M13 16h3" />
      <circle cx="8" cy="7" r=".65" fill="#fff" stroke="none" />
    </NavTile>
  );
}

function SyncIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#2997A1" {...props}>
      <path d="M6 10a6.2 6.2 0 0 1 10.6-3L19 9M19 5v4h-4M18 14a6.2 6.2 0 0 1-10.6 3L5 15M5 19v-4h4" />
    </NavTile>
  );
}

function HistorySourcesIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#A18160" {...props}>
      <path d="M5.5 9a7 7 0 1 1 .3 6.5M5 5v4h4" />
      <path d="M12 8v4l3 2" />
    </NavTile>
  );
}

function HooksIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#D55A78" {...props}>
      <circle cx="8" cy="6" r="2" />
      <circle cx="17" cy="9" r="2" />
      <path d="M8 8v6a4.5 4.5 0 0 0 9 0v-3M5 13l3-3 3 3" />
    </NavTile>
  );
}

function SidebarIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#667D99" {...props}>
      <rect x="5" y="5.5" width="14" height="13" rx="2" />
      <path d="M10 5.5v13" />
      <path d="M7.5 9h.01M7.5 12h.01M7.5 15h.01M13 9h3M13 12h3" strokeOpacity=".75" />
    </NavTile>
  );
}

function DesktopPetIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#CF648B" {...props}>
      <path d="M8.3 13.5 10 12a3 3 0 0 1 4 0l1.7 1.5c2.8 2.5 1 5.5-1.6 4.4a5.5 5.5 0 0 0-4.2 0c-2.6 1.1-4.4-1.9-1.6-4.4Z" fill="#fff" stroke="none" />
      <ellipse cx="6.5" cy="10.2" rx="1.4" ry="1.8" fill="#fff" stroke="none" transform="rotate(-25 6.5 10.2)" />
      <ellipse cx="10" cy="7.3" rx="1.4" ry="1.9" fill="#fff" stroke="none" />
      <ellipse cx="14" cy="7.3" rx="1.4" ry="1.9" fill="#fff" stroke="none" />
      <ellipse cx="17.5" cy="10.2" rx="1.4" ry="1.8" fill="#fff" stroke="none" transform="rotate(25 17.5 10.2)" />
    </NavTile>
  );
}

function DeveloperIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#526175" {...props}>
      <path d="m8.5 8-4 4 4 4m7-8 4 4-4 4M13.5 6l-3 12" />
    </NavTile>
  );
}

function SponsorsIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#D46A81" {...props}>
      <path d="M12 18.5 5.9 12.4a4 4 0 0 1 5.7-5.6l.4.4.4-.4a4 4 0 0 1 5.7 5.6Z" fill="#fff" stroke="none" />
      <path d="M7 9a1.6 1.6 0 0 1 2-1" stroke={"#D46A81"} strokeOpacity=".45" strokeWidth="1.3" />
    </NavTile>
  );
}

function AboutIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#3989D7" {...props}>
      <circle cx="12" cy="12" r="7" fill="#fff" fillOpacity=".12" />
      <path d="M11 11h1v5M10.5 16h3" />
      <circle cx="12" cy="8" r="1" fill="#fff" stroke="none" />
    </NavTile>
  );
}

function StatuslineIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#438EC4" {...props}>
      <rect x="5" y="5.5" width="14" height="13" rx="2" />
      <path d="M5 14h14M8 9h4" strokeOpacity=".6" />
      <path d="M8 16.3h3M14 16.3h2" />
    </NavTile>
  );
}

function TerminalStatusBarIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#3F9C8A" {...props}>
      <rect x="5" y="5.5" width="14" height="13" rx="2" />
      <path d="m8 9 2 1.5L8 12" strokeOpacity=".6" />
      <path d="M5 15h14" />
      <path d="M8 16.8h2M12 16.8h1.5M15.5 16.8h.5" />
    </NavTile>
  );
}

function CommandSuggestionsIcon(props: SettingsGlyphProps) {
  return (
    <NavTile color="#BB8939" {...props}>
      <path d="m6 8 3.5 3.5L6 15M11.5 16h5" />
      <path d="m16 4 1.1 3.1L20 8.2l-2.9 1.1L16 12l-1-2.7-3-1.1 3-1.1Z" fill="#fff" stroke="none" />
    </NavTile>
  );
}

export const SETTINGS_NAV_ICONS: Record<SettingsNavIconKey, SettingsIconComponent> = {
  general: GeneralIcon,
  "terminal-theme": TerminalThemeIcon,
  shortcuts: ShortcutsIcon,
  templates: TemplatesIcon,
  "native-providers": NativeProvidersIcon,
  extensions: ExtensionsIcon,
  "model-pricing": ModelPricingIcon,
  "cc-connect": RemoteConnectionsIcon,
  "ssh-hosts": SshHostsIcon,
  sync: SyncIcon,
  "history-sources": HistorySourcesIcon,
  hooks: HooksIcon,
  sidebar: SidebarIcon,
  "desktop-pet": DesktopPetIcon,
  developer: DeveloperIcon,
  sponsors: SponsorsIcon,
  about: AboutIcon,
  statusline: StatuslineIcon,
  "terminal-status-bar": TerminalStatusBarIcon,
  "command-suggestions": CommandSuggestionsIcon,
};

/* ------------------------------------------------------------------ */
/* 页面内结构性图标：单色线性                                          */
/* ------------------------------------------------------------------ */

export const SETTINGS_STRUCTURE_GLYPHS = {
  globe: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M5.5 12h13" />
      <path d="M12 5.5c1.8 1.8 2.8 4.1 2.8 6.5s-1 4.7-2.8 6.5c-1.8-1.8-2.8-4.1-2.8-6.5s1-4.7 2.8-6.5Z" />
    </Glyph>
  ),
  globe2: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="6.5" />
      <path d="M8.4 5.9c1.4 1.2 2.2 3.3 2.2 6.1s-.8 4.9-2.2 6.1M15.6 5.9c-1.4 1.2-2.2 3.3-2.2 6.1s.8 4.9 2.2 6.1M5.7 9.8c1.6.6 3.8.9 6.3.9s4.7-.3 6.3-.9M5.7 14.2c1.6-.6 3.8-.9 6.3-.9s4.7.3 6.3.9" />
    </Glyph>
  ),
  link: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M10.2 13.8a3.2 3.2 0 0 0 4.5 0l2.6-2.6a3.2 3.2 0 0 0-4.5-4.5l-1.3 1.3" />
      <path d="M13.8 10.2a3.2 3.2 0 0 0-4.5 0l-2.6 2.6a3.2 3.2 0 0 0 4.5 4.5l1.3-1.3" />
    </Glyph>
  ),
  bell: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M6.8 10.4a5.2 5.2 0 0 1 10.4 0c0 4 1.5 5.4 1.5 5.4H5.3s1.5-1.4 1.5-5.4Z" />
      <path d="M10.3 18.4a1.8 1.8 0 0 0 3.4 0" />
    </Glyph>
  ),
  arrowsLeftRight: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M4.8 9.2h14.4M15.8 5.8l3.4 3.4-3.4 3.4M19.2 14.8H4.8M8.2 11.4 4.8 14.8l3.4 3.4" />
    </Glyph>
  ),
  brain: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M9.4 5.6a3 3 0 0 0-3 3 2.8 2.8 0 0 0-1.2 2.4c0 .9.4 1.7 1 2.2a2.9 2.9 0 0 0 1.4 3.4 2.7 2.7 0 0 0 4.7-1.1V6.8a2.7 2.7 0 0 0-2.9-1.2Z" />
      <path d="M14.6 5.6a3 3 0 0 1 3 3 2.8 2.8 0 0 1 1.2 2.4c0 .9-.4 1.7-1 2.2a2.9 2.9 0 0 1-1.4 3.4 2.7 2.7 0 0 1-4.7-1.1V6.8a2.7 2.7 0 0 1 2.9-1.2Z" />
      <path d="M8.2 8.6h1.6M14.2 8.6h1.6M9.8 12.2h4.4" />
    </Glyph>
  ),
  route: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <circle cx="6.4" cy="17.6" r="2.1" />
      <circle cx="17.6" cy="6.4" r="2.1" />
      <path d="M8.5 17.6h5.2a3.1 3.1 0 0 0 0-6.2h-3.4a3.1 3.1 0 0 1 0-6.2h5.2" />
    </Glyph>
  ),
  server: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="5" y="4.9" width="14" height="5.9" rx="1.8" />
      <rect x="5" y="13.2" width="14" height="5.9" rx="1.8" />
      <path d="M8.1 7.85h.01M8.1 16.15h.01M11.4 7.85h4M11.4 16.15h4" />
    </Glyph>
  ),
  hardDrive: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="4.5" y="7" width="15" height="10" rx="2.2" />
      <path d="M4.9 13.3h14.2" />
      <path d="M7.6 10.2h.01M14.8 16.4h1.6" />
    </Glyph>
  ),
  sparkles: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="m11.2 5.8 1.5 4.2 4.2 1.5-4.2 1.5-1.5 4.2-1.5-4.2-4.2-1.5 4.2-1.5Z" />
      <path d="M17.7 14.9v2.6M16.4 16.2h2.6" />
    </Glyph>
  ),
  gift: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="5" y="9.6" width="14" height="9.4" rx="1.5" />
      <path d="M4.6 9.6h14.8M12 9.6V19" />
      <path d="M12 9.4C10.6 6.5 7 6.2 7 8.1c0 1.2 2.5 1.3 5 1.3Zm0 0c1.4-2.9 5-3.2 5-1.3 0 1.2-2.5 1.3-5 1.3Z" />
    </Glyph>
  ),
  bot: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="5.2" y="8" width="13.6" height="10" rx="2.6" />
      <path d="M12 4.6V8M8.2 4.6h7.6" />
      <path d="M9.2 12.1h.01M14.8 12.1h.01M9.6 15.2h4.8" />
    </Glyph>
  ),
  braces: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M9.2 5.2c-1.6 0-2.5.8-2.5 2.3v2.1c0 1.2-.7 1.9-1.7 2.4 1 .5 1.7 1.2 1.7 2.4v2.1c0 1.5.9 2.3 2.5 2.3M14.8 5.2c1.6 0 2.5.8 2.5 2.3v2.1c0 1.2.7 1.9 1.7 2.4-1 .5-1.7 1.2-1.7 2.4v2.1c0 1.5-.9 2.3-2.5 2.3" />
    </Glyph>
  ),
  bookOpen: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M12 7.2C10.4 5.9 8.3 5.3 5 5.5v12.4c3.3-.2 5.4.4 7 1.7 1.6-1.3 3.7-1.9 7-1.7V5.5c-3.3-.2-5.4.4-7 1.7Z" />
      <path d="M12 7.2v12.4" />
    </Glyph>
  ),
  cat: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M7 9.2 5.8 5.4l3.6 1.7a7 7 0 0 1 5.2 0l3.6-1.7L17 9.2a5.4 5.4 0 0 1 .9 3c0 3.3-2.6 5.5-5.9 5.5s-5.9-2.2-5.9-5.5a5.4 5.4 0 0 1 .9-3Z" />
      <path d="M9.6 12.1h.01M14.4 12.1h.01M10.8 14.7c.7.6 1.7.6 2.4 0" />
    </Glyph>
  ),
  history: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M6.6 7.7A6.4 6.4 0 1 1 5.7 15" />
      <path d="M6.6 4.7v3.2h3.2" />
      <path d="M12 9.1v3.3l2.2 1.3" />
    </Glyph>
  ),
  gitBranch: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <circle cx="7.2" cy="6.4" r="2.1" />
      <circle cx="7.2" cy="17.6" r="2.1" />
      <circle cx="16.8" cy="9.4" r="2.1" />
      <path d="M7.2 8.5v7M9.3 6.4h3.4a2.1 2.1 0 0 1 2.1 2.1v.9" />
    </Glyph>
  ),
  cpu: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="7.4" y="7.4" width="9.2" height="9.2" rx="1.8" />
      <rect x="10.4" y="10.4" width="3.2" height="3.2" rx=".6" />
      <path d="M9.6 4.6v2.8M14.4 4.6v2.8M9.6 16.6v2.8M14.4 16.6v2.8M4.6 9.6h2.8M4.6 14.4h2.8M16.6 9.6h2.8M16.6 14.4h2.8" />
    </Glyph>
  ),
  bug: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="8.2" y="8.2" width="7.6" height="9.2" rx="3.8" />
      <path d="M9.6 8.2a2.4 2.4 0 0 1 4.8 0M12 8.2v9.2M8.2 11.6H4.9M8.2 14.6H5.4M8.4 17.2l-2.2 1.8M15.8 11.6h3.3M15.8 14.6h2.8M15.6 17.2l2.2 1.8" />
    </Glyph>
  ),
  monitorCog: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="4.5" y="5.4" width="12.4" height="8.8" rx="1.8" />
      <path d="M9.2 17.8h3M10.7 14.2v3.6" />
      <circle cx="17.8" cy="15.4" r="2" />
      <path d="M17.8 12.6v.8M17.8 17.4v.8M15.6 15.4h.8M19.2 15.4h.8" />
    </Glyph>
  ),
  eyeOff: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M9.9 6.2A7.4 7.4 0 0 1 12 5.9c4.4 0 7.2 4.4 7.2 6.1a10.8 10.8 0 0 1-2.6 3.8M6.4 7.9A12 12 0 0 0 4.8 12c0 1.7 2.8 6.1 7.2 6.1a7.8 7.8 0 0 0 3.2-.7" />
      <path d="M10.2 10.2a2.6 2.6 0 0 0 3.6 3.6" />
      <path d="m5.2 5.2 13.6 13.6" />
    </Glyph>
  ),
  folder: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M4.6 8.2V7a1.6 1.6 0 0 1 1.6-1.6h3l1.7 2h6.9A1.6 1.6 0 0 1 19.4 9v8a1.6 1.6 0 0 1-1.6 1.6H6.2A1.6 1.6 0 0 1 4.6 17Z" />
    </Glyph>
  ),
  folderOpen: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M4.6 8.2V7a1.6 1.6 0 0 1 1.6-1.6h3l1.7 2h6.9A1.6 1.6 0 0 1 19.4 9v1.2" />
      <path d="M5.4 18.6h11.4a1.6 1.6 0 0 0 1.5-1.1l1.4-4.2a1 1 0 0 0-.9-1.3H7.4a1.6 1.6 0 0 0-1.5 1.1l-1.5 4.2a1 1 0 0 0 .9 1.3Z" />
    </Glyph>
  ),
  fileCode: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M13.6 4.8H7.4a1.6 1.6 0 0 0-1.6 1.6v11.2a1.6 1.6 0 0 0 1.6 1.6h9.2a1.6 1.6 0 0 0 1.6-1.6V9.4Z" />
      <path d="M13.6 4.8v4.6h4.6M10.6 12.4l-1.8 1.8 1.8 1.8M13.4 12.4l1.8 1.8-1.8 1.8" />
    </Glyph>
  ),
  folderClock: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M4.6 8.2V7a1.6 1.6 0 0 1 1.6-1.6h3l1.7 2h6.9A1.6 1.6 0 0 1 19.4 9v2.4" />
      <path d="M4.6 10.4v6.6a1.6 1.6 0 0 0 1.6 1.6h5" />
      <circle cx="16.6" cy="15.8" r="3.4" />
      <path d="M16.6 14.2v1.8l1.2.7" />
    </Glyph>
  ),
  keyRound: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <circle cx="8.4" cy="12" r="3.4" />
      <path d="M11.8 12h8.2M17 12v2.8M14.4 12v2.1" />
    </Glyph>
  ),
  volume: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M5 9.6h2.6l3.6-3v10.8l-3.6-3H5Z" />
      <path d="M14.4 9.4a3.6 3.6 0 0 1 0 5.2M16.8 7.4a6.6 6.6 0 0 1 0 9.2" />
    </Glyph>
  ),
  helpCircle: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <circle cx="12" cy="12" r="6.6" />
      <path d="M9.9 9.8a2.1 2.1 0 1 1 3.4 1.7c-.8.6-1.3 1-1.3 1.9" />
      <path d="M12 16.8h.01" />
    </Glyph>
  ),
  terminal: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <rect x="4.6" y="5.4" width="14.8" height="13.2" rx="2" />
      <path d="m8 10 2.4 2.2L8 14.4M12.6 14.6h3.4" />
    </Glyph>
  ),
  database: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <ellipse cx="12" cy="6.4" rx="6.4" ry="2.4" />
      <path d="M5.6 6.4v5.6c0 1.3 2.9 2.4 6.4 2.4s6.4-1.1 6.4-2.4V6.4" />
      <path d="M5.6 12v5.6c0 1.3 2.9 2.4 6.4 2.4s6.4-1.1 6.4-2.4V12" />
    </Glyph>
  ),
  wrench: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M15.8 4.2a4.6 4.6 0 0 0-5.4 6.1l-6 6a1.9 1.9 0 0 0 2.7 2.7l6-6a4.6 4.6 0 0 0 6.1-5.4l-2.8 2.8-2.5-.7-.7-2.5Z" />
    </Glyph>
  ),
  shield: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M12 4.6 18.4 7v5.2c0 4.2-2.7 6.6-6.4 7.8-3.7-1.2-6.4-3.6-6.4-7.8V7Z" />
      <path d="m9.2 12 1.9 1.9 3.7-3.9" />
    </Glyph>
  ),
  plug: (props: SettingsGlyphProps) => (
    <Glyph {...props}>
      <path d="M9 4.8v4M15 4.8v4M7.4 8.8h9.2v2.4a4.6 4.6 0 0 1-9.2 0Z" />
      <path d="M12 15.8v3.4" />
    </Glyph>
  ),
} as const;

export type SettingsStructureGlyphName = keyof typeof SETTINGS_STRUCTURE_GLYPHS;

export function SettingsGlyph({
  name,
  classic,
  ...props
}: {
  name: SettingsStructureGlyphName;
  classic: LucideIcon;
} & SettingsGlyphProps) {
  const refined = useSettingsStore((state) => state.settingsIconStyle === "refined");
  const Classic = classic;
  if (!refined) return <Classic {...props} />;
  const Refined = SETTINGS_STRUCTURE_GLYPHS[name];
  return <Refined {...props} />;
}
