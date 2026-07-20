import { useEffect, useMemo, useRef, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../../lib/i18n";

export type StatsDatePickerMode = "date" | "month";

interface StatsDatePickerProps {
  mode: StatsDatePickerMode;
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  className?: string;
}

const WEEK_START_MONDAY = 1;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDateValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toMonthValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}`;
}

function parseViewDate(value: string, mode: StatsDatePickerMode, min?: string, max?: string): Date {
  const source = value || min || max;
  if (source) {
    const [yearRaw, monthRaw, dayRaw] = source.split("-");
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = mode === "date" ? Number(dayRaw) || 1 : 1;
    if (Number.isFinite(year) && Number.isFinite(month) && year > 0 && month >= 1 && month <= 12) {
      return new Date(year, month - 1, day);
    }
  }
  return new Date();
}

function clampMonthDelta(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function isBeforeMin(value: string, min?: string): boolean {
  return Boolean(min && value < min);
}

function isAfterMax(value: string, max?: string): boolean {
  return Boolean(max && value > max);
}

function useOutsideClose(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  return ref;
}

export function StatsDatePicker({
  mode,
  value,
  onChange,
  ariaLabel,
  min,
  max,
  disabled = false,
  className = "",
}: StatsDatePickerProps) {
  const { language, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => parseViewDate(value, mode, min, max));
  const rootRef = useOutsideClose(open, () => setOpen(false));

  useEffect(() => {
    if (open) setViewDate(parseViewDate(value, mode, min, max));
  }, [max, min, mode, open, value]);

  const locale = language === "en-US" ? "en-US" : language;
  const displayText = useMemo(() => {
    if (!value) return ariaLabel;
    const date = parseViewDate(value, mode);
    return new Intl.DateTimeFormat(locale, mode === "date" ? { year: "numeric", month: "2-digit", day: "2-digit" } : { year: "numeric", month: "2-digit" }).format(date);
  }, [ariaLabel, locale, mode, value]);
  const title = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" }).format(viewDate),
    [locale, viewDate]
  );
  const weekdayLabels = useMemo(() => {
    const base = new Date(2024, 0, 1);
    return Array.from({ length: 7 }, (_, index) =>
      new Intl.DateTimeFormat(locale, { weekday: "narrow" }).format(new Date(base.getFullYear(), base.getMonth(), base.getDate() + index))
    );
  }, [locale]);

  const dateCells = useMemo(() => {
    const first = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
    const offset = (first.getDay() - WEEK_START_MONDAY + 7) % 7;
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - offset);
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const dateValue = toDateValue(date);
      return {
        date,
        value: dateValue,
        currentMonth: date.getMonth() === viewDate.getMonth(),
        disabled: isBeforeMin(dateValue, min) || isAfterMax(dateValue, max),
      };
    });
  }, [max, min, viewDate]);

  const monthCells = useMemo(
    () =>
      Array.from({ length: 12 }, (_, month) => {
        const date = new Date(viewDate.getFullYear(), month, 1);
        const monthValue = toMonthValue(date);
        const minMonth = min?.slice(0, 7);
        const maxMonth = max?.slice(0, 7);
        return {
          date,
          value: monthValue,
          label: new Intl.DateTimeFormat(locale, { month: "short" }).format(date),
          disabled: isBeforeMin(monthValue, minMonth) || isAfterMax(monthValue, maxMonth),
        };
      }),
    [locale, max, min, viewDate]
  );

  const selectValue = (nextValue: string) => {
    onChange(nextValue);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        type="button"
        className={`inline-flex items-center justify-between gap-2 ${className}`}
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!disabled) setOpen((current) => !current);
        }}
      >
        <span className="truncate">{displayText}</span>
        <CalendarDays size={13} className="shrink-0 text-text-muted" />
      </button>

      {open && (
        <div className="absolute left-0 top-[calc(100%+6px)] z-[80] w-[278px] rounded-xl border border-border bg-bg-secondary p-3 text-text-primary shadow-2xl">
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              aria-label={mode === "date" ? t("datePicker.previousMonth") : t("datePicker.previousYear")}
              onClick={() => setViewDate((current) => (mode === "date" ? clampMonthDelta(current, -1) : new Date(current.getFullYear() - 1, current.getMonth(), 1)))}
            >
              <ChevronLeft size={15} />
            </button>
            <div className="min-w-0 truncate text-[13px] font-semibold text-text-primary">{mode === "date" ? title : viewDate.getFullYear()}</div>
            <button
              type="button"
              className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-text-secondary hover:bg-bg-tertiary hover:text-text-primary"
              aria-label={mode === "date" ? t("datePicker.nextMonth") : t("datePicker.nextYear")}
              onClick={() => setViewDate((current) => (mode === "date" ? clampMonthDelta(current, 1) : new Date(current.getFullYear() + 1, current.getMonth(), 1)))}
            >
              <ChevronRight size={15} />
            </button>
          </div>

          {mode === "date" ? (
            <>
              <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-text-muted">
                {weekdayLabels.map((label, index) => (
                  <span key={`${label}-${index}`}>{label}</span>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-1">
                {dateCells.map((cell) => {
                  const selected = cell.value === value;
                  return (
                    <button
                      key={cell.value}
                      type="button"
                      disabled={cell.disabled}
                      className="h-8 rounded-lg text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-35"
                      style={{
                        backgroundColor: selected ? "var(--primary)" : "transparent",
                        color: selected ? "var(--primary-foreground, var(--bg-primary))" : cell.currentMonth ? "var(--text-primary)" : "var(--text-muted)",
                      }}
                      onClick={() => selectValue(cell.value)}
                      onMouseEnter={(event) => {
                        if (!selected && !cell.disabled) event.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
                      }}
                      onMouseLeave={(event) => {
                        if (!selected) event.currentTarget.style.backgroundColor = "transparent";
                      }}
                    >
                      {cell.date.getDate()}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {monthCells.map((cell) => {
                const selected = cell.value === value;
                return (
                  <button
                    key={cell.value}
                    type="button"
                    disabled={cell.disabled}
                    className="h-9 rounded-lg text-[12px] font-medium transition disabled:cursor-not-allowed disabled:opacity-35"
                    style={{
                      backgroundColor: selected ? "var(--primary)" : "transparent",
                      color: selected ? "var(--primary-foreground, var(--bg-primary))" : "var(--text-primary)",
                    }}
                    onClick={() => selectValue(cell.value)}
                    onMouseEnter={(event) => {
                      if (!selected && !cell.disabled) event.currentTarget.style.backgroundColor = "var(--bg-tertiary)";
                    }}
                    onMouseLeave={(event) => {
                      if (!selected) event.currentTarget.style.backgroundColor = "transparent";
                    }}
                  >
                    {cell.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
