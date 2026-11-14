import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const project = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(resolve(project, path), "utf8");

// Read the shipped palette tokens and terminal presets, so the preview cannot drift from the app.
export async function loadColorSchemes() {
  const result = await build({
    stdin: { resolveDir: project, contents: `
      export { TERMINAL_THEME_PRESETS, getTerminalTheme, resolveAutoTerminalThemeId,
        isKnownTerminalThemePreset, isLightTerminalTheme, applyTransparency,
        getTerminalMinimumContrastRatio } from "./src/shared/lib/terminalThemes";
      export { resolveTerminalPreviewTheme, FOLLOW_TERMINAL_PREVIEW_THEME } from "./src/shared/lib/terminalPreviewTheme";
      export { zh } from "./src/shared/i18n/messages/settings.zh-CN";
      export { en } from "./src/shared/i18n/messages/settings.en-US";
    ` },
    bundle: true, platform: "node", format: "esm", write: false, logLevel: "silent",
  });
  const runtime = await import("data:text/javascript;base64," + Buffer.from(result.outputFiles[0].text).toString("base64"));
  const source = read("src/styles/themes.css");
  const schemes = [];
  for (const match of source.matchAll(/\[data-theme="(dark|light)"\]\[data-(?:dark|light)-palette="([^"]+)"\]\s*\{([^}]+)\}/gu)) {
    const [, tone, id, block] = match;
    const preset = runtime.TERMINAL_THEME_PRESETS.find((item) =>
      item.nameKey && item.id === id.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())
    );
    if (!preset) continue;
    const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/gu)].map(([, key, value]) => [key, value.trim()]));
    schemes.push({
      id, tone, preset, tokens, css: match[0],
      zh: runtime.zh[preset.nameKey], en: runtime.en[preset.nameKey],
      description: runtime.zh[preset.nameKey.replace(/\.label$/u, ".description")],
      descriptionEn: runtime.en[preset.nameKey.replace(/\.label$/u, ".description")],
    });
  }
  return { schemes, runtime };
}

