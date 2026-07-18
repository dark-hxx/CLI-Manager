import { useEffect, useMemo, useState, type CSSProperties, type SyntheticEvent } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  joinPetAssetPath,
  type DesktopPetMood,
  type InstalledPet,
} from "../../lib/desktopPet";
import "./PetArtwork.css";

const CODEX_CELL_WIDTH = 192;
const CODEX_CELL_HEIGHT = 208;
const CODEX_COLUMNS = 8;
const SPRITE_ALPHA_THRESHOLD = 4;
const SPRITE_FIT_PADDING = 0.92;

interface SpriteContentBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SpriteContentLayout {
  left: number;
  top: number;
  scale: number;
}

const FULL_SPRITE_BOUNDS: SpriteContentBounds = {
  x: 0,
  y: 0,
  width: CODEX_CELL_WIDTH,
  height: CODEX_CELL_HEIGHT,
};
const spriteBoundsCache = new Map<string, SpriteContentBounds>();

export function calculateSpriteContentLayout(
  width: number,
  height: number,
  bounds: SpriteContentBounds
): SpriteContentLayout {
  const safeBounds = bounds.width > 0 && bounds.height > 0 ? bounds : FULL_SPRITE_BOUNDS;
  const scale = Math.min(width / safeBounds.width, height / safeBounds.height) * SPRITE_FIT_PADDING;
  return {
    left: width / 2 - (safeBounds.x + safeBounds.width / 2) * scale,
    top: height / 2 - (safeBounds.y + safeBounds.height / 2) * scale,
    scale,
  };
}

function measureSpriteContentBounds(
  image: HTMLImageElement,
  row: number,
  frames: number
): SpriteContentBounds {
  const canvas = document.createElement("canvas");
  canvas.width = CODEX_CELL_WIDTH;
  canvas.height = CODEX_CELL_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return FULL_SPRITE_BOUNDS;

  let minX = CODEX_CELL_WIDTH;
  let minY = CODEX_CELL_HEIGHT;
  let maxX = -1;
  let maxY = -1;
  try {
    for (let frame = 0; frame < frames; frame += 1) {
      context.clearRect(0, 0, CODEX_CELL_WIDTH, CODEX_CELL_HEIGHT);
      context.drawImage(
        image,
        frame * CODEX_CELL_WIDTH,
        row * CODEX_CELL_HEIGHT,
        CODEX_CELL_WIDTH,
        CODEX_CELL_HEIGHT,
        0,
        0,
        CODEX_CELL_WIDTH,
        CODEX_CELL_HEIGHT
      );
      const pixels = context.getImageData(0, 0, CODEX_CELL_WIDTH, CODEX_CELL_HEIGHT).data;
      for (let y = 0; y < CODEX_CELL_HEIGHT; y += 1) {
        for (let x = 0; x < CODEX_CELL_WIDTH; x += 1) {
          if (pixels[(y * CODEX_CELL_WIDTH + x) * 4 + 3] <= SPRITE_ALPHA_THRESHOLD) continue;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }
  } catch {
    return FULL_SPRITE_BOUNDS;
  }
  if (maxX < minX || maxY < minY) return FULL_SPRITE_BOUNDS;
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

interface PetArtworkProps {
  pet: InstalledPet;
  alt: string;
  width: number;
  height: number;
  mood?: DesktopPetMood;
  animated?: boolean;
  className?: string;
  onError?: () => void;
}

interface CodexSpriteArtworkProps {
  assetUrl: string;
  alt: string;
  width: number;
  height: number;
  row: number;
  rows: number;
  frames: number;
  animated: boolean;
  className: string;
  onError?: () => void;
}

function CodexSpriteArtwork({
  assetUrl,
  alt,
  width,
  height,
  row,
  rows,
  frames,
  animated,
  className,
  onError,
}: CodexSpriteArtworkProps) {
  const boundsKey = `${assetUrl}|${row}|${frames}`;
  const [contentBounds, setContentBounds] = useState<SpriteContentBounds>(
    () => spriteBoundsCache.get(boundsKey) ?? FULL_SPRITE_BOUNDS
  );
  useEffect(() => {
    setContentBounds(spriteBoundsCache.get(boundsKey) ?? FULL_SPRITE_BOUNDS);
  }, [boundsKey]);
  const layout = useMemo(
    () => calculateSpriteContentLayout(width, height, contentBounds),
    [contentBounds, height, width]
  );
  const handleProbeLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    const cached = spriteBoundsCache.get(boundsKey);
    if (cached) {
      setContentBounds(cached);
      return;
    }
    const measured = measureSpriteContentBounds(event.currentTarget, row, frames);
    spriteBoundsCache.set(boundsKey, measured);
    setContentBounds(measured);
  };
  const spriteStyle = {
    left: `${layout.left}px`,
    top: `${layout.top}px`,
    backgroundImage: `url(${assetUrl})`,
    backgroundPositionY: `${-row * CODEX_CELL_HEIGHT}px`,
    backgroundSize: `${CODEX_CELL_WIDTH * CODEX_COLUMNS}px ${CODEX_CELL_HEIGHT * rows}px`,
    transform: `scale(${layout.scale})`,
    "--pet-sprite-end-x": `${-frames * CODEX_CELL_WIDTH}px`,
    "--pet-sprite-frames": frames,
    "--pet-sprite-duration": `${Math.max(frames * 260, 1400)}ms`,
  } as CSSProperties;

  return (
    <span
      className={`pet-artwork pet-artwork-sprite-viewport ${className}`}
      style={{ width, height }}
      role="img"
      aria-label={alt}
    >
      <img
        className="pet-artwork-sprite-probe"
        src={assetUrl}
        alt=""
        aria-hidden="true"
        onLoad={handleProbeLoad}
        onError={onError}
      />
      <span
        className={`pet-artwork-sprite ${animated && frames > 1 ? "is-animated" : ""}`}
        style={spriteStyle}
        aria-hidden="true"
      />
    </span>
  );
}

export function PetArtwork({
  pet,
  alt,
  width,
  height,
  mood = "idle",
  animated = true,
  className = "",
  onError,
}: PetArtworkProps) {
  const stateAsset = pet.manifest.states[mood] ?? pet.manifest.states.idle;
  const assetUrl = convertFileSrc(joinPetAssetPath(pet.baseDir, stateAsset.file));

  if (pet.manifest.engine !== "codex-sprite") {
    return (
      <span className={`pet-artwork ${className}`} style={{ width, height }}>
        <img
          className="pet-artwork-image"
          src={assetUrl}
          alt={alt}
          draggable={false}
          onError={onError}
        />
      </span>
    );
  }

  const rows = pet.manifest.spriteVersionNumber === 2 ? 11 : 9;
  const row = Math.max(0, Math.min(rows - 1, stateAsset.row ?? 0));
  const frames = Math.max(1, Math.min(CODEX_COLUMNS, stateAsset.frames ?? 1));
  return (
    <CodexSpriteArtwork
      assetUrl={assetUrl}
      alt={alt}
      width={width}
      height={height}
      row={row}
      rows={rows}
      frames={frames}
      animated={animated}
      className={className}
      onError={onError}
    />
  );
}
