// CLI 自己寫下的對話紀錄（主機已正規化成事件），整理成對話視圖的時間軸。
// 只讀：顯示的內容全部來自 CLI 的紀錄檔，CLI-Manager 不產生任何訊息。
// 移植自 Tap-Code（web/src/transcript.ts），經作者同意以本倉庫授權釋出。

export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] };

/** CLI 目前的設定，取自 CLI 自己的紀錄欄位（只用到模型、思考強度與快速模式）。 */
export type CliStatus = { model?: string; effort?: string; speed?: string };

/**
 * 主機送來的事件，依 kind 區分。主機另外會送花費（cost）、審批模式（mode）等事件，
 * 這一版的對話視圖不顯示，buildTimeline 直接略過。
 */
export type TranscriptEvent =
  | { kind: "user"; uuid?: string; at?: number; text: string; images?: number }
  | { kind: "queued"; at?: number; text: string }
  | { kind: "command"; uuid?: string; at?: number; name: string; args?: string }
  /** text 是純文字；ansi 是同一段輸出保留了 SGR 顏色的版本（主機只留白名單內的序列），沒有樣式時省略。 */
  | { kind: "commandOutput"; uuid?: string; at?: number; text: string; ansi?: string }
  /** fast：這則回覆開了快速模式。 */
  | { kind: "assistant"; uuid?: string; at?: number; text: string; model?: string; fast?: boolean }
  | { kind: "thinking"; uuid?: string; at?: number; text?: string; ms?: number }
  | { kind: "tool"; uuid?: string; at?: number; id: string; name: string; summary: string; detail?: string }
  | {
    kind: "result"; uuid?: string; at?: number; id: string; ok: boolean; text?: string; diff?: Hunk[];
    added?: number; removed?: number; truncated?: boolean;
    /** 結果裡內嵌的圖片張數；這一版只顯示張數，不讀圖。 */
    images?: number;
  }
  | { kind: "task"; at?: number; op: "create" | "update"; id: string; subject?: string; status?: string }
  | { kind: "tasks"; at?: number; items: { id: string; subject: string; status: string }[] }
  | { kind: "title"; text: string }
  | { kind: "turn"; at?: number; ms: number; messages?: number }
  | { kind: "compact"; at?: number }
  | { kind: "error"; at?: number; text: string; retryInMs?: number; attempt?: number; max?: number }
  /**
   * code：主機用穩定代碼標出的通知（turn_interrupted、turn_replaced、turn_aborted），照介面語言顯示；
   * text 是英文後備文字或 CLI 自己寫的原文，沒有 code 或不認得的 code 時照原樣顯示。
   */
  | { kind: "notice"; at?: number; code?: string; text: string }
  | ({ kind: "status" } & CliStatus);

type ResultEvent = Extract<TranscriptEvent, { kind: "result" }>;

export type ToolStep = {
  type: "tool"; key: string; at?: number; id: string; name: string; summary: string; detail?: string; result?: ResultEvent;
};
export type Step = { type: "thinking"; key: string; at?: number; text: string; ms?: number } | ToolStep;

export type Item =
  /** images：這則訊息附的圖片張數（這一版只標張數）；queued：工作中插入當前回合的訊息。 */
  | { type: "user"; key: string; at?: number; text: string; images?: number; queued?: boolean }
  | { type: "command"; key: string; at?: number; name: string; args?: string }
  | { type: "output"; key: string; at?: number; text: string; ansi?: string }
  /** 這則回覆用的模型（API 的 id）、當時的思考強度、有沒有開快速模式：做完的一輪在摺疊列上標出來。 */
  | { type: "assistant"; key: string; at?: number; text: string; model?: string; effort?: string; fast?: boolean }
  | { type: "thought"; key: string; at?: number; text?: string; ms?: number }
  | { type: "steps"; key: string; at?: number; steps: Step[] }
  | { type: "plan"; key: string; at?: number; text: string; result?: ResultEvent }
  | {
    type: "turn"; key: string; at?: number; ms: number; text?: string;
    /** 這一輪回答的那則訊息（你的提問或斜杠命令）的 key；收尾列的「回到提问」捲到這裡。 */
    prompt?: string;
    /** 這一輪編輯檔案的增刪行數（對話紀錄裡的編輯）。 */
    added?: number; removed?: number;
  }
  | { type: "compact"; key: string; at?: number }
  | { type: "error"; key: string; at?: number; text: string; attempt?: number; max?: number }
  | { type: "notice"; key: string; at?: number; code?: string; text: string };

