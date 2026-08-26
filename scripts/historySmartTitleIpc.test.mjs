import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const storeSource = readFileSync(
  new URL("../src/stores/historyStore.ts", import.meta.url),
  "utf8",
);
const commandSource = readFileSync(
  new URL("../src-tauri/src/commands/history_title.rs", import.meta.url),
  "utf8",
);
const settingsSource = readFileSync(
  new URL("../src/stores/settingsStore.ts", import.meta.url),
  "utf8",
);
const settingsPageSource = readFileSync(
  new URL("../src/components/settings/pages/HistorySourceSettingsPage.tsx", import.meta.url),
  "utf8",
);
const historyWorkspaceSource = readFileSync(
  new URL("../src/components/HistoryWorkspace.tsx", import.meta.url),
  "utf8",
);
const historyListPaneSource = readFileSync(
  new URL("../src/components/history/HistoryListPane.tsx", import.meta.url),
  "utf8",
);
const sessionDetailPaneSource = readFileSync(
  new URL("../src/components/history/SessionDetailPane.tsx", import.meta.url),
  "utf8",
);

function sourceBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing start marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test("smart-title IPC sends the Rust struct argument under request", () => {
  const generate = sourceBlock(storeSource, "generateSmartTitle: async", "clearSmartTitle: async");
  const clear = sourceBlock(storeSource, "clearSmartTitle: async", "updateMessage: async");

  assert.match(commandSource, /pub\(crate\) async fn history_title_generate\(\s*request: HistoryTitleGenerateRequest,/);
  assert.match(commandSource, /fn history_title_clear\(\s*request: HistoryTitleClearRequest,/);
  assert.match(generate, /invoke<unknown>\("history_title_generate", \{\s*request: \{/);
  assert.match(clear, /invoke<unknown>\("history_title_clear", \{\s*request: \{/);
});

test("smart-title generation yields the IPC handler while the Provider request is pending", () => {
  const command = sourceBlock(
    commandSource,
    "#[tauri::command]\npub(crate) async fn history_title_generate",
    "async fn history_title_generate_async",
  );

  assert.match(
    command,
    /tauri::async_runtime::spawn_blocking\(move \|\| \{\s*tauri::async_runtime::block_on\(history_title_generate_async\(request\)\)/,
  );
});

test("smart-title generation exposes an immediate in-flight loading state", () => {
  const generate = sourceBlock(storeSource, "generateSmartTitle: async", "clearSmartTitle: async");

  assert.match(storeSource, /smartTitleInFlightSessionKeys: new Set\(\)/);
  assert.match(
    generate,
    /smartTitleInFlightSessionKeys: new Set\(state\.smartTitleInFlightSessionKeys\)\.add\(sessionKey\)/,
  );
  assert.match(generate, /smartTitleInFlightSessionKeys\.delete\(sessionKey\)/);
  assert.match(
    historyWorkspaceSource,
    /smartTitleInFlightSessionKeys=\{smartTitleInFlightSessionKeys\}/,
  );
  assert.match(
    historyListPaneSource,
    /smartTitleInFlightSessionKeys\.has\(row\.item\.sessionKey\)/,
  );
  assert.match(
    sessionDetailPaneSource,
    /const smartTitleGenerationPending = smartTitlePending \|\| activeView\.generatedTitle\?\.state === "pending";/,
  );
  assert.match(
    sessionDetailPaneSource,
    /disabled=\{loadingSessionDetail \|\| !activeSession \|\| smartTitleGenerationPending\}/,
  );
  assert.match(sessionDetailPaneSource, /<LoaderCircle size=\{12\} className="animate-spin" \/>/);
});

test("smart-title custom prompts stay backend-owned and retain the built-in fallback", () => {
  const generate = sourceBlock(storeSource, "generateSmartTitle: async", "clearSmartTitle: async");
  const request = sourceBlock(
    commandSource,
    "pub(crate) struct HistoryTitleGenerateRequest",
    "pub(crate) struct HistoryTitleClearRequest",
  );

  assert.match(settingsSource, /HISTORY_SMART_TITLE_CUSTOM_PROMPT_MAX_BYTES = 4096/);
  assert.match(settingsSource, /customPrompt: ""/);
  assert.match(settingsSource, /customPrompt: migrateHistorySmartTitleCustomPrompt\(raw\.customPrompt\)/);
  assert.match(settingsPageSource, /<Textarea/);
  assert.match(settingsPageSource, /handleSaveTitlePrompt/);
  assert.match(settingsPageSource, /handleRestoreDefaultTitlePrompt/);
  const savePrompt = sourceBlock(
    settingsPageSource,
    "const handleSaveTitlePrompt = async",
    "const handleRestoreDefaultTitlePrompt = async",
  );
  const persistPrompt = sourceBlock(
    settingsPageSource,
    "const persistTitlePrompt = async",
    "const handleSaveTitlePrompt = async",
  );
  assert.match(persistPrompt, /await updateSetting\("historySmartTitle",/);
  assert.match(savePrompt, /await persistTitlePrompt\(titlePromptValue, "save"\)/);
  assert.match(savePrompt, /toast\.success\(t\("historySources\.smartTitle\.customPromptSaved"\)\)/);
  assert.match(settingsPageSource, /historySources\.smartTitle\.customPromptRestored/);
  assert.match(commandSource, /let custom_prompt =\s*normalize_custom_prompt\(settings\.get\("customPrompt"\)/);
  assert.match(commandSource, /fn effective_prompt\(selection: Option<&HistoryTitleSettingsSelection>\)/);
  assert.match(commandSource, /async fn request_title\(\s*runtime: &ProviderRuntime,\s*system_prompt: &str,/);
  assert.match(commandSource, /&runtime\.model_id,\s*system_prompt,\s*candidate,/);
  assert.doesNotMatch(generate, /customPrompt/);
  assert.doesNotMatch(request, /prompt/i);
});

test("smart-title persistence waits for shared-database writers and reports busy safely", () => {
  const errorHandler = sourceBlock(
    historyWorkspaceSource,
    "const handleSmartTitleError = useCallback",
    "const handleGenerateSmartTitle = useCallback",
  );

  assert.match(commandSource, /HISTORY_TITLE_DATABASE_BUSY_TIMEOUT: Duration = Duration::from_secs\(15\)/);
  assert.ok((commandSource.match(/\.begin_with\("BEGIN IMMEDIATE"\)/g) ?? []).length >= 2);
  assert.match(commandSource, /"history_title_database_busy"/);
  assert.match(errorHandler, /code\.includes\("history_title_database_busy"\)/);
  assert.match(errorHandler, /history\.toast\.smartTitleDatabaseBusy/);
});
