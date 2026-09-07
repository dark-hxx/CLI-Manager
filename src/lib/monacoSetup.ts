import { loader } from "@monaco-editor/react";
import { getCurrentLanguage, type AppLanguage } from "./i18n";
import { monaco, monacoEnglishNlsMessages } from "./monacoEnglishNls";
import { monacoChineseNlsMessages } from "./monacoChineseNls";
import { monacoTraditionalChineseNlsMessages } from "./monacoTraditionalChineseNls";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let configured = false;

interface MonacoNlsGlobal {
  _VSCODE_NLS_MESSAGES?: string[];
  _VSCODE_NLS_LANGUAGE?: string;
}

export function configureMonacoLocale(language: AppLanguage = getCurrentLanguage()) {
  const nls = globalThis as typeof globalThis & MonacoNlsGlobal;
  if (language === "en-US") {
    nls._VSCODE_NLS_MESSAGES = monacoEnglishNlsMessages;
    nls._VSCODE_NLS_LANGUAGE = "en";
  } else if (language === "zh-TW") {
    nls._VSCODE_NLS_MESSAGES = monacoTraditionalChineseNlsMessages;
    nls._VSCODE_NLS_LANGUAGE = "zh-tw";
  } else {
    nls._VSCODE_NLS_MESSAGES = monacoChineseNlsMessages;
    nls._VSCODE_NLS_LANGUAGE = "zh-cn";
  }
}

export function configureMonaco() {
  configureMonacoLocale();
  if (configured) return;
  configured = true;

  (self as unknown as { MonacoEnvironment: { getWorker: (_workerId: string, label: string) => Worker } }).MonacoEnvironment = {
    getWorker(_workerId, label) {
      if (label === "json") return new jsonWorker();
      if (label === "css" || label === "scss" || label === "less") return new cssWorker();
      if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
      if (label === "typescript" || label === "javascript") return new tsWorker();
      return new editorWorker();
    },
  };

  loader.config({ monaco });
}

const EXT_TO_LANGUAGE: Record<string, string> = {
  abap: "abap",
  apex: "apex",
  azcli: "azcli",
  bat: "bat",
  cmd: "bat",
  bicep: "bicep",
  c: "c",
  h: "c",
  clj: "clojure",
  cljs: "clojure",
  coffee: "coffeescript",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  dockerfile: "dockerfile",
  ecl: "ecl",
  ex: "elixir",
  exs: "elixir",
  flow: "flow9",
  fs: "fsharp",
  fsx: "fsharp",
  go: "go",
  graphql: "graphql",
  gql: "graphql",
  hcl: "hcl",
  html: "html",
  htm: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  cjs: "javascript",
  mjs: "javascript",
  json: "json",
  jsonc: "json",
  jl: "julia",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lex: "lexon",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  m: "objective-c",
  mm: "objective-c",
  pas: "pascal",
  p: "pascal",
  pl: "perl",
  php: "php",
  ps1: "powershell",
  psm1: "powershell",
  proto: "proto",
  pug: "pug",
  py: "python",
  r: "r",
  cshtml: "razor",
  redis: "redis",
  rst: "restructuredtext",
  rb: "ruby",
  rs: "rust",
  sb: "sb",
  scala: "scala",
  scss: "scss",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sol: "solidity",
  sql: "sql",
  st: "st",
  swift: "swift",
  sv: "systemverilog",
  svh: "systemverilog",
  tcl: "tcl",
  twig: "twig",
  ts: "typescript",
  tsx: "typescript",
  vb: "vb",
  xml: "xml",
  xsl: "xml",
  yaml: "yaml",
  yml: "yaml",
};

export function languageFromPath(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  if (name === "dockerfile") return "dockerfile";
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
  return EXT_TO_LANGUAGE[ext] ?? "plaintext";
}
