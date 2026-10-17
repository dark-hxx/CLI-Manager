// 執行過程裡的工具步驟：由主機匯出的 tool_call 參數（與同一個 callId 的 tool_result）推導一列摘要
// （圖示、工具標籤、關鍵參數）與展開後的內容（改動、命令與輸出、任務清單，其他工具照原本的輸入與輸出）。
// 摘要規則改寫自 Tap-Code 的紀錄解析（transcript-core 的 claude/tools.rs、codex/calls.rs）。
// 只讀紀錄裡明確寫下的資訊：參數解析不了（例如被截斷的 JSON）時不推導，交回原本的呈現；
// 不由「有輸出」推斷成功，只有 CLI 明確寫出的失敗（結束碼、錯誤標記）才標成失敗。
import { countLines, createdHunk, lineDiff, type Hunk } from "./diff.ts";
import { parsePatch, shellPatch } from "./patch.ts";
import type { TranscriptMessage, TranscriptPart } from "./protocol";
import type { TextKey } from "./i18n";
import type { Turn } from "./turns";

export type StepIcon = "read" | "edit" | "write" | "bash" | "search" | "files" | "web" | "agent" | "todo" | "plan" | "image"
  | "mcp" | "skill" | "ask" | "tool";
export type Todo = { text: string; status: string };
export type DiffFile = { path: string; moved?: string; op: "add" | "update" | "delete"; hunks: Hunk[]; added: number; removed: number };
export type StepDetail =
  /** showFiles：多個檔案（apply_patch）時每個檔案一個標題；單一檔案的路徑已經在摘要列上。 */
  | { type: "diff"; files: DiffFile[]; showFiles: boolean; truncated: boolean }
  /** stdin：Codex write_stdin 寫進執行中命令的輸入。 */
  | { type: "command"; command: string; description?: string; stdin?: string }
  | { type: "todos"; items: Todo[]; explanation?: string }
  | { type: "generic" };
/**
 * 改動行數的可信度：exact 照算；lower 只算到一部分（replace_all 不知道換了幾處），計入但標「約」；
 * unknown 算不出來（修補被截斷、筆記本），不計入並讓整輪標「約」。
 */
export type Exactness = "exact" | "lower" | "unknown";

export type StepView = {
  id: string;
  name: string;
  /** 工具標籤：有翻譯的用 label，其他（MCP 伺服器、不認得的工具）用 rawLabel。 */
  label?: TextKey;
  rawLabel?: string;
  icon: StepIcon;
  summary: string;
  /** 摘要是檔案路徑：畫面上先顯示檔名，再淡淡地顯示所在目錄。 */
  path?: boolean;
  /** 滑過摘要列時看到的完整內容（路徑、命令說明）。 */
  title?: string;
  detail: StepDetail;
  /** 這一步的所有分塊（呼叫在前），其他工具展開時照原本的方式逐一列出。 */
  parts: TranscriptPart[];
  results: TranscriptPart[];
  /** CLI 明確寫出的結束碼；沒寫時為 undefined。 */
  exit?: number;
  /** 只在 CLI 明確寫出失敗（結束碼非 0、錯誤標記、使用者拒絕）時為真。 */
  failed: boolean;
  changes?: { added: number; removed: number; exactness: Exactness };
};

type Args = Record<string, unknown>;
type Input = { args: Args; raw?: undefined } | { args?: undefined; raw: string };
type Described = Omit<StepView, "id" | "name" | "parts" | "results" | "exit" | "failed">;

const GENERIC: StepDetail = { type: "generic" };
const SUMMARY_LIMIT = 200;
const SHELL_TOOLS = new Set(["shell", "container.exec", "local_shell", "shell_command", "exec_command"]);
/** 會改檔案的工具；參數讀不出來時，這一輪的增刪行數要標「約」。 */
const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit", "apply_patch", "applypatch"]);
const POSIX_SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
/** 參數一定是 JSON 物件的工具；收到其他文字（不完整或格式不對）時不推導，交回原本的呈現。 */
const STRUCTURED = new Set([
  "Read", "NotebookRead", "view_image", "Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "BashOutput", "KillShell", "KillBash",
  "TaskStop", "Grep", "Glob", "WebFetch", "WebSearch", "Task", "Agent", "spawn_agent", "send_message", "followup_task", "Skill",
  "ToolSearch", "LSP", "EnterPlanMode", "ExitPlanMode", "AskUserQuestion", "request_user_input", "request_user_input_async",
  "TodoWrite", "update_plan", "write_stdin", ...SHELL_TOOLS,
]);