export type Task = { id: string; subject: string; status: string };

export type Timeline = {
  items: Item[];
  tasks: Task[];
  title?: string;
  status?: CliStatus;
  /** 最後一個還沒有結果的工具呼叫：CLI 正在執行它，或正等你批准。 */
  open?: ToolStep;
  /** 最近一次你送出訊息的時間，用來顯示這一輪已經工作多久。 */
  lastPromptAt?: number;
};

/** 做完的一輪裡收起來的過程（參考 Codex）：items[start, end) 收成一列「工作了 X」。 */
export type WorkFold = { key: string; start: number; end: number; ms?: number };

/** 步驟鏈裡的一列：一個步驟，或連續執行的幾條命令合成的一組。 */
export type StepEntry = { type: "step"; step: Step } | { type: "commands"; key: string; steps: ToolStep[]; count: number };

export const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** 算在「執行命令」裡的步驟：命令本身、查看背景命令的輸出、停止背景命令。 */
const COMMAND_STEPS = new Set(["Bash", "BashOutput", "KillShell"]);
/** 判斷時略過的項目：一輪結束後才出現的通知（例如背景工作完成）、收尾列、壓縮紀錄。 */
const PASSING = new Set<Item["type"]>(["turn", "notice", "compact"]);

export function buildTimeline(events: TranscriptEvent[]): Timeline {
  const items: Item[] = [];
  const tools = new Map<string, ToolStep | Extract<Item, { type: "plan" }>>();
  const tasks = new Map<string, Task>();
  const timeline: Timeline = { items, tasks: [] };
  let steps: Extract<Item, { type: "steps" }> | null = null;
  // 這一輪的回覆文字，一輪結束時交給收尾列複製。
  let reply: string[] = [];
  // 這一輪的提問：上一個收尾列之後最後一則你的訊息或斜杠命令（工作中插入的訊息不算，
  // 只有它時才退而用它）。中途被打斷、沒有收尾列的那一輪，由下一則訊息接手。
  let asked: string | undefined;
  let inserted: string | undefined;
  let index = 0;
  // 項目的 key 用紀錄行的 uuid（沒有時用時間），同一行出了幾項再加上是第幾項。不用流水號：
  // 往上讀進更早的內容時前面多了項目，後面的 key 不能跟著變，不然整段清單重建，
  // 展開的步驟收回去、畫面也跳。
  const used = new Map<string, number>();
  const key = (prefix: string, id?: string | number) => {
    const base = id !== undefined && id !== "" ? `${prefix}-${id}` : `${prefix}-#${index}`;
    index++;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count ? `${base}-${count}` : base;
  };
  const close = () => { steps = null; };
  for (const event of events) {
    switch (event.kind) {
      case "user": {
        close();
        reply = [];
        const item: Item = { type: "user", key: key("u", event.uuid), at: event.at, text: event.text, images: event.images };
        items.push(item);
        asked = item.key;
        timeline.lastPromptAt = event.at ?? timeline.lastPromptAt;
        break;
      }
      case "queued": {
        close();
        reply = [];
        const item = key("q", event.at);
        items.push({ type: "user", key: item, at: event.at, text: event.text, queued: true });
        inserted ??= item;
        timeline.lastPromptAt = event.at ?? timeline.lastPromptAt;
        break;
      }
      case "command": {
        close();
        const item = key("c", event.uuid);
        items.push({ type: "command", key: item, at: event.at, name: event.name, args: event.args });
        asked = item;
        break;
      }
      case "commandOutput":
        close();
        items.push({ type: "output", key: key("o", event.uuid), at: event.at, text: event.text, ansi: event.ansi });
        break;
      case "assistant":
        close();
        reply.push(event.text);
        items.push({
          type: "assistant", key: key("a", event.uuid), at: event.at, text: event.text,
          model: event.model ?? timeline.status?.model, effort: timeline.status?.effort, fast: event.fast || undefined,
        });
        break;
      case "thinking": {
        // Claude Code 預設不存思考內容，只留下思考時間。工具之間沒有內容的思考不列出；
        // 一段工作開頭的思考自成一行，有內容才能展開。
        if (steps) {
          if (event.text) steps.steps.push({ type: "thinking", key: key("t", event.uuid), at: event.at, text: event.text, ms: event.ms });
          break;
        }
        const last = items[items.length - 1];
        if (last?.type === "thought") {
          // 連續的思考併成一行。
          if (event.text) last.text = last.text ? `${last.text}\n\n${event.text}` : event.text;
          if (event.ms) last.ms = (last.ms ?? 0) + event.ms;
          break;
        }
        if (event.text || event.ms) items.push({ type: "thought", key: key("h", event.uuid), at: event.at, text: event.text, ms: event.ms });
        break;
      }
      case "tool": {
        if (event.name === "ExitPlanMode") {
          close();
          const plan: Extract<Item, { type: "plan" }> = { type: "plan", key: key("p", event.uuid), at: event.at, text: event.detail || "" };
          items.push(plan);
          tools.set(event.id, plan);
          break;
        }
        if (!steps) {
          steps = { type: "steps", key: key("s", event.uuid), at: event.at, steps: [] };
          items.push(steps);
        }
        const step: ToolStep = {
          type: "tool", key: key("k", event.id), at: event.at, id: event.id, name: event.name, summary: event.summary, detail: event.detail,
        };
        steps.steps.push(step);
        tools.set(event.id, step);
        break;
      }
      case "result": {
        const target = tools.get(event.id);
        if (target) target.result = event;
        break;
      }
      case "task":
        if (event.op === "create") tasks.set(event.id, { id: event.id, subject: event.subject || "", status: event.status || "pending" });
        else {
          const task = tasks.get(event.id);
          if (task) {
            if (event.status) task.status = event.status;
            if (event.subject) task.subject = event.subject;
          } else if (event.subject) tasks.set(event.id, { id: event.id, subject: event.subject, status: event.status || "pending" });
        }
        // 刪除的任務不再顯示。
        if (event.status === "deleted") tasks.delete(event.id);
        break;
      case "tasks":
        tasks.clear();
        for (const item of event.items) tasks.set(item.id, { ...item });
        break;
      case "title":
        timeline.title = event.text;
        break;
      case "turn":
        close();
        items.push({
          type: "turn", key: key("d", event.at), at: event.at, ms: event.ms,
          text: reply.length ? reply.join("\n\n") : undefined, prompt: asked ?? inserted,
        });
        reply = [];
        asked = inserted = undefined;
        break;
      case "compact":
        close();
        items.push({ type: "compact", key: key("x", event.at), at: event.at });
        break;
      case "error":
        close();
        items.push({ type: "error", key: key("e", event.at), at: event.at, text: event.text, attempt: event.attempt, max: event.max });
        break;
      case "notice":
        close();
        items.push({ type: "notice", key: key("n", event.at), at: event.at, code: event.code, text: event.text });
        break;
      case "status": {
        const { kind: _kind, ...status } = event;
        timeline.status = { ...timeline.status, ...status };
        break;
      }
    }
  }
  timeline.tasks = [...tasks.values()];
  // 最後一段步驟裡還沒有結果的工具，就是 CLI 目前卡住（執行中或等批准）的那一步。
  const last = items[items.length - 1];
  if (last?.type === "steps") {
    const open = [...last.steps].reverse().find((step): step is ToolStep => step.type === "tool" && !step.result);
    if (open) timeline.open = open;
  }
  // 每一輪的編輯增刪行數記在收尾列上（從上一個收尾列之後到這裡的編輯）。
  let added = 0;
  let removed = 0;
  for (const item of items) {
    if (item.type === "steps") {
      for (const step of item.steps) {
        if (step.type === "tool" && EDIT_TOOLS.has(step.name) && step.result?.ok) {
          added += step.result.added ?? 0;
          removed += step.result.removed ?? 0;
        }
      }
    }
    if (item.type === "turn") {
      if (added || removed) Object.assign(item, { added, removed });
      added = removed = 0;
    }
  }
  return timeline;
}

