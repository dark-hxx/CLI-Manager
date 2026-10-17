// 使用者最近一次操作（點、按鍵、滾輪、捲動）的時間，與手指是不是還在螢幕上。
// 背景工作（例如對話往前補畫）等使用者停下來才做，免得剛好撞上點按、捲動或面板的動畫。
// 移植自 Tap-Code（web/src/activity.ts）；對話視圖掛上時才開始聽，不在載入模組時就掛上。
let last = 0;
let touches = 0;
let listening = false;

/** 開始記錄使用者的操作（重複呼叫無妨）。 */
export function watchActivity() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  last = performance.now();
  const mark = () => { last = performance.now(); };
  const options = { capture: true, passive: true } as const;
  for (const type of ["pointerdown", "keydown", "wheel"] as const) window.addEventListener(type, mark, options);
  document.addEventListener("scroll", mark, options);
  const touch = (event: TouchEvent) => {
    mark();
    touches = event.touches.length;
  };
  window.addEventListener("touchstart", touch, options);
  window.addEventListener("touchend", touch, options);
  window.addEventListener("touchcancel", touch, options);
}

/** 使用者已經停下來多久（毫秒）；手指還在螢幕上時是 0。 */
export function quietFor(): number {
  watchActivity();
  return touches > 0 ? 0 : performance.now() - last;
}
