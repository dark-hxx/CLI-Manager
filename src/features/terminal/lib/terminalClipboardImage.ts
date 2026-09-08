// Clipboard / image helpers for terminal paste. No xterm runtime dependency.

const CLIPBOARD_IMAGE_MAX_PIXELS = 12_000_000;

export const getClipboardImageFile = (clipboardData: DataTransfer | null) => {
  const items = Array.from(clipboardData?.items ?? []);
  const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
  return imageItem?.getAsFile() ?? null;
};

export const getImageFileExtension = (file: File) => {
  const typeExtension = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (typeExtension) return typeExtension;
  const nameExtension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return nameExtension || "png";
};

export const createClipboardImageFileName = (file: File) => {
  const trimmedName = file.name.trim();
  if (trimmedName && /\.[a-z0-9]+$/iu.test(trimmedName)) return trimmedName;
  const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/u, "");
  return `screenshot-${timestamp}.${getImageFileExtension(file)}`;
};

export const arrayBufferToBase64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
};

export const createClipboardPngFile = async (
  rgba: Uint8Array,
  width: number,
  height: number,
): Promise<File> => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error("clipboard_image_dimensions_invalid");
  }
  const pixelCount = width * height;
  if (pixelCount > CLIPBOARD_IMAGE_MAX_PIXELS) {
    throw new Error("clipboard_image_dimensions_too_large");
  }
  if (rgba.byteLength !== pixelCount * 4) {
    throw new Error("clipboard_image_rgba_length_invalid");
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("clipboard_image_canvas_unavailable");

  const pixels = new Uint8ClampedArray(rgba.byteLength);
  pixels.set(rgba);
  context.putImageData(new ImageData(pixels, width, height), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
      } else {
        reject(new Error("clipboard_image_png_encode_failed"));
      }
    }, "image/png");
  });
  return new File([blob], "", { type: "image/png" });
};

export const hasDataTransferType = (dataTransfer: DataTransfer | null, type: string): boolean => {
  if (!dataTransfer) return false;
  const types = dataTransfer.types as DataTransfer["types"] & {
    contains?: (value: string) => boolean;
  };
  if (typeof types.contains === "function") return types.contains(type);
  return Array.from(types).includes(type);
};