/**
 * 哪些項目開始新的一輪：斜杠命令，以及前面最後的內容不是工作（步驟、思考）的提問。
 * 夾在工作中間的訊息算在這一輪裡：中途插入的，以及 SDK 在工具結果後面直接送進來的一般訊息。
 */
function turnStarts(items: Item[]): number[] {
  const starts: number[] = [];
  items.forEach((item, index) => {
    if (item.type === "command") starts.push(index);
    if (item.type !== "user" || item.queued) return;
    let before = index - 1;
    while (before >= 0 && PASSING.has(items[before]!.type)) before--;
    const previous = items[before]?.type;
    if (previous !== "steps" && previous !== "thought") starts.push(index);
  });
  return starts;
}

/** 項目內容的簡短指紋：時間軸每次都整個重建，內容沒變的項目要沿用上一次的物件，畫面才不用整段重繪。 */
function signature(item: Item): string {
  switch (item.type) {
    case "steps":
      return item.steps.map((step) => step.type === "tool"
        ? [step.key, step.summary.length, step.detail?.length ?? 0, step.result
          ? `${step.result.ok ? 1 : 0}.${step.result.text?.length ?? 0}.${step.result.diff?.length ?? 0}.${step.result.images ?? 0}`
          : "-"].join(":")
        : `${step.key}:${step.text.length}:${step.ms ?? ""}`).join("|");
    case "turn":
      return [item.ms, item.added, item.removed, item.text?.length, item.prompt].join(":");
    case "thought":
      return `${item.text?.length ?? 0}:${item.ms ?? ""}`;
    case "user":
      return `${item.text.length}:${item.images ?? 0}:${item.queued ? 1 : 0}`;
    case "command":
      return `${item.name}:${item.args ?? ""}`;
    case "plan":
      return `${item.text.length}:${item.result ? (item.result.ok ? 1 : 0) : "-"}`;
    case "compact":
      return "";
    case "notice":
      return `${item.code ?? ""}:${item.text.length}`;
    case "assistant":
      return `${item.text.length}:${item.model ?? ""}:${item.effort ?? ""}:${item.fast ? 1 : 0}`;
    default:
      return `${item.text.length}`;
  }
}

