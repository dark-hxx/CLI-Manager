import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { SubagentTranscriptView } from "../../src/features/terminal/components/SubagentTranscriptView";
import { useTerminalStore } from "../../src/features/terminal/state";
import { useSettingsStore } from "../../src/shared/preferences/settingsStore";
import { SubagentPanel } from "../../apps/web/src/SubagentPanel";
import { translate } from "../../apps/web/src/i18n";
import { buildWebSubagentSnapshots } from "../../src/shared/lib/webSubagentSnapshot";

const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
const header = { type: "session_meta", payload: { timestamp: "2026-11-03T12:00:00Z",
  source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } } } };
const task = { type: "event_msg", payload: { type: "task_started",
  turn_attribution: { turn_id: "child-turn", parent_turn_id: "parent-turn" } } };
const message = (role: string, text: string, extra = {}) => ({ type: "response_item", timestamp: "2026-11-03T12:05:00Z", payload: {
  type: "message", role, content: [{ type: "text", text }],
  internal_chat_message_metadata_passthrough: { turn_id: "child-turn" }, ...extra,
} });
let content = jsonl(header, task, message("developer", "HIDDEN_INSTRUCTIONS"),
  message("user", "请检查项目的边界条件。\n\nReview the **validation logic**, preserve existing behavior."),
  { type: "response_item", payload: { type: "function_call", name: "Read", arguments: "TOOL_SECRET" } },
  message("assistant", "已核对输入验证与异常处理。\n\nValidation is complete.\n\n- No execution changes\n- Read-only review", { phase: "final_answer" }),
  message("user", "LONG_TASK " + "Long task detail. ".repeat(160) + " END_OF_TASK"));
let seq = 0;
const sessions = ["child", "other"].map(id => ({ id, title: id === "child" ? "Reviewer" : "Other agent",
  kind: "subagent-transcript", subagent: { parentSessionId: "parent" } }));
function publish() {
  useTerminalStore.setState({ subagentTranscripts: {
    child: { content, resetSeq: seq, ended: false, source: { kind: "child-jsonl" } },
    other: { content: jsonl(message("assistant", "OTHER_CHILD")), resetSeq: 0, ended: true, source: { kind: "child-jsonl" } },
  } });
}
publish();
useSettingsStore.setState({ language: "en-US", resolvedTheme: "dark", terminalThemeName: "auto", terminalPreviewThemeName: "follow-terminal" });
function Harness() {
  const [language, setLanguage] = useState<"zh-CN" | "en-US">("en-US");
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const [visible, setVisible] = useState(true);
  const [id, setId] = useState("child");
  const transcripts = useTerminalStore(s => s.subagentTranscripts);
  const agents = buildWebSubagentSnapshots(sessions, transcripts, new Set(["parent"]));
  return <div style={{ padding: 12, color: theme === "dark" ? "#d5d8dc" : "#20242a", background: theme === "dark" ? "#11161c" : "#fafafa" }}>
    <nav style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
      <button id="language" onClick={() => {
        const next = language === "en-US" ? "zh-CN" : "en-US";
        setLanguage(next); useSettingsStore.setState({ language: next });
      }}>Language</button>
      <button id="theme" onClick={() => {
        const next = theme === "dark" ? "light" : "dark";
        setTheme(next); document.documentElement.dataset.theme = next;
        useSettingsStore.setState({ resolvedTheme: next });
      }}>Theme</button>
      <button id="hide" onClick={() => setVisible(!visible)}>Visibility</button>
      <button id="switch" onClick={() => setId(id === "child" ? "other" : "child")}>Switch</button>
      <button id="append" onClick={() => { content += jsonl(message("assistant", "APPENDED_REPLY")); publish(); }}>Append</button>
      <button id="reset" onClick={() => { seq++; content = jsonl(message("user", "RESET_MESSAGE")); publish(); }}>Reset</button>
      <button id="v2" onClick={() => {
        seq++;
        content = jsonl({ ...header, payload: { ...header.payload, agent_path: "/root/reviewer" } },
          { type: "session_meta", payload: { source: "cli", timestamp: "2026-11-01T00:00:00Z" } }, task,
          { type: "response_item", timestamp: "2026-11-03T12:05:00Z", payload: {
            type: "agent_message", author: "/root", recipient: "/root/reviewer", content: [
              { type: "input_text", text: "Message Type: NEW_TASK\nTask name: /root/reviewer\nSender: /root\nPayload:\n" },
              { type: "encrypted_content", encrypted_content: "SYNTHETIC_CIPHER" },
            ], internal_chat_message_metadata_passthrough: { turn_id: "child-turn" },
          } }, message("assistant", "V2_FINAL_REPLY", { phase: "final_answer" }));
        publish();
      }}>V2</button>
      <button id="v2-follow" onClick={() => {
        content += jsonl({ type: "response_item", timestamp: "2026-11-03T12:06:00Z", payload: {
          type: "agent_message", author: "/root", recipient: "/root/reviewer", content: [
            { type: "input_text", text: "Message Type: MESSAGE\nTask name: /root/reviewer\nSender: /root\nPayload:\nV2_FOLLOW_TASK" },
          ], internal_chat_message_metadata_passthrough: { turn_id: "child-turn" },
        } }, message("assistant", "V2_FOLLOW_REPLY"));
        publish();
      }}>V2 follow-up</button>
      <button id="many" onClick={() => {
        for (let i = 0; i < 330; i++) content += jsonl(message("assistant", `ROW_${i} ` + "content ".repeat(25)));
        publish();
      }}>Many</button>
    </nav>
    <main style={{ display: "flex", flexWrap: "wrap", gap: 16, marginTop: 12 }}>
      <div id="desktop" style={{ flex: "1 1 320px", height: 550, minWidth: 0 }}>
        <SubagentTranscriptView sessionId={id} isVisible={visible} />
      </div>
      <div id="web" style={{ flex: "1 1 320px", height: 550, minWidth: 0, display: "flex" }}>
        <SubagentPanel agents={agents} active={visible} t={key => translate(language, key)} />
      </div>
    </main>
  </div>;
}
document.documentElement.dataset.theme = "dark";
createRoot(document.getElementById("root")!).render(<Harness />);
