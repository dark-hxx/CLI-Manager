import { Minus, Plus, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { useI18n } from "../../lib/i18n";

const FONT_SIZE_CONTROL_HIDE_DELAY_MS = 2_000;

interface FontSizeControlProps {
  fontSize: number;
  defaultFontSize: number;
  min: number;
  max: number;
  onChange: (fontSize: number) => void;
  className?: string;
  style?: CSSProperties;
  variant?: "default" | "terminal";
}

export function useFontSizeControlVisibility() {
  const [fontSizeControlVisible, setFontSizeControlVisible] = useState(false);
  const hideTimerRef = useRef<number | null>(null);

  const showFontSizeControl = useCallback(() => {
    setFontSizeControlVisible(true);
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => {
      hideTimerRef.current = null;
      setFontSizeControlVisible(false);
    }, FONT_SIZE_CONTROL_HIDE_DELAY_MS);
  }, []);

  useEffect(() => () => {
    if (hideTimerRef.current !== null) window.clearTimeout(hideTimerRef.current);
  }, []);

  return { fontSizeControlVisible, showFontSizeControl };
}

export function FontSizeControl({
  fontSize,
  defaultFontSize,
  min,
  max,
  onChange,
  className = "",
  style,
  variant = "default",
}: FontSizeControlProps) {
  const { t } = useI18n();
  const preventTerminalBlur = (event: ReactMouseEvent<HTMLButtonElement>) => event.preventDefault();
  const buttonClassName = variant === "terminal"
    ? "ui-focus-ring inline-flex h-6 w-6 items-center justify-center rounded transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
    : "ui-focus-ring inline-flex h-6 w-6 items-center justify-center rounded hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div
      className={`ui-font-size-control inline-flex h-8 items-center gap-0.5 rounded-md border border-border bg-surface-container-highest/95 p-1 text-text-primary shadow-lg backdrop-blur ${className}`}
      style={style}
      role="group"
      aria-label={t("fontSize.controls")}
    >
      <button
        type="button"
        onMouseDown={preventTerminalBlur}
        onClick={() => onChange(fontSize - 1)}
        disabled={fontSize <= min}
        className={buttonClassName}
        aria-label={t("fontSize.decrease")}
        title={t("fontSize.decrease")}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <span className="min-w-10 select-none px-1 text-center font-mono text-xs tabular-nums" aria-live="polite">
        {t("fontSize.value", { size: fontSize })}
      </span>
      <button
        type="button"
        onMouseDown={preventTerminalBlur}
        onClick={() => onChange(fontSize + 1)}
        disabled={fontSize >= max}
        className={buttonClassName}
        aria-label={t("fontSize.increase")}
        title={t("fontSize.increase")}
      >
        <Plus size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        onMouseDown={preventTerminalBlur}
        onClick={() => onChange(defaultFontSize)}
        disabled={fontSize === defaultFontSize}
        className={buttonClassName}
        aria-label={t("fontSize.reset")}
        title={t("fontSize.reset")}
      >
        <RotateCcw size={13} aria-hidden="true" />
      </button>
    </div>
  );
}
