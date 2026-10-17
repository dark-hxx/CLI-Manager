//! 介面事件（`event_msg`）：提示詞、回覆、思考、用量、輪次、計畫，以及新版的完成項目
//! （`item_completed`）。

use super::{
    calls::{command_text, output_text, search},
    count, detail, error,
    images::strip_uploads,
    message, shell_tail,
    status::{epoch_ms, rate_limits},
    text_result, texts, uuid, Call, Parser, INJECTED,
};
use crate::{
    event::{
        ContextUsage, Event, TaskItem, AGENT_DETAIL, ASSISTANT_TEXT, NOTICE_TEXT, PROMPT_TEXT,
        RESULT_TEXT, THINKING_TEXT,
    },
    text::{join_output, keep_head, number, relative, strip_ansi, text_field},
};
use serde_json::Value;

impl Parser {
    /// 一則介面事件：依 `type` 分派。
    pub(super) fn event(&mut self, payload: &Value, at: Option<u64>, out: &mut Vec<Event>) {
        match payload["type"].as_str() {
            Some("item_completed") => self.item(&payload["item"], at, out),
            Some("user_message") => {
                // 舊版的注入訊息以 kind 標示（user_instructions、environment_context）。
                if payload["kind"].as_str().is_some_and(|kind| kind != "plain") {
                    return;
                }
                let images = count(&payload["images"]) + count(&payload["local_images"]);
                let text = payload["message"].as_str().unwrap_or_default();
                self.user(text, images, None, at, out);
            }
            Some("agent_message") => self.assistant(
                payload["message"].as_str().unwrap_or_default(),
                None,
                at,
                out,
            ),
            Some("agent_reasoning") => self.thinking(payload["text"].as_str(), None, at, out),
            Some("token_count") => self.usage(payload, at),
            Some("task_started") => {
                self.turn_started = at;
                self.prompted = false;
                if let Some(window) = number(&payload["model_context_window"]).filter(|&w| w > 0) {
                    self.status.context_window = Some(window);
                }
            }
            Some("task_complete") => self.complete(payload, at, out),
            Some("turn_aborted") => {
                self.turn_started = None;
                self.prompted = false;
                // 畫面上的文字由前端依代碼與介面語言決定；這裡的英文只是後備。
                let (code, text) = match payload["reason"].as_str() {
                    Some("replaced") => ("turn_replaced", "Turn replaced by a new request"),
                    Some("interrupted") | None => ("turn_interrupted", "Turn interrupted"),
                    Some(_) => ("turn_aborted", "Turn aborted"),
                };
                self.push(
                    out,
                    Event::Notice {
                        at,
                        code: Some(code.into()),
                        text: text.into(),
                    },
                );
            }
            Some("thread_settings_applied") => self.settings(&payload["thread_settings"]),
            Some("error" | "stream_error") => {
                if let Some(text) = message(&payload["message"]) {
                    self.push(out, error(at, &text));
                }
            }
            Some("warning") => {
                if let Some(text) = message(&payload["message"]) {
                    let text = keep_head(strip_ansi(&text).trim(), NOTICE_TEXT);
                    self.push(
                        out,
                        Event::Notice {
                            at,
                            code: None,
                            text,
                        },
                    );
                }
            }
            Some("context_compacted") => self.push(out, Event::Compact { at }),
            Some("plan_update") => self.plan(payload, at, out),
            Some("exec_command_begin") => {
                let id = payload["call_id"].as_str().unwrap_or_default();
                if self.fresh(id) {
                    let command = command_text(&payload["command"]);
                    self.shell_tool(out, at, id, &command);
                    self.remember(id, Call::Shell);
                }
            }
            Some("exec_command_end") => {
                let id = payload["call_id"].as_str().unwrap_or_default();
                if matches!(self.calls.get(id), Some(Call::Shell)) {
                    self.calls.remove(id);
                    let ok = payload["exit_code"].as_i64().is_none_or(|code| code == 0);
                    let output = payload["aggregated_output"]
                        .as_str()
                        .filter(|output| !output.is_empty())
                        .map(String::from)
                        .unwrap_or_else(|| {
                            join_output(
                                payload["stdout"].as_str().unwrap_or_default(),
                                payload["stderr"].as_str().unwrap_or_default(),
                            )
                        });
                    self.push(out, text_result(id, at, ok, &shell_tail(&output), false));
                }
            }
            Some("patch_apply_begin") => {
                let id = payload["call_id"].as_str().unwrap_or_default();
                let edits = self.changes(id, &payload["changes"]);
                let Some(edits) = self.refine(id, edits).filter(|_| self.fresh(id)) else {
                    return;
                };
                self.edit_tools(out, at, &edits);
                self.remember(id, Call::Patch(edits));
            }
            Some("patch_apply_end") => {
                let id = payload["call_id"].as_str().unwrap_or_default();
                if matches!(self.calls.get(id), Some(Call::Patch(_))) {
                    if let Some(Call::Patch(edits)) = self.calls.remove(id) {
                        let ok = payload["success"].as_bool() != Some(false);
                        let failure = join_output(
                            payload["stderr"].as_str().unwrap_or_default(),
                            payload["stdout"].as_str().unwrap_or_default(),
                        );
                        self.edit_results(out, at, &edits, ok, &failure);
                    }
                }
            }
            _ => {}
        }
    }

