import { Input } from "@/components/ui/input";
import { Search } from "../icons";

interface SettingsTopBarProps {
  title: string;
  description: string;
  searchValue: string;
  searchPlaceholder: string;
  onSearchChange: (nextValue: string) => void;
  onClose: () => void;
}

export function SettingsTopBar({
  title,
  description,
  searchValue,
  searchPlaceholder,
  onSearchChange,
  onClose,
}: SettingsTopBarProps) {
  return (
    <header className="ui-surface-base ui-glass z-10 border-b border-border px-4 py-3 min-[1280px]:px-6 min-[1280px]:py-4">
      <div className="flex flex-col gap-3 min-[1280px]:flex-row min-[1280px]:items-start min-[1280px]:justify-between min-[1280px]:gap-4">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-semibold text-on-surface min-[1280px]:text-xl">{title}</h2>
          <p className="mt-1 line-clamp-2 text-xs text-on-surface-variant min-[1280px]:text-sm">{description}</p>
        </div>
        <div className="flex w-full items-center gap-2 min-[1280px]:w-auto min-[1280px]:shrink-0">
          <div className="relative min-w-0 flex-1 min-[1280px]:w-56 min-[1280px]:flex-none">
            <Search
              size={14}
              strokeWidth={1.75}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant"
            />
            <Input
              type="text"
              value={searchValue}
              onChange={(e) => onSearchChange(e.target.value)}
              placeholder={searchPlaceholder}
              className="h-8 rounded-xl border-border bg-surface-container-high pl-8 pr-3 text-xs"
              aria-label="设置搜索"
            />
          </div>
          <button
            onClick={onClose}
            className="ui-interactive shrink-0 rounded-xl border border-border bg-surface-container-high px-2.5 py-1.5 text-xs font-medium text-on-surface-variant"
            aria-label="关闭设置窗口"
          >
            关闭
          </button>
        </div>
      </div>
    </header>
  );
}
