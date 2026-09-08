import type { ReactNode } from "react";

/**
 * 供应商列表行组件（Editorial 左侧列表风格）。
 *
 * 参考 docs/UI/code.html 142-176 行：
 * - 选中态：6px 左强调条 + 柔粉底（primary-fixed/40）+ rounded-3xl(24px) + 柔光 shadow
 * - 双行布局：大名称（18px）+ 小副标（10px 大写 category/appType）
 * - 右侧徽章：pill 形，选中用红底白字、普通用 secondary-container
 * 映射到系统主题 token（`--primary` / `--surface-*`），适配 18 套主题与暗色模式。
 */
export interface ProviderRowProps {
  /** 选中态 */
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** 主名称 */
  name: string;
  /** 副标题（category / appType），显示在名称下方小字；若传 customSubtitle 则忽略此字段 */
  subtitle?: string;
  /** 自定义副标题（用于 Modal 的 baseUrl / 解析失败等复杂内容） */
  customSubtitle?: ReactNode;
  /** 右侧徽章：isCurrent="全局当前" / isActive="ACTIVE"（切换弹窗用） / category badge 等；若传 customTrailing 则忽略 */
  badge?: {
    label: string;
    /** "active"=红底白字 | "current"=secondary-container | "neutral"=灰底 */
    variant: "active" | "current" | "neutral";
  };
  /** 自定义右侧内容（用于 Modal 的 Check 图标 / "切换中…" 等状态） */
  customTrailing?: ReactNode;
}

export function ProviderRow({
  selected,
  onClick,
  disabled = false,
  name,
  subtitle,
  customSubtitle,
  badge,
  customTrailing,
}: ProviderRowProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-selected={selected ? "true" : "false"}
      aria-pressed={selected}
      className="ui-focus-ring group flex w-full items-center justify-between gap-4 p-5 text-left transition-all disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        appearance: "none",
        borderTop: "none",
        borderRight: "none",
        borderBottom: "none",
        borderLeft: selected ? "6px solid var(--primary)" : "6px solid transparent",
        borderRadius: "24px",
        backgroundColor: selected
          ? "color-mix(in srgb, var(--primary) 10%, var(--surface-container-lowest))"
          : "transparent",
        color: selected ? "var(--primary)" : "var(--on-surface-variant)",
        cursor: disabled ? "not-allowed" : "pointer",
        font: "inherit",
        fontWeight: selected ? 700 : 500,
        boxShadow: selected ? "0 0 18px color-mix(in srgb, var(--primary) 14%, transparent)" : "none",
      }}
      onMouseEnter={(e) => {
        if (!selected && !disabled) {
          e.currentTarget.style.backgroundColor = "var(--surface-container-low)";
        }
      }}
      onMouseLeave={(e) => {
        if (!selected) {
          e.currentTarget.style.backgroundColor = "transparent";
        }
      }}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span
          className="font-headline tracking-tight transition-colors"
          style={{
            fontSize: "18px",
            lineHeight: 1.3,
            color: selected ? "var(--primary)" : "inherit",
          }}
        >
          {name}
        </span>
        {customSubtitle ? (
          customSubtitle
        ) : subtitle ? (
          <span
            className="font-medium uppercase tracking-widest"
            style={{
              fontSize: "10px",
              color: selected
                ? "color-mix(in srgb, var(--primary) 60%, transparent)"
                : "var(--on-surface-variant)",
            }}
          >
            {subtitle}
          </span>
        ) : null}
      </div>
      {customTrailing ? (
        <div className="shrink-0">{customTrailing}</div>
      ) : badge ? (
        <ProviderListBadge variant={badge.variant}>{badge.label}</ProviderListBadge>
      ) : null}
    </button>
  );
}

function ProviderListBadge({
  variant,
  children,
}: {
  variant: "active" | "current" | "neutral";
  children: ReactNode;
}) {
  const styles = {
    active: {
      backgroundColor: "var(--primary)",
      color: "var(--on-primary)",
    },
    current: {
      backgroundColor: "color-mix(in srgb, var(--primary) 12%, var(--surface-container-lowest))",
      color: "var(--primary)",
    },
    neutral: {
      backgroundColor: "var(--surface-variant)",
      color: "var(--on-surface-variant)",
    },
  };

  return (
    <span
      className="shrink-0 rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-widest"
      style={styles[variant]}
    >
      {children}
    </span>
  );
}

export type ProviderBadgeTone = "primary" | "neutral" | "danger";

const BADGE_TONE_STYLES: Record<
  ProviderBadgeTone,
  { backgroundColor: string; borderColor: string; color: string }
> = {
  // primary：替代旧的绿/蓝多彩药丸，统一为系统单色强调
  primary: {
    backgroundColor: "color-mix(in srgb, var(--primary) 12%, transparent)",
    borderColor: "color-mix(in srgb, var(--primary) 24%, transparent)",
    color: "var(--primary)",
  },
  // neutral：替代灰色药丸（如分类）
  neutral: {
    backgroundColor: "color-mix(in srgb, var(--on-surface) 6%, transparent)",
    borderColor: "color-mix(in srgb, var(--border) 60%, transparent)",
    color: "var(--on-surface-variant)",
  },
  // danger：仅用于错误语义（如配置解析失败）
  danger: {
    backgroundColor: "color-mix(in srgb, var(--danger) 12%, transparent)",
    borderColor: "color-mix(in srgb, var(--danger) 32%, transparent)",
    color: "var(--danger)",
  },
};

/** 供应商徽章：用于详情页 Hero 头的状态标（全局当前/配置解析失败/category/apiFormat 等） */
export function ProviderBadge({
  tone = "neutral",
  children,
}: {
  tone?: ProviderBadgeTone;
  children: ReactNode;
}) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-lg border px-2 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wider"
      style={BADGE_TONE_STYLES[tone]}
    >
      {children}
    </span>
  );
}
