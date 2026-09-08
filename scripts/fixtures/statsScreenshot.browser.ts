import { captureStatsImage } from "../../src/features/stats/api/statsScreenshot";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function runScreenshotRegression() {
  const results: string[] = [];
  for (const theme of ["dark", "light"]) {
    for (const position of [0, 300, 900]) {
      const wrapper = document.createElement("div");
      wrapper.style.setProperty("--fixture-background", theme === "dark" ? "rgb(12,18,24)" : "rgb(245,246,248)");
      wrapper.innerHTML = `<section style="width:240px;height:180px;display:flex;flex-direction:column;overflow:hidden;background:var(--fixture-background);font:12px monospace">
        <header style="height:36px;flex-shrink:0">实时统计 / Live statistics <button data-stats-screenshot-exclude>capture</button></header>
        <div data-stats-screenshot-scroll style="display:flex;flex-direction:column;flex:1;min-height:0;overflow-y:auto">
          <div style="height:120px;flex-shrink:0">Top card</div>
          <canvas width="200" height="50" style="width:200px;height:50px;flex-shrink:0"></canvas>
          <svg xmlns="http://www.w3.org/2000/svg" width="200" height="50" style="flex-shrink:0"><rect width="200" height="50" fill="rgb(0,0,255)"/></svg>
          <div style="height:800px;flex-shrink:0">Long statistics cards</div>
          <footer style="height:40px;flex-shrink:0;background:rgb(255,0,0)">Bottom card</footer>
        </div>
      </section>`;
      document.body.append(wrapper);
      const panel = wrapper.querySelector("section")!;
      const scroll = wrapper.querySelector<HTMLElement>("[data-stats-screenshot-scroll]")!;
      const context = wrapper.querySelector("canvas")!.getContext("2d")!;
      context.fillStyle = "rgb(0,255,0)";
      context.fillRect(0, 0, 200, 50);
      scroll.scrollTop = position;
      const before = scroll.scrollTop;
      const job = captureStatsImage(panel);
      wrapper.style.setProperty("--fixture-background", "rgb(255,0,255)");
      wrapper.querySelector("footer")!.style.background = "black";
      const image = await job;
      const pixels = image.getContext("2d")!;
      const ratio = image.width / 240;
      const pixel = (x: number, y: number) => [...pixels.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data].slice(0, 3).join(",");
      check(image.height >= 1096, `Full height missing: ${image.height}`);
      check(pixel(220, 60) === (theme === "dark" ? "12,18,24" : "245,246,248"), "Inherited theme lost");
      check(pixel(180, 180) === "0,255,0", "Canvas chart lost");
      check(pixel(180, 230) === "0,0,255", "SVG chart lost");
      check(pixel(220, 1090) === "255,0,0", "Bottom card clipped or snapshot mutated");
      check(scroll.scrollTop === before && panel.clientHeight === 180, "Live scroll/layout changed");
      check(!document.querySelector("[data-stats-screenshot-host]"), "Temporary capture host leaked");
      results.push(`${theme} scroll=${position}: ${image.width}x${image.height}, all assertions passed`);
      image.width = image.height = 0;
      wrapper.remove();
    }
  }
  const oversized = document.createElement("section");
  oversized.style.width = "200px";
  oversized.innerHTML = '<div data-stats-screenshot-scroll><div style="height:40000px">Too tall</div></div>';
  document.body.append(oversized);
  let rejected = false;
  try { await captureStatsImage(oversized); } catch { rejected = true; }
  check(rejected, "Oversized capture must fail before allocating its canvas");
  check(!document.querySelector("[data-stats-screenshot-host]"), "Rejected capture leaked a host");
  oversized.remove();
  results.push("Oversized capture rejection and cleanup passed");
  return results;
}
