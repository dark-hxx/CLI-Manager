import { useEffect, useRef, useState, type RefObject } from "react";
import { Camera, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "../../../shared/i18n/index";
import { TERM } from "../../stats/api/termStatsUi";
import { captureStatsImage } from "../../stats/api/statsScreenshot";
import { copyStatsImage } from "../../stats/api/statsScreenshotClipboard";

export function StatsScreenshotButton({ targetRef }: { targetRef: RefObject<HTMLElement | null> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const capture = async () => {
    if (inFlight.current || !targetRef.current) return;
    inFlight.current = true;
    setBusy(true);
    let canvas: HTMLCanvasElement | undefined;
    try {
      canvas = await captureStatsImage(targetRef.current);
      if (!mounted.current) return;
      await copyStatsImage(canvas);
      if (mounted.current) toast.success(t("termStats.screenshotCopied"));
    } catch (error) {
      if (mounted.current) toast.error(t(error instanceof Error && error.message === "stats_screenshot_too_large"
        ? "termStats.screenshotTooLarge" : "termStats.screenshotFailed"));
    } finally {
      if (canvas) { canvas.width = 0; canvas.height = 0; }
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const label = t(busy ? "termStats.screenshotBusy" : "termStats.screenshot");
  return (
    <button type="button" onClick={() => void capture()} disabled={busy} aria-busy={busy}
      data-stats-screenshot-exclude
      className="ui-focus-ring rounded p-0.5 transition-opacity hover:opacity-80 disabled:cursor-wait disabled:opacity-50"
      style={{ color: TERM.cyan }} title={label} aria-label={label}>
      {busy ? <LoaderCircle size={11} className="animate-spin" /> : <Camera size={11} />}
    </button>
  );
}
