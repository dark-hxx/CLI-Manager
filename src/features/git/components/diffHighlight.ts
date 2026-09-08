// Git diff 语法高亮：为 react-diff-view 的 tokenize 提供 refractor(Prism) 实例与语言探测。
//
// react-diff-view@3 的 tokenize 期望 refractor v2/v3 语义（highlight 返回节点数组）。
// 用 refractor/core 按依赖顺序注册精选语言，控制打包体积；未知扩展名返回 null，
// 调用方回退为无高亮 tokenize。
import * as refractor from "refractor/core";
import markup from "refractor/lang/markup";
import clike from "refractor/lang/clike";
import css from "refractor/lang/css";
import javascript from "refractor/lang/javascript";
import jsx from "refractor/lang/jsx";
import typescript from "refractor/lang/typescript";
import tsx from "refractor/lang/tsx";
import json from "refractor/lang/json";
import bash from "refractor/lang/bash";
import rust from "refractor/lang/rust";
import python from "refractor/lang/python";
import yaml from "refractor/lang/yaml";
import toml from "refractor/lang/toml";
import markdown from "refractor/lang/markdown";
import sql from "refractor/lang/sql";
import go from "refractor/lang/go";
import java from "refractor/lang/java";
import c from "refractor/lang/c";
import cpp from "refractor/lang/cpp";
import scss from "refractor/lang/scss";
import ruby from "refractor/lang/ruby";
import diff from "refractor/lang/diff";

// 注册顺序须满足依赖：base（markup/clike/css）先于派生（javascript/jsx/tsx/cpp/scss…）。
const LANGUAGES = [
  markup, clike, css,
  javascript, jsx, typescript, tsx,
  json, bash, rust, python, yaml, toml, markdown, sql, go, java,
  c, cpp, scss, ruby, diff,
];

for (const lang of LANGUAGES) {
  refractor.register(lang);
}

// 文件扩展名 → 已注册的 refractor 语言名。
const EXT_TO_LANGUAGE: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  json: "json", jsonc: "json", json5: "json",
  css: "css",
  scss: "scss", sass: "scss",
  html: "markup", htm: "markup", xml: "markup", vue: "markup", svelte: "markup",
  md: "markdown", markdown: "markdown", mdx: "markdown",
  sh: "bash", bash: "bash", zsh: "bash",
  rs: "rust",
  py: "python", pyw: "python",
  yml: "yaml", yaml: "yaml",
  toml: "toml",
  sql: "sql",
  go: "go",
  java: "java",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  rb: "ruby",
  diff: "diff", patch: "diff",
};

/**
 * 由文件名探测 refractor 语言名；未知或无扩展名返回 null（调用方回退无高亮）。
 */
export function detectLanguage(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return EXT_TO_LANGUAGE[ext] ?? null;
}

export { refractor };