const record = (value: unknown): Args | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Args : undefined;
const text = (value: unknown) => typeof value === "string" ? value : "";
const clip = (value: string) => value.length > SUMMARY_LIMIT ? `${value.slice(0, SUMMARY_LIMIT)}…` : value;

/** 第一個非空白的行（去掉前後空白）；全是空白時為空字串。 */
export function firstLine(value: string): string {
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** 路徑的最後一段（Windows 的反斜線也算分隔）。 */
export function fileName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed;
}

/** 不認得的工具用的摘要：參數裡第一個單行、不太長的字串值。 */
function firstShortString(args: Args): string {
  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed && !trimmed.includes("\n") && trimmed.length <= SUMMARY_LIMIT) return trimmed;
  }
  return "";
}

/**
 * 工具參數：以 `{` 開頭的必須是完整的 JSON 物件（Claude 的 input、Codex function_call 的 arguments），
 * 解析失敗（多半是超過 4000 字被截斷）就傳回 undefined，交回原本的呈現；其他是 Codex 自訂工具的原始文字。
 */
function parseInput(value: string): Input | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return { raw: value };
  try {
    const args = record(JSON.parse(trimmed));
    return args ? { args } : undefined;
  } catch {
    return undefined;
  }
}

const quote = (arg: string) => /^[\w\-./=:,+@%]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

/**
 * Codex 殼層命令的文字：`bash -lc '<命令>'`、`powershell -Command <命令>`、`cmd /c <命令>` 只顯示命令本身，
 * 其他 argv 以殼層引號接起來；字串照原樣。
 */
export function commandText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const argv = value.filter((item): item is string => typeof item === "string");
  const program = fileName(argv[0] ?? "").toLowerCase().replace(/\.exe$/, "");
  if (POSIX_SHELLS.has(program) && argv[1]?.startsWith("-") && argv[1].endsWith("c") && argv[2] !== undefined) return argv[2];
  if (program === "powershell" || program === "pwsh") {
    const flag = argv.findIndex((arg, index) => index > 0 && /^-(?:c|command)$/i.test(arg));
    if (flag > 0 && argv[flag + 1] !== undefined) return argv.slice(flag + 1).join(" ");
  }
  if (program === "cmd") {
    const flag = argv.findIndex((arg, index) => index > 0 && /^\/c$/i.test(arg));
    if (flag > 0 && argv[flag + 1] !== undefined) return argv.slice(flag + 1).join(" ");
  }
  return argv.map(quote).join(" ");
}

/**
 * 命令結果的結束碼與內容。Codex 舊版是 `{"output":…,"metadata":{"exit_code":…}}`；新版是表頭（`Exit code:`、
 * `Process exited with code`、`Wall time:`…）加上 `Output:` 之後的內容；Claude Code 失敗時第一行是 `Exit code N`。
 * 看不出結束碼時 exit 為 undefined，內容照原樣。
 */
export function commandResult(value: string): { exit?: number; body: string } {
  const trimmed = value.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = record(JSON.parse(trimmed));
      if (parsed && typeof parsed.output === "string") {
        const code = record(parsed.metadata)?.exit_code;
        return { exit: Number.isInteger(code) ? code as number : undefined, body: parsed.output };
      }
    } catch { /* 不是完整的 JSON，照一般文字處理。 */ }
  }
  const lines = value.split("\n");
  let exit: number | undefined;
  for (let index = 0; index < Math.min(lines.length, 12); index++) {
    const line = lines[index]!.trimEnd();
    if (line === "Output:") return { exit, body: lines.slice(index + 1).join("\n") };
    const code = /^(?:Exit code:? |Process exited with code )(-?\d+)$/.exec(line);
    if (code) exit = Number(code[1]);
  }
  const claude = /^Exit code (-?\d+)\s*$/.exec(lines[0] ?? "");
  if (claude) return { exit: Number(claude[1]), body: lines.slice(1).join("\n") };
  return { exit, body: value };
}

/** CLI 明確寫出的失敗：Claude Code 的 `<tool_use_error>` 標記，或使用者拒絕執行這個工具。 */
const failedText = (value: string) =>
  value.includes("<tool_use_error>") || value.trimStart().startsWith("The user doesn't want to proceed with this tool use");

/** MCP 工具名稱：Claude 的 `mcp__伺服器__工具`，以及 Codex 舊版的 `伺服器__工具`。 */
export function mcpName(name: string): { server: string; tool: string } | undefined {
  const prefixed = name.startsWith("mcp__");
  const rest = prefixed ? name.slice(5) : name;
  const at = rest.indexOf("__");
  if (at > 0 && at < rest.length - 2) return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
  return prefixed && rest ? { server: rest, tool: "" } : undefined;
}

