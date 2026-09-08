import { Image } from "@tauri-apps/api/image";
import { writeImage } from "@tauri-apps/plugin-clipboard-manager";

export async function copyStatsImage(canvas: HTMLCanvasElement): Promise<void> {
  const context = canvas.getContext("2d");
  if (!context || canvas.width <= 0 || canvas.height <= 0) throw new Error("stats_screenshot_unavailable");
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  const image = await Image.new(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), canvas.width, canvas.height);
  try {
    await writeImage(image);
  } finally {
    await image.close();
  }
}