export type KeptItems = Map<string, { item: Item; sig: string }>;

/**
 * 沿用上一次的項目物件：key 一樣、內容指紋也一樣的就用舊的那個，ChatItem 的 memo 才擋得住。
 * CLI 工作時每一兩秒多一則內容，不這樣做的話長對話每次都整段重繪（手機上一次近 100ms）。
 */
export function keepUnchanged(items: Item[], previous: ReadonlyMap<string, { item: Item; sig: string }>): { items: Item[]; cache: KeptItems } {
  const cache: KeptItems = new Map();
  const kept = items.map((item) => {
    const sig = signature(item);
    const old = previous.get(item.key);
    const same = old && old.sig === sig ? old.item : item;
    cache.set(item.key, { item: same, sig });
    return same;
  });
  return { items: kept, cache };
}

/** 中途插入的訊息（插入當前回合，或 SDK 在工具結果後面送進來的一般訊息），畫面上一樣標出來。 */
export function insertedKeys(items: Item[]): Set<string> {
  const starts = new Set(turnStarts(items));
  return new Set(items.flatMap((item, index) => item.type === "user" && (item.queued || !starts.has(index)) ? [item.key] : []));
}

/**
 * 做完的一輪只留最後的回答，你的提問之後的過程（思考、步驟、過程中說的話）收成一列。
 *
 * - 一輪是從你的提問到下一則提問之前。後面已經有新的提問，或 CLI 已經停下來（`live` 為假），
 *   才算做完；不靠收尾列，SDK 跑的對話不寫一輪結束的紀錄。
 * - 最後的回答是這一輪最後連續的幾則回覆文字（後面的通知、收尾列不算）。
 * - 沒有回答（中斷、斜杠命令的輸出）就不收。中途插入的訊息把過程分段，各段各自收起，
 *   你說的話留在外面。
 * - 長對話先只讀最後一頁，頁首可能落在某一輪中間：開頭到第一則提問之間也算一輪。
 */