/** 任務清單：TodoWrite 的 todos（content）或 update_plan 的 plan（step）；不是陣列時為 undefined。 */
function todoItems(list: unknown, field: "content" | "step"): Todo[] | undefined {
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((item) => {
    const entry = record(item);
    const label = text(entry?.[field]).trim();
    return entry && label ? [{ text: label, status: text(entry.status).trim() || "pending" }] : [];
  });
}

/** 任務清單的摘要：進行中的那一項，沒有時是第一個還沒完成的。 */
function currentTodo(items: Todo[]): string {
  return (items.find((item) => item.status === "in_progress") ?? items.find((item) => item.status !== "completed"))?.text ?? "";
}

function changesOf(files: DiffFile[], exactness: Exactness): StepView["changes"] {
  return {
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
    exactness,
  };
}

function diffFile(path: string, op: DiffFile["op"], hunks: Hunk[], moved?: string): DiffFile {
  return { path, op, hunks, ...countLines(hunks), ...(moved ? { moved } : {}) };
}

/** Edit／MultiEdit：每一組 old_string → new_string 一段差異；有 replace_all 時行數只算一處。 */
function editStep(path: string, edits: unknown[]): Described | undefined {
  const hunks: Hunk[] = [];
  let lower = false;
  for (const item of edits) {
    const edit = record(item);
    if (!edit) return undefined;
    const replaceAll = edit.replace_all === true;
    lower ||= replaceAll;
    hunks.push({ lines: lineDiff(text(edit.old_string), text(edit.new_string)), ...(replaceAll ? { replaceAll } : {}) });
  }
  const files = [diffFile(path, "update", hunks)];
  return {
    label: "toolEdit", icon: "edit", summary: path, path: true, title: path,
    detail: { type: "diff", files, showFiles: false, truncated: false }, changes: changesOf(files, lower ? "lower" : "exact"),
  };
}

/** apply_patch：依檔案分組；全部是新增的檔案時標成寫入。文字被截斷時行數不計入。 */
function patchStep(patch: string, truncated: boolean): Described {
  const files = parsePatch(patch).map((file) => diffFile(file.path, file.op, file.hunks, file.moved));
  const names = files.map((file) => file.moved ?? file.path);
  const single = names.length === 1 ? names[0]! : undefined;
  return {
    label: files.length && files.every((file) => file.op === "add") ? "toolWrite" : "toolEdit", icon: "edit",
    summary: single ?? names.map(fileName).join(", "), path: Boolean(single), title: names.join("\n") || undefined,
    detail: { type: "diff", files, showFiles: true, truncated }, changes: changesOf(files, truncated ? "unknown" : "exact"),
  };
}

/** 殼層命令；透過殼層呼叫的 apply_patch 改以檔案改動呈現。 */
function commandStep(command: string, argv: unknown, description: string, truncated: boolean): Described {
  const patch = shellPatch(argv, command);
  if (patch !== undefined) return patchStep(patch, truncated);
  return {
    label: "toolBash", icon: "bash", summary: clip(firstLine(command)), title: description || command.trim() || undefined,
    detail: { type: "command", command, ...(description ? { description } : {}) },
  };
}