    /// 你的訊息；同一輪裡第二則起是工作中插入的話，改以排隊的訊息呈現。
    fn user(
        &mut self,
        text: &str,
        images: u32,
        uuid: Option<String>,
        at: Option<u64>,
        out: &mut Vec<Event>,
    ) {
        // 圖片（你貼的、上傳到 .tap-code/uploads/ 的）在對話裡顯示成縮圖：上傳的路徑不再留在文字裡，
        // uuid 用這一行的位置，前端照它讀圖（和 Claude Code 會話一樣）。
        let images = images.max(self.images);
        let stripped = strip_uploads(text);
        let text = stripped.trim();
        let uuid = if images > 0 {
            Some(format!("@{}", self.offset))
        } else {
            uuid
        };
        if INJECTED.iter().any(|prefix| text.starts_with(prefix))
            || (text.is_empty() && images == 0)
        {
            return;
        }
        // 這一輪已經有你的訊息：這是工作中插入的話（steer），不開新的一輪。
        if self.turn_started.is_some() && self.prompted {
            self.push(
                out,
                Event::Queued {
                    at,
                    text: keep_head(text, PROMPT_TEXT),
                },
            );
            return;
        }
        self.prompted = true;
        self.push(
            out,
            Event::User {
                uuid,
                at,
                text: keep_head(text, PROMPT_TEXT),
                images: (images > 0).then_some(images),
            },
        );
    }