export function workFolds(items: Item[], live = false): WorkFold[] {
  const folds: WorkFold[] = [];
  const starts = turnStarts(items);
  if (items.length && starts[0] !== 0) starts.unshift(-1);
  starts.forEach((prompt, turn) => {
    const next = starts[turn + 1];
    if (next === undefined && live) return;
    const start = prompt + 1;
    let tail = next ?? items.length;
    let footer: Extract<Item, { type: "turn" }> | undefined;
    while (tail > start && PASSING.has(items[tail - 1]!.type)) {
      const item = items[tail - 1]!;
      if (item.type === "turn") footer = item;
      tail--;
    }
    let answer = tail;
    while (answer > start && items[answer - 1]!.type === "assistant") answer--;
    if (answer === tail || answer === start) return;
    const chunks: [number, number][] = [];
    let from = start;
    for (let index = start; index <= answer; index++) {
      if (index < answer && items[index]!.type !== "user") continue;
      if (index > from) chunks.push([from, index]);
      from = index + 1;
    }
    for (const [from, to] of chunks) {
      // 用時：整輪只有一段而且有收尾列時用收尾列的；不然從這段之前的訊息算到下一則。
      // 頁首落在一輪中間時看不到開頭，算出來的時間會偏短，不寫。
      const began = from > 0 ? items[from - 1]?.at : undefined;
      const ended = items[to]?.at ?? items[to - 1]?.at;
      const ms = chunks.length === 1 && footer ? footer.ms
        : began !== undefined && ended !== undefined && ended > began ? ended - began : undefined;
      folds.push({ key: `work:${items[from]!.key}`, start: from, end: to, ms });
    }
  });
  return folds;
}

/**
 * 連續執行的命令合成一組（摺起來是「运行了 N 条命令」）：中間夾了別的步驟（讀檔、編輯、思考）
 * 就斷開，順序不變；至少兩條命令才合，只有一條時照常一列。組的 key 跟著第一個步驟，
 * 後面再加命令時展開狀態不變。
 */
export function groupCommands(steps: Step[]): StepEntry[] {
  const entries: StepEntry[] = [];
  let run: ToolStep[] = [];
  const flush = () => {
    const count = run.filter((step) => step.name === "Bash").length;
    if (count >= 2) entries.push({ type: "commands", key: `commands:${run[0]!.key}`, steps: run, count });
    else for (const step of run) entries.push({ type: "step", step });
    run = [];
  };
  for (const step of steps) {
    if (step.type === "tool" && COMMAND_STEPS.has(step.name)) run.push(step);
    else {
      flush();
      entries.push({ type: "step", step });
    }
  }
  flush();
  return entries;
}

/**
 * 長對話只畫最後一段時從哪一項開始畫：落在一段收起來的過程中間時，改從那一輪的提問開始，整輪一起畫。
 */
export function alignStart(items: Item[], folds: WorkFold[], index: number): number {
  let start = Math.max(0, Math.min(index, items.length - 1));
  const fold = folds.find((candidate) => candidate.start <= start && start < candidate.end);
  if (fold) start = fold.start;
  if (start > 0 && items[start - 1]?.type === "user" && items[start]?.type !== "user") start -= 1;
  return Math.max(0, start);
}

/** 工具步驟展開後才看得到的文字（命令、子代理的提示、結果、改動），搜尋時用來決定要不要展開。 */
export function detailText(step: ToolStep): string {
  const result = step.result;
  return [step.detail, result?.text, ...(result?.diff ?? []).flatMap((hunk) => hunk.lines.map((line) => line.slice(1)))]
    .filter(Boolean).join("\n");
}

/** 一段步驟裡所有可搜尋的文字：摘要、展開後的內容與思考。 */
export function stepsText(steps: Step[]): string {
  return steps.map((step) => step.type === "thinking" ? step.text : `${step.summary}\n${detailText(step)}`).join("\n");
}