/** 依工具名稱推導摘要列與展開內容；Claude Code 與 Codex 的工具名稱不重疊，放在同一張表裡。 */
function describe(name: string, input: Input, truncated: boolean): Described | undefined {
  if (input.raw !== undefined) {
    // 原始文字只對 Codex 的自訂工具成立：apply_patch 是修補文字，其他自訂工具顯示第一行。
    if (name === "apply_patch" || name === "applypatch") return input.raw.trim() ? patchStep(input.raw, truncated) : undefined;
    if (STRUCTURED.has(name) || mcpName(name)) return undefined;
    return { rawLabel: name, icon: "tool", summary: clip(firstLine(input.raw)), detail: GENERIC };
  }
  const args = input.args;
  const field = (key: string) => text(args[key]);
  const path = (summary: string, label: TextKey, icon: StepIcon): Described =>
    ({ label, icon, summary, path: Boolean(summary), title: summary || undefined, detail: GENERIC });
  const plain = (label: TextKey, icon: StepIcon, summary: string): Described => ({ label, icon, summary: clip(summary), detail: GENERIC });
  switch (name) {
    case "Read": case "NotebookRead": return path(field("file_path") || field("notebook_path"), "toolRead", "read");
    case "view_image": return path(field("path"), "toolImage", "image");
    case "Edit": return editStep(field("file_path"), [args]);
    case "MultiEdit": return Array.isArray(args.edits) ? editStep(field("file_path"), args.edits) : undefined;
    case "Write": {
      const files = [diffFile(field("file_path"), "add", [createdHunk(field("content"))])];
      return { label: "toolWrite", icon: "write", summary: field("file_path"), path: true, title: field("file_path"),
        detail: { type: "diff", files, showFiles: false, truncated: false }, changes: changesOf(files, "exact") };
    }
    case "NotebookEdit": {
      const notebook = field("notebook_path") || field("file_path");
      return { ...path(notebook, "toolNotebook", "edit"), changes: { added: 0, removed: 0, exactness: "unknown" } };
    }
    case "Bash": return commandStep(field("command"), undefined, field("description").trim(), truncated);
    case "BashOutput": return plain("toolBashOutput", "bash", field("bash_id") || field("shell_id"));
    case "KillShell": case "KillBash": case "TaskStop": return plain("toolStop", "bash", field("shell_id") || field("task_id"));
    case "Grep": case "Glob": {
      const where = field("path");
      return plain(name === "Grep" ? "toolGrep" : "toolGlob", name === "Grep" ? "search" : "files",
        where ? `${field("pattern")} · ${where}` : field("pattern"));
    }
    case "WebFetch": return plain("toolFetch", "web", field("url"));
    case "WebSearch": return plain("toolWebSearch", "web", field("query"));
    case "Task": case "Agent": return plain("toolAgent", "agent", field("description") || field("subagent_type"));
    case "spawn_agent": return plain("toolAgent", "agent", field("task_name").trim() || field("agent_type"));
    case "send_message": case "followup_task": return plain("toolAgent", "agent", field("target"));
    case "Skill": return plain("toolSkill", "skill", field("skill") || field("name") || field("command"));
    case "ToolSearch": return plain("toolSearchTools", "search", field("query"));
    case "LSP": return plain("toolLsp", "search", firstShortString(args));
    case "EnterPlanMode": return plain("toolPlanMode", "plan", "");
    case "ExitPlanMode": return plain("toolExitPlan", "plan", firstLine(field("plan")).replace(/^#+\s*/, ""));
    case "AskUserQuestion": case "request_user_input": case "request_user_input_async": {
      const question = record(Array.isArray(args.questions) ? args.questions[0] : undefined) ?? {};
      return plain("toolAsk", "ask", firstLine(text(question.question) || text(question.header) || text(question.title)));
    }
    case "TodoWrite": case "update_plan": {
      const items = name === "TodoWrite" ? todoItems(args.todos, "content") : todoItems(args.plan, "step");
      if (!items) return plain(name === "TodoWrite" ? "toolTodo" : "toolPlan", "todo", "");
      const explanation = field("explanation").trim();
      return { label: name === "TodoWrite" ? "toolTodo" : "toolPlan", icon: "todo", summary: clip(currentTodo(items)),
        detail: { type: "todos", items, ...(explanation ? { explanation } : {}) } };
    }
    case "apply_patch": case "applypatch": return field("input").trim() ? patchStep(field("input"), truncated) : undefined;
    case "write_stdin": {
      const stdin = field("chars");
      return { label: "toolBashOutput", icon: "bash", summary: clip(firstLine(stdin) || field("session_id")),
        detail: { type: "command", command: "", ...(stdin ? { stdin } : {}) } };
    }
  }
  if (SHELL_TOOLS.has(name)) {
    const command = name === "exec_command" ? field("cmd") : commandText(args.command);
    return commandStep(command, args.command, field("justification").trim(), truncated);
  }
  const mcp = mcpName(name);
  if (mcp) return { rawLabel: mcp.server, icon: "mcp", summary: clip(mcp.tool), detail: GENERIC };
  return { rawLabel: name, icon: "tool", summary: clip(firstShortString(args)), detail: GENERIC };
}

const cache = new WeakMap<TranscriptPart, { id: string; parts: TranscriptPart[]; view: StepView | undefined }>();
const sameParts = (left: readonly TranscriptPart[], right: readonly TranscriptPart[]) =>
  left.length === right.length && left.every((part, index) => part === right[index]);

/**
 * 一個工具步驟（groupTurns 依 callId 合併的呼叫與結果）的摘要與展開內容。不是工具呼叫、沒有工具名稱，
 * 或參數讀不出來時傳回 undefined，畫面改用原本的過程卡。同一個呼叫與結果物件沿用上一次的結果，
 * 讀取更早的紀錄或刷新時不必重算差異。
 */
export function stepView(message: TranscriptMessage): StepView | undefined {
  const parts = message.parts;
  const call = parts?.[0];
  if (message.role !== "tool" || !parts || !call || call.kind !== "tool_call" || !call.toolName) return undefined;
  const cached = cache.get(call);
  if (cached && cached.id === message.id && sameParts(cached.parts, parts)) return cached.view;
  const input = parseInput(call.text);
  const described = input && describe(call.toolName, input, call.truncated === true);
  const results = parts.filter((part) => part.kind === "tool_result");
  let view: StepView | undefined;
  if (described) {
    // 結束碼只看命令與改檔步驟（Codex 的 apply_patch 結果同樣帶表頭）；其他工具的輸出內容不拿來判斷。
    const coded = described.detail.type === "command" || described.detail.type === "diff";
    const exit = coded ? results.map((part) => commandResult(part.text).exit).find((code) => code !== undefined) : undefined;
    view = {
      ...described, id: message.id, name: call.toolName, parts, results, exit,
      failed: results.some((part) => failedText(part.text)) || (exit !== undefined && exit !== 0),
    };
  }
  cache.set(call, { id: message.id, parts: [...parts], view });
  return view;
}

/** 一輪過程裡每個工具步驟的摘要，以步驟 id 對應；讀不出來的不在表裡。 */
export function stepViews(steps: readonly TranscriptMessage[]): Map<string, StepView> {
  const views = new Map<string, StepView>();
  for (const step of steps) {
    const view = stepView(step);
    if (view) views.set(step.id, view);
  }
  return views;
}

export type TurnChanges = { added: number; removed: number; approximate: boolean };

/**
 * 一輪的增刪行數：加總這一輪改檔步驟的差異；CLI 明確寫出失敗的不算。讀不出參數、被截斷、replace_all、
 * 筆記本、過程被省略，或這一輪的開頭還沒讀進來時標「約」（approximate）。沒有任何行數時為 undefined。
 */
export function turnChanges(turn: Turn, views: ReadonlyMap<string, StepView>): TurnChanges | undefined {
  let added = 0;
  let removed = 0;
  let approximate = !turn.prompt;
  for (const step of turn.steps) {
    const view = views.get(step.id);
    if (view?.changes) {
      if (view.failed) continue;
      if (view.changes.exactness !== "exact") approximate = true;
      if (view.changes.exactness === "unknown") continue;
      added += view.changes.added;
      removed += view.changes.removed;
      continue;
    }
    if (view || step.role !== "tool") continue;
    // 原本的過程卡：被省略的分塊，或參數讀不出來的改檔工具（包括殼層裡的 apply_patch）。
    const call = step.parts?.find((part) => part.kind === "tool_call");
    if (!step.parts?.length || (call && (EDIT_TOOLS.has(call.toolName ?? "") || call.text.includes("*** Begin Patch")))) approximate = true;
  }
  return added || removed ? { added, removed, approximate } : undefined;
}

/** 步驟展開後才看得到的文字（命令、輸出、改動、任務），搜尋時用來決定要不要展開。 */
export function stepDetailText(view: StepView): string {
  const outputs = view.results.map((part) => part.text);
  const detail = view.detail;
  switch (detail.type) {
    case "diff": return [...detail.files.flatMap((file) => [file.path, file.moved ?? "", ...file.hunks.flatMap((hunk) =>
      [hunk.header ?? "", ...hunk.lines.map((line) => line.slice(1))])]), ...outputs].join("\n");
    case "command": return [detail.command, detail.description ?? "", detail.stdin ?? "",
      ...view.results.map((part) => commandResult(part.text).body)].join("\n");
    case "todos": return [detail.explanation ?? "", ...detail.items.map((item) => item.text), ...outputs].join("\n");
    default: return view.parts.map((part) => part.text).join("\n");
  }
}

/** 一輪過程裡所有可搜尋的文字：過程回覆、工具摘要與展開內容、原本的過程卡內容。 */
export function processText(steps: readonly TranscriptMessage[], views: ReadonlyMap<string, StepView>): string {
  return steps.map((step) => {
    const view = views.get(step.id);
    if (view) return `${view.summary}\n${stepDetailText(view)}`;
    return step.parts ? step.parts.map((part) => part.text).join("\n") : step.text;
  }).join("\n");
}
