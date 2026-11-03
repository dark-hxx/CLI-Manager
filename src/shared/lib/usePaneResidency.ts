import { useEffect, useState } from "react";

/** Retain fast tab switches, but release hidden renderers without closing their data owner. */
export function usePaneResidency(visible: boolean, delayMs = 10_000): boolean {
  const [warm, setWarm] = useState(visible);
  useEffect(() => {
    if (visible) { setWarm(true); return; }
    const timer = setTimeout(() => setWarm(false), delayMs);
    return () => clearTimeout(timer);
  }, [visible, delayMs]);
  return visible || warm;
}