/** 主機用穩定代碼標出的通知，對應介面文案的 key；不認得的代碼傳回 undefined（照原文顯示）。 */
const NOTICE_TEXT = { turn_interrupted: "noticeInterrupted", turn_replaced: "noticeReplaced", turn_aborted: "noticeAborted" } as const;
export type NoticeTextKey = (typeof NOTICE_TEXT)[keyof typeof NOTICE_TEXT];
export function noticeKey(code?: string): NoticeTextKey | undefined {
  return code && Object.hasOwn(NOTICE_TEXT, code) ? NOTICE_TEXT[code as keyof typeof NOTICE_TEXT] : undefined;
}

/**
 * 收起來的內容裡可以搜尋的字（命中時自動展開）。label 把有代碼的通知換成畫面上顯示的文字（照介面語言），
 * 沒有給時用原文。
 */
export function itemText(item: Item, label?: (key: NoticeTextKey) => string): string {
  switch (item.type) {
    case "steps": return stepsText(item.steps);
    case "thought": return item.text ?? "";
    case "notice": {
      const key = noticeKey(item.code);
      return key && label ? label(key) : item.text;
    }
    case "assistant": case "plan": case "output": case "error": return item.text;
    default: return "";
  }
}

// 思考強度照 CLI 的英文名稱（Codex 把 xhigh 叫 Extra high）。
export const EFFORT_LABELS: Record<string, string> = {
  auto: "Auto", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra",
};

const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
const CLAUDE = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:\[1m\])?$/i;
const CLAUDE_LEGACY = /^claude-(\d+)(?:-(\d))?-([a-z]+)(?:-\d{8})?(?:\[1m\])?$/i;

/**
 * 一輪摺疊列上的模型名稱：只要系列與版本（「Opus 5.5」），不標上下文大小與日期。
 * Codex 的模型名稱（gpt-5.5-codex 這種）本來就是這樣寫，照原樣；合成的（`<synthetic>`）不顯示。
 */
export function turnModel(id?: string | null): string | undefined {
  const raw = id?.trim();
  if (!raw || raw.startsWith("<")) return undefined;
  if (!raw.toLowerCase().startsWith("claude-")) return raw;
  const modern = CLAUDE.exec(raw);
  if (modern) return `${capital(modern[1]!)} ${modern[2]}${modern[3] ? `.${modern[3]}` : ""}`;
  const legacy = CLAUDE_LEGACY.exec(raw);
  if (legacy) return `${capital(legacy[3]!)} ${legacy[1]}${legacy[2] ? `.${legacy[2]}` : ""}`;
  const parts = raw.replace(/\[1m\]$/i, "").slice("claude-".length).split("-");
  const version = parts.slice(1).filter((part) => /^\d{1,2}$/.test(part)).join(".");
  return `${capital(parts[0] ?? raw)}${version ? ` ${version}` : ""}`;
}

/** 摺疊列與工作中膠囊上標的模型：「Opus 5.5」，思考強度與快速模式另外小字標出。 */
export type ModelUsed = { model: string; effort?: string; fast?: boolean };

/** 這一輪用的模型與思考強度：看最後的回答，沒有就看過程裡最後一則回覆。 */
export function foldModel(answer: Item | undefined, work: Item[]): ModelUsed | null {
  const reply = [answer, ...[...work].reverse()].find((item): item is Extract<Item, { type: "assistant" }> =>
    item?.type === "assistant" && Boolean(turnModel(item.model)));
  if (!reply) return null;
  return { model: turnModel(reply.model)!, effort: reply.effort ? EFFORT_LABELS[reply.effort] || reply.effort : undefined, fast: reply.fast };
}

/** 工作中那一列標的模型：照紀錄裡最新的狀態（模型、這一輪的思考強度、快速模式）。 */
export function statusModel(status?: CliStatus): ModelUsed | null {
  const model = turnModel(status?.model);
  if (!model) return null;
  return { model, effort: status?.effort ? EFFORT_LABELS[status.effort] || status.effort : undefined, fast: status?.speed === "fast" };
}