export function contrastRatio(first, second) {
  const expand = (hex) => hex.length === 4 ? "#" + [...hex.slice(1)].map((part) => part + part).join("") : hex;
  const luminance = (hex) => expand(hex).slice(1).match(/../gu).map((part) => parseInt(part, 16) / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const values = [luminance(first), luminance(second)].sort((a, b) => a - b);
  return (values[1] + 0.05) / (values[0] + 0.05);
}

const escape = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll('"', "&quot;").replaceAll(">", "&gt;");
const bilingual = (zh, en) => `<span data-zh="${escape(zh)}" data-en="${escape(en)}">${escape(zh)}</span>`;

// A standalone design comparison; it does not start services or change saved application preferences.
export function renderPreview(schemes) {
  const cards = schemes.map(({ id, tone, preset, tokens, zh, en, description, descriptionEn }, index) => {
    const term = preset.theme;
    const ratio = contrastRatio(term.foreground, term.background).toFixed(1);
    return `<article class="scheme" data-theme="${tone}" data-${tone}-palette="${id}">
      <header class="scheme-heading">
        <div><span class="eyebrow">0${index + 1} / ${tone.toUpperCase()}</span><h2>${bilingual(zh, en)}</h2></div>
        <span class="tone">${bilingual(tone === "dark" ? "深色" : "浅色", tone === "dark" ? "Dark" : "Light")}</span>
      </header>
      <p class="description">${bilingual(description, descriptionEn)}</p>
      <div class="workspace">
        <div class="window-bar"><span class="window-dot"></span><strong>CLI-Manager</strong><span class="window-path">workspace / main</span></div>
        <div class="workspace-body">
          <aside><div class="nav-title">${bilingual("项目", "PROJECTS")}</div>
            <div class="nav-item current"><span class="project-icon"></span>cli-manager</div>
            <div class="nav-item"><span class="project-icon"></span>design-system</div>
            <div class="nav-item"><span class="project-icon"></span>api-service</div>
            <div class="nav-title sessions-title">${bilingual("工作区", "WORKSPACE")}</div>
            <div class="nav-item">${bilingual("历史会话", "History")}</div><div class="nav-item">${bilingual("用量分析", "Analytics")}</div>
            <div class="sidebar-bottom">${bilingual("通用设置", "General settings")}</div>
          </aside>
          <div class="editor">
            <div class="tabs"><span class="active-tab">PowerShell</span><span>README.md</span><span class="branch">main</span></div>
            <div class="terminal" style="background:${term.background};color:${term.foreground}">
              <div style="color:${term.brightBlack}">PS F:\\work\\cli-manager</div>
              <div><span style="color:${term.cyan}">❯</span> npm run check</div>
              <div class="terminal-gap"><span style="color:${term.green}">✓</span> ${bilingual("类型检查通过", "Type check passed")}</div>
              <div><span style="color:${term.blue}">info</span> ${bilingual("已加载 6 套配色", "6 color schemes loaded")}</div>
              <div><span style="color:${term.yellow}">warn</span> ${bilingual("演示警告信息", "Example warning")}</div>
              <div><span style="color:${term.red}">error</span> ${bilingual("演示错误信息", "Example error")}</div>
              <div><span style="color:${term.magenta}">diff</span> +24 −8 · theme.ts</div>
              <div class="terminal-gap"><span class="selection" style="background:${term.selectionBackground};color:${term.selectionForeground}">${bilingual("选中文字预览", "Selected text preview")}</span></div>
              <div class="terminal-gap"><span style="color:${term.cyan}">❯</span> <span class="caret" style="background:${term.cursor}"></span></div>
            </div>
          </div>
        </div>
        <div class="status"><span>● ${bilingual("就绪", "Ready")}</span><span>UTF-8 · 14:32 · PowerShell</span></div>
      </div>
      <div class="controls"><span class="status-chip">${bilingual("已连接", "Connected")}</span>
        <span class="secondary-button">${bilingual("查看历史", "View history")}</span>
        <span class="primary-button">${bilingual("新建终端", "New terminal")}</span>
      </div>
      <footer><div class="swatches">${["background", "foreground", "red", "green", "yellow", "blue", "magenta", "cyan"]
        .map((key) => `<span title="${key}: ${term[key]}" style="background:${term[key]}"></span>`).join("\n")}</div>
        <span class="contrast">${bilingual("正文对比度", "Text contrast")} ${ratio}:1</span>
      </footer>
      <div class="hex-labels">${tokens["bg-primary"]} · ${tokens["text-primary"]} · ${tokens.accent}</div>
    </article>`;
  }).join("\n");

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CLI-Manager · 成套配色 / Color schemes</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; background: #edf0f4; color: #202630; font: 14px/1.5 "Segoe UI","Microsoft YaHei",sans-serif; }
.page { max-width: 1480px; margin: auto; padding: 46px 32px 56px; }
.page-header { display: flex; justify-content: space-between; gap: 24px; align-items: start; margin-bottom: 24px; }
h1 { font-size: clamp(24px,3vw,34px); letter-spacing: -.8px; margin: 6px 0 8px; font-weight: 600; }
.intro { color: #586473; max-width: 850px; margin: 0; }
.eyebrow { font-size: 10px; letter-spacing: 1.4px; font-weight: 600; }
.filters { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0; }
button { font: inherit; cursor: pointer; border: 1px solid #c3cbd6; background: #fff; color: #344051; border-radius: 7px; padding: 7px 14px; }
button[aria-pressed="true"] { background: #28374b; border-color: #28374b; color: #fff; }
button:focus-visible { outline: 3px solid #0969da; outline-offset: 3px; }
button:hover { border-color: #0969da; }
.grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 24px; }
.scheme { padding: 24px; border: 1px solid var(--border); border-radius: 14px; background: var(--bg-primary); color: var(--text-primary); min-width: 0; }
.scheme[hidden] { display: none; }
.scheme-heading { display: flex; justify-content: space-between; gap: 16px; align-items: center; }
.scheme .eyebrow { color: var(--text-muted); }
h2 { font-size: 23px; letter-spacing: -.5px; font-weight: 600; margin: 2px 0 0; }
.tone { background: var(--bg-tertiary); border-radius: 5px; padding: 3px 8px; color: var(--text-secondary); font-size: 11px; }
.description { margin: 8px 0 20px; color: var(--text-muted); min-height: 42px; }
.workspace { overflow: hidden; border: 1px solid var(--border); border-radius: 9px; }
.window-bar { padding: 9px 12px; display: flex; gap: 8px; align-items: center; background: var(--bg-secondary); border-bottom: 1px solid var(--border); font-size: 11px; }
.window-dot { width: 8px; height: 8px; border: 2px solid var(--accent); border-radius: 3px; }
.window-path { margin-left: auto; color: var(--text-muted); font-family: Consolas,monospace; }
.workspace-body { display: grid; grid-template-columns: 140px minmax(0,1fr); }
aside { background: var(--bg-secondary); padding: 12px 8px; border-right: 1px solid var(--border); font-size: 11px; display: flex; flex-direction: column; }
.nav-title { padding: 0 6px; margin-bottom: 8px; color: var(--text-muted); font-size: 9px; letter-spacing: 1px; }
.nav-item { padding: 6px; border-radius: 4px; display: flex; align-items: center; gap: 7px; color: var(--text-secondary); white-space: nowrap; }
.nav-item.current { background: var(--interactive-selected-bg); color: var(--text-primary); border-left: 2px solid var(--accent); }
.project-icon { width: 10px; height: 8px; border: 1px solid var(--accent); border-radius: 2px; }
.sessions-title { margin-top: 23px; }
.sidebar-bottom { margin-top: auto; color: var(--text-muted); padding: 22px 6px 0; }
.editor { min-width: 0; }
.tabs { display: flex; gap: 14px; background: var(--bg-secondary); color: var(--text-muted); padding: 0 12px; font-size: 10px; height: 31px; align-items: center; border-bottom: 1px solid var(--border); }
.active-tab { height: 31px; display: flex; align-items: center; border-bottom: 2px solid var(--accent); color: var(--text-primary); }
.branch { margin-left: auto; }
.terminal { padding: 15px; font: 11px/1.8 Consolas,"Cascadia Code","Microsoft YaHei",monospace; min-height: 262px; overflow: auto; white-space: nowrap; }
.terminal-gap { margin-top: 9px; }
.selection { padding: 2px 4px; border-radius: 2px; }
.caret { display: inline-block; width: 6px; height: 12px; vertical-align: middle; }
.status { display: flex; justify-content: space-between; gap: 8px; padding: 5px 12px; background: var(--bg-secondary); border-top: 1px solid var(--border); color: var(--text-secondary); font-size: 10px; }
.controls { display: flex; gap: 8px; align-items: center; margin: 16px 0 22px; font-size: 11px; }
.status-chip { margin-right: auto; color: var(--success); }
.primary-button,.secondary-button { border-radius: 5px; padding: 7px 12px; }
.primary-button { background: var(--accent); color: var(--on-primary); font-weight: 600; }
.secondary-button { background: var(--bg-secondary); border: 1px solid var(--border); }
footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.swatches { display: flex; gap: 6px; }
.swatches span { width: 18px; height: 18px; border: 1px solid var(--border); border-radius: 4px; }
.contrast { color: var(--text-muted); font-size: 10px; }
.hex-labels { margin-top: 10px; font: 10px Consolas,monospace; color: var(--text-muted); }
.notes { margin-top: 24px; color: #586473; font-size: 12px; }
@media(max-width:1000px) { .grid { grid-template-columns: 1fr; } .scheme { padding: 20px; } }
@media(max-width:480px) { .page { padding: 20px 12px; } .page-header { flex-direction: column; gap: 12px; } .workspace-body { grid-template-columns: 100px minmax(0,1fr); } .window-path { display: none; } .scheme { padding: 14px; } .swatches { gap: 4px; } .swatches span { width: 15px; height: 15px; } }
${schemes.map((scheme) => scheme.css).join("\n")}
</style></head><body><main class="page">
<header class="page-header"><div><div class="eyebrow">CLI-MANAGER / COLOR COLLECTION</div>
<h1>${bilingual("让界面与终端，使用同一种色调", "One palette, from workspace to terminal")}</h1>
<p class="intro">${bilingual("三组灵感，六套成对配色。比较界面层次、ANSI 日志、选中文字与操作按钮。", "Three inspirations, six paired schemes. Compare surfaces, ANSI output, selections and action colors.")}</p></div>
<button id="language" type="button">English</button></header>
<nav class="filters" aria-label="配色筛选 / Scheme filters">
<button data-filter="all" aria-pressed="true">${bilingual("全部配色", "All schemes")}</button>
<button data-filter="dark" aria-pressed="false">${bilingual("深色", "Dark")}</button>
<button data-filter="light" aria-pressed="false">${bilingual("浅色", "Light")}</button></nav>
<div class="grid">${cards}</div>
<p class="notes">${bilingual("在「设置 → 通用」选择界面配色；终端选择「跟随系统」可自动搭配，也可在主题库独立选择。此页为静态设计预览，具体桌面效果待人工验收。", "Choose a palette in Settings → General. Follow system in terminal settings pairs it automatically; independent selection is also available. This static design preview does not replace desktop visual acceptance.")}</p>
</main><script>
let language = "zh";
document.querySelector("#language").addEventListener("click", (event) => {
  language = language === "zh" ? "en" : "zh";
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en-US";
  document.querySelectorAll("[data-zh]").forEach((node) => { node.textContent = node.dataset[language]; });
  event.currentTarget.textContent = language === "zh" ? "English" : "中文";
});
document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-filter]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  document.querySelectorAll(".scheme").forEach((card) => { card.hidden = button.dataset.filter !== "all" && card.dataset.theme !== button.dataset.filter; });
}));
</script></body></html>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { schemes } = await loadColorSchemes();
  const target = resolve(project, "docs/design/paired-color-schemes.html");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, renderPreview(schemes));
  console.log(`Wrote ${schemes.length} schemes to ${target}`);
}
