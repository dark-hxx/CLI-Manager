export const DESKTOP_PET_SIZE_MIN_PERCENT = 40;
export const DESKTOP_PET_SIZE_MAX_PERCENT = 150;
export const DESKTOP_PET_SIZE_STEP_PERCENT = 5;
export const DESKTOP_PET_SIZE_DEFAULT_PERCENT = 100;
export type DesktopPetSizePercent = number;

const LEGACY_DESKTOP_PET_SIZE_PERCENT: Record<string, number> = {
  small: 80,
  medium: 100,
  large: 125,
};

export function normalizeDesktopPetSizePercent(
  value: unknown,
  fallback = DESKTOP_PET_SIZE_DEFAULT_PERCENT
): number {
  const legacyValue = typeof value === "string"
    ? LEGACY_DESKTOP_PET_SIZE_PERCENT[value]
    : undefined;
  const numericValue = typeof value === "number" && Number.isFinite(value)
    ? value
    : legacyValue;
  const safeFallback = Number.isFinite(fallback)
    ? fallback
    : DESKTOP_PET_SIZE_DEFAULT_PERCENT;
  const clamped = Math.min(
    DESKTOP_PET_SIZE_MAX_PERCENT,
    Math.max(DESKTOP_PET_SIZE_MIN_PERCENT, numericValue ?? safeFallback)
  );
  return Math.round(clamped / DESKTOP_PET_SIZE_STEP_PERCENT)
    * DESKTOP_PET_SIZE_STEP_PERCENT;
}

export function desktopPetScaleFromPercent(sizePercent: number): number {
  return normalizeDesktopPetSizePercent(sizePercent) / 100;
}

export function stepDesktopPetSizePercent(
  sizePercent: number,
  direction: number
): number {
  const current = normalizeDesktopPetSizePercent(sizePercent);
  if (!Number.isFinite(direction) || direction === 0) return current;
  return normalizeDesktopPetSizePercent(
    current + Math.sign(direction) * DESKTOP_PET_SIZE_STEP_PERCENT,
    current
  );
}