    /// 模型回覆；模型取目前的設定。
    fn assistant(
        &mut self,
        text: &str,
        uuid: Option<String>,
        at: Option<u64>,
        out: &mut Vec<Event>,
    ) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        // 回覆裡有 Markdown 圖片（`![說明](路徑)`）：uuid 用這一行的位置，前端照它讀引用的圖檔。
        let uuid = if text.contains("![") {
            Some(format!("@{}", self.offset))
        } else {
            uuid
        };
        let model = self.status.model.clone();
        self.push(
            out,
            Event::Assistant {
                uuid,
                at,
                text: keep_head(text, ASSISTANT_TEXT),
                model,
                fast: false,
            },
        );
    }

    /// 思考摘要；沒有文字時仍送出一則空的思考，前端照樣顯示「思考過」。
    fn thinking(
        &mut self,
        text: Option<&str>,
        uuid: Option<String>,
        at: Option<u64>,
        out: &mut Vec<Event>,
    ) {
        let text = text
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(|text| keep_head(text, THINKING_TEXT));
        self.push(
            out,
            Event::Thinking {
                uuid,
                at,
                text,
                ms: None,
            },
        );
    }

    /// 上下文用量與方案額度。OpenAI 的輸入量已含快取命中；若提供者分開計算，補上快取的部分。
    fn usage(&mut self, payload: &Value, at: Option<u64>) {
        let info = &payload["info"];
        if let Some(window) = number(&info["model_context_window"]).filter(|&w| w > 0) {
            self.status.context_window = Some(window);
        }
        let last = &info["last_token_usage"];
        let input = number(&last["input_tokens"]).unwrap_or(0);
        let cached = number(&last["cached_input_tokens"]).unwrap_or(0);
        let tokens = if cached > input {
            input + cached
        } else {
            input
        };
        if tokens > 0 {
            self.status.context_tokens = Some(tokens);
            // OpenAI 不回報快取寫入；輸出已含推理 token。
            self.status.context_usage = Some(ContextUsage {
                input: tokens - cached,
                cache_read: cached,
                cache_write: 0,
                output: number(&last["output_tokens"]).unwrap_or(0),
            });
        }
        // 沒有帶額度的紀錄（API 金鑰、其他額度）不覆蓋已知的數值。
        let limits = rate_limits(&payload["rate_limits"], at);
        if !limits.is_empty() {
            self.status.limits = Some(limits);
        }
    }

    /// 一輪結束：錯誤與用時。新版寫入 `duration_ms`；舊版只能以開始與結束的時間推算。
    fn complete(&mut self, payload: &Value, at: Option<u64>, out: &mut Vec<Event>) {
        let failure = message(&payload["error"]["message"]).or_else(|| message(&payload["error"]));
        if let Some(text) = failure {
            self.push(out, error(at, &text));
        }
        let started = self.turn_started.take();
        self.prompted = false;
        let ms = number(&payload["duration_ms"])
            .or_else(|| {
                let start = epoch_ms(&payload["started_at"])?;
                epoch_ms(&payload["completed_at"])?.checked_sub(start)
            })
            .or_else(|| at?.checked_sub(started?));
        if let Some(ms) = ms {
            self.push(
                out,
                Event::Turn {
                    at,
                    ms,
                    messages: None,
                },
            );
        }
    }

    /// update_plan 的步驟清單；狀態與 Claude Code 的待辦相同（pending、in_progress、completed）。
    pub(super) fn plan(&mut self, input: &Value, at: Option<u64>, out: &mut Vec<Event>) {
        let Some(steps) = input["plan"].as_array() else {
            return;
        };
        let items = steps
            .iter()
            .enumerate()
            .filter_map(|(index, step)| {
                Some(TaskItem {
                    id: index.to_string(),
                    subject: text_field(step, "step")?,
                    status: text_field(step, "status"),
                })
            })
            .collect();
        self.push(out, Event::Tasks { at, items });
    }

    /// 新版的介面紀錄：每個完成的項目一行。
    fn item(&mut self, item: &Value, at: Option<u64>, out: &mut Vec<Event>) {
        let id = item["id"].as_str().unwrap_or_default();
        match item["type"].as_str() {
            Some("UserMessage") => {
                let mut texts = Vec::new();
                let mut images = 0;
                for part in item["content"].as_array().into_iter().flatten() {
                    match part["type"].as_str() {
                        Some("text" | "input_text") => texts.extend(part["text"].as_str()),
                        Some("image" | "local_image" | "input_image") => images += 1,
                        _ => {}
                    }
                }
                self.user(&texts.join("\n\n"), images, uuid(id), at, out);
            }
            Some("AgentMessage") => {
                let text = item["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n\n");
                self.assistant(&text, uuid(id), at, out);
            }
            Some("Reasoning") => {
                let parts = texts(&item["summary_text"]);
                if parts.is_empty() {
                    let raw = texts(&item["raw_content"]).join("\n\n");
                    self.thinking(Some(raw.as_str()), uuid(id), at, out);
                }
                for part in parts {
                    self.thinking(Some(part), uuid(id), at, out);
                }
            }
            // 計畫模式提出的計畫；之後沒有「確認」的紀錄，因此當成一般回覆呈現。
            Some("Plan") => {
                self.assistant(item["text"].as_str().unwrap_or_default(), uuid(id), at, out)
            }
            Some("ContextCompaction") => self.push(out, Event::Compact { at }),
            Some("CommandExecution") => {
                if !self.fresh(id) {
                    return;
                }
                self.shell_tool(out, at, id, &command_text(&item["command"]));
                let ok = item["status"]
                    .as_str()
                    .is_none_or(|status| status == "completed")
                    && item["exit_code"].as_i64().is_none_or(|code| code == 0);
                let output = item["aggregated_output"]
                    .as_str()
                    .filter(|output| !output.is_empty())
                    .map(String::from)
                    .unwrap_or_else(|| {
                        join_output(
                            item["stdout"].as_str().unwrap_or_default(),
                            item["stderr"].as_str().unwrap_or_default(),
                        )
                    });
                self.push(out, text_result(id, at, ok, &shell_tail(&output), false));
            }
            Some("FileChange") => {
                let edits = self.changes(id, &item["changes"]);
                let Some(edits) = self.refine(id, edits).filter(|_| self.fresh(id)) else {
                    return;
                };
                let ok = item["status"]
                    .as_str()
                    .is_none_or(|status| status == "completed");
                let failure = join_output(
                    item["stderr"].as_str().unwrap_or_default(),
                    item["stdout"].as_str().unwrap_or_default(),
                );
                self.edit_tools(out, at, &edits);
                self.edit_results(out, at, &edits, ok, &failure);
            }
            Some("McpToolCall") => {
                if !self.fresh(id) {
                    return;
                }
                let server = item["server"].as_str().unwrap_or_default();
                let tool = item["tool"].as_str().unwrap_or_default();
                self.tool(
                    out,
                    at,
                    id,
                    &format!("mcp__{server}__{tool}"),
                    &format!("{server} · {tool}"),
                    None,
                );
                let failure = message(&item["error"]["message"]);
                let ok = item["status"]
                    .as_str()
                    .is_none_or(|status| status == "completed")
                    && failure.is_none()
                    && item["result"]["isError"].as_bool() != Some(true);
                let text = failure.unwrap_or_else(|| output_text(&item["result"]["content"]).0);
                let text = keep_head(text.trim(), RESULT_TEXT);
                self.push(out, text_result(id, at, ok, &text, false));
            }
            Some("WebSearch") => {
                if !self.fresh(id) {
                    return;
                }
                let (name, summary) = search(&item["action"], item["query"].as_str());
                self.tool(out, at, id, name, &summary, None);
                self.push(out, text_result(id, at, true, "", false));
            }
            Some("ImageView") => {
                if !self.fresh(id) {
                    return;
                }
                let path = relative(
                    item["path"].as_str().unwrap_or_default(),
                    self.cwd.as_deref(),
                );
                self.tool(out, at, id, "Read", &path, None);
                let event = self.with_images(text_result(id, at, true, "", true));
                self.push(out, event);
            }
            Some("CollabAgentToolCall") if item["tool"].as_str() == Some("spawn_agent") => {
                if !self.fresh(id) {
                    return;
                }
                let agent = &item["receiver_agents"][0];
                let summary = text_field(agent, "agent_nickname")
                    .or_else(|| text_field(agent, "agent_role"))
                    .unwrap_or_default();
                let prompt = detail(item["prompt"].as_str().unwrap_or_default(), AGENT_DETAIL);
                self.tool(out, at, id, "Agent", &summary, prompt);
                let ok = item["status"]
                    .as_str()
                    .is_none_or(|status| status == "completed");
                self.push(out, text_result(id, at, ok, "", false));
            }
            _ => {}
        }
    }
}
