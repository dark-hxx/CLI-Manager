//! Keep conversation and operation frames until the server confirms durable receipt.
use cli_manager_web_protocol::{DeviceToServerFrame, OperationStatus};
use std::collections::VecDeque;

#[derive(Default)]
pub(crate) struct WebDeviceOutbox {
    entries: VecDeque<(DeviceToServerFrame, bool)>,
    bytes: usize,
    sizes: VecDeque<usize>,
    last_terminal: Option<String>,
    selected: Option<usize>,
}

impl WebDeviceOutbox {
    pub fn push(&mut self, frame: DeviceToServerFrame) -> Result<(), String> {
        let urgent = matches!(&frame, DeviceToServerFrame::TerminalStatus { status, .. } if status == "error");
        if let DeviceToServerFrame::TerminalStatus { session_id, .. } = &frame {
            if urgent {
                // Retire stale queued states before prioritizing the error. An in-flight
                // state remains reserved and necessarily completes before this error.
                for index in (0..self.entries.len()).rev() {
                    if self.selected != Some(index)
                        && matches!(&self.entries[index].0,
                        DeviceToServerFrame::TerminalStatus { session_id: previous, .. } if previous == session_id)
                    {
                        self.entries.remove(index);
                        self.bytes -= self.sizes.remove(index).unwrap_or(0);
                        self.selected = self
                            .selected
                            .map(|selected| selected - usize::from(selected > index));
                    }
                }
            }
        }
        // Keep a small error lane so overload can be reported instead of looking frozen.
        if self.entries.len() >= if urgent { 256 } else { 248 } {
            return Err("web device send queue is full".into());
        }
        let bytes = serde_json::to_vec(&frame)
            .map_err(|err| err.to_string())?
            .len();
        if self.bytes.saturating_add(bytes) > 16 * 1024 * 1024 - if urgent { 0 } else { 64 * 1024 }
        {
            return Err("web device send queue byte limit reached".into());
        }
        self.bytes += bytes;
        if urgent {
            self.sizes.push_front(bytes);
            self.entries.push_front((frame, false));
            self.selected = self.selected.map(|index| index + 1);
        } else {
            self.sizes.push_back(bytes);
            self.entries.push_back((frame, false));
        }
        Ok(())
    }

    pub fn next(&mut self) -> Option<DeviceToServerFrame> {
        let index = self.selected.or_else(|| self.next_index())?;
        self.selected = Some(index);
        Some(self.entries[index].0.clone())
    }

    fn next_index(&self) -> Option<usize> {
        let first = self.entries.iter().position(|(_, sent)| !sent)?;
        if !matches!(
            &self.entries[first].0,
            DeviceToServerFrame::TerminalOutput { .. }
        ) {
            return Some(first);
        }
        // Rotate sessions only within the output run. Status/operation messages are
        // barriers, and the first queued frame of each session always stays first.
        for index in first..self.entries.len() {
            match &self.entries[index].0 {
                DeviceToServerFrame::TerminalOutput { session_id, .. }
                    if !self.entries[index].1 =>
                {
                    if self.last_terminal.as_ref() != Some(session_id) {
                        return Some(index);
                    }
                }
                _ => break,
            }
        }
        Some(first)
    }

    pub fn sent(&mut self) {
        let Some(index) = self.selected.take().or_else(|| self.next_index()) else {
            return;
        };
        if let DeviceToServerFrame::TerminalOutput { session_id, .. } = &self.entries[index].0 {
            self.last_terminal = Some(session_id.clone());
        }
        if matches!(
            self.entries[index].0,
            DeviceToServerFrame::ConversationEvent { .. }
                | DeviceToServerFrame::OperationAccepted { .. }
                | DeviceToServerFrame::OperationRunning { .. }
                | DeviceToServerFrame::OperationCompleted { .. }
        ) {
            self.entries[index].1 = true;
        } else {
            self.entries.remove(index);
            self.bytes -= self.sizes.remove(index).unwrap_or(0);
        }
    }

    pub fn reconnect(&mut self) {
        self.selected = None;
        for (_, sent) in &mut self.entries {
            *sent = false;
        }
    }

    pub fn acknowledge_event(&mut self, operation_id: &str, sequence: u64) {
        self.retain(|frame| {
            !matches!(frame,
            DeviceToServerFrame::ConversationEvent { event }
                if event.operation_id == operation_id && event.sequence == sequence)
        });
    }

    pub fn acknowledge_operation(&mut self, operation_id: &str, status: &OperationStatus) {
        self.retain(|frame| match frame {
            DeviceToServerFrame::OperationAccepted { operation_id: id } => {
                id != operation_id
                    || matches!(
                        status,
                        OperationStatus::Submitted | OperationStatus::WaitingDevice
                    )
            }
            DeviceToServerFrame::OperationRunning { operation_id: id } => {
                id != operation_id
                    || (!status.is_terminal() && !matches!(status, OperationStatus::Running))
            }
            DeviceToServerFrame::OperationCompleted {
                operation_id: id, ..
            } => id != operation_id || !status.is_terminal(),
            _ => true,
        });
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.sizes.clear();
        self.bytes = 0;
        self.last_terminal = None;
        self.selected = None;
    }

    fn retain(&mut self, mut keep: impl FnMut(&DeviceToServerFrame) -> bool) {
        for index in (0..self.entries.len()).rev() {
            if !keep(&self.entries[index].0) {
                self.selected = self.selected.and_then(|selected| {
                    if selected == index {
                        None
                    } else {
                        Some(selected - usize::from(selected > index))
                    }
                });
                self.entries.remove(index);
                self.bytes -= self.sizes.remove(index).unwrap_or(0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn output(session: &str, sequence: u64) -> DeviceToServerFrame {
        DeviceToServerFrame::TerminalOutput {
            session_id: session.into(),
            sequence,
            frames: vec![],
        }
    }

    #[test]
    fn terminal_sessions_rotate_without_reordering_or_crossing_status_barriers() {
        let mut queue = WebDeviceOutbox::default();
        for frame in [
            output("a", 1),
            output("a", 2),
            output("a", 3),
            output("b", 1),
            output("b", 2),
        ] {
            queue.push(frame).unwrap();
        }
        for (session, expected) in [("a", 1), ("b", 1), ("a", 2), ("b", 2), ("a", 3)] {
            assert!(
                matches!(queue.next(), Some(DeviceToServerFrame::TerminalOutput { session_id, sequence, .. }) if session_id == session && sequence == expected)
            );
            queue.sent();
        }
        queue.push(output("a", 4)).unwrap();
        queue
            .push(DeviceToServerFrame::Heartbeat { sequence: 1 })
            .unwrap();
        queue.push(output("b", 3)).unwrap();
        assert!(
            matches!(queue.next(), Some(DeviceToServerFrame::TerminalOutput { session_id, .. }) if session_id == "a")
        );
        queue.sent();
        assert!(matches!(
            queue.next(),
            Some(DeviceToServerFrame::Heartbeat { .. })
        ));
    }

    #[test]
    fn concurrent_enqueue_cannot_change_the_in_flight_selection() {
        let mut queue = WebDeviceOutbox::default();
        queue.push(output("a", 1)).unwrap();
        queue.sent();
        queue.push(output("a", 2)).unwrap();
        queue.next().unwrap();
        queue.push(output("b", 1)).unwrap();
        queue.sent();
        assert!(
            matches!(queue.next(), Some(DeviceToServerFrame::TerminalOutput { session_id, sequence: 1, .. }) if session_id == "b")
        );
    }

    #[test]
    fn byte_budget_is_released_after_send_and_clear() {
        let mut queue = WebDeviceOutbox::default();
        let frame = output(&"a".repeat(1024 * 1024), 1);
        for _ in 0..15 {
            queue.push(frame.clone()).unwrap();
        }
        assert!(queue.push(frame.clone()).is_err());
        queue.sent();
        queue.push(frame.clone()).unwrap();
        queue.clear();
        assert_eq!(queue.bytes, 0);
        assert!(queue.sizes.is_empty());
        queue.push(frame).unwrap();
    }

    #[test]
    fn full_output_queue_retains_a_priority_error_lane_without_losing_in_flight_frame() {
        let mut queue = WebDeviceOutbox::default();
        for sequence in 0..248 {
            queue.push(output("a", sequence)).unwrap();
        }
        assert!(queue.push(output("a", 249)).is_err());
        queue.next().unwrap();
        queue
            .push(DeviceToServerFrame::TerminalStatus {
                session_id: "a".into(),
                status: "error".into(),
                exit_code: None,
                control_mode: None,
            })
            .unwrap();
        queue.sent();
        assert!(
            matches!(queue.next(), Some(DeviceToServerFrame::TerminalStatus { status, .. }) if status == "error")
        );
        queue.sent();
        assert!(matches!(
            queue.next(),
            Some(DeviceToServerFrame::TerminalOutput { sequence: 1, .. })
        ));
    }

    #[test]
    fn priority_error_replaces_stale_running_but_preserves_new_recovery_status() {
        let mut queue = WebDeviceOutbox::default();
        let status = |value: &str| DeviceToServerFrame::TerminalStatus {
            session_id: "a".into(),
            status: value.into(),
            exit_code: None,
            control_mode: None,
        };
        queue.push(output("a", 1)).unwrap();
        queue.push(status("running")).unwrap();
        queue.push(status("error")).unwrap();
        queue.push(status("running")).unwrap();
        assert!(
            matches!(queue.next(), Some(DeviceToServerFrame::TerminalStatus { status, .. }) if status == "error")
        );
        queue.sent();
        queue.next().unwrap();
        queue.sent();
        assert!(
            matches!(queue.next(), Some(DeviceToServerFrame::TerminalStatus { status, .. }) if status == "running")
        );
        queue.sent();
        assert!(queue.next().is_none());
    }

    #[test]
    fn event_ack_only_removes_the_exact_committed_sequence() {
        let mut queue = WebDeviceOutbox::default();
        for sequence in [1, 2] {
            queue
                .push(DeviceToServerFrame::ConversationEvent {
                    event: cli_manager_web_protocol::ConversationEvent {
                        operation_id: "op".into(),
                        session_id: "session".into(),
                        source: "codex".into(),
                        project_id: "project".into(),
                        worktree_id: None,
                        sequence,
                        kind: "assistant_delta".into(),
                        message_id: Some("message".into()),
                        text: Some("text".into()),
                        occurred_at: 1,
                    },
                })
                .unwrap();
        }
        queue.sent();
        queue.sent();
        queue.acknowledge_event("op", 2);
        queue.reconnect();
        assert!(
            matches!(queue.next(), Some(DeviceToServerFrame::ConversationEvent { event }) if event.sequence == 1)
        );
        queue.acknowledge_event("op", 1);
        assert!(queue.next().is_none());
    }

    #[test]
    fn reconnect_replays_unacknowledged_states_in_order() {
        let mut queue = WebDeviceOutbox::default();
        queue
            .push(DeviceToServerFrame::OperationAccepted {
                operation_id: "op".into(),
            })
            .unwrap();
        queue
            .push(DeviceToServerFrame::OperationRunning {
                operation_id: "op".into(),
            })
            .unwrap();
        queue.sent();
        queue.sent();
        assert!(queue.next().is_none());
        queue.acknowledge_operation("op", &OperationStatus::Accepted);
        queue.reconnect();
        assert!(matches!(
            queue.next(),
            Some(DeviceToServerFrame::OperationRunning { .. })
        ));
        queue.acknowledge_operation("other", &OperationStatus::Succeeded);
        assert!(queue.next().is_some());
        queue.acknowledge_operation("op", &OperationStatus::Running);
        assert!(queue.next().is_none());
    }

    #[test]
    fn non_durable_frames_do_not_block_acknowledged_frames() {
        let mut queue = WebDeviceOutbox::default();
        queue
            .push(DeviceToServerFrame::OperationAccepted {
                operation_id: "op".into(),
            })
            .unwrap();
        queue
            .push(DeviceToServerFrame::Heartbeat { sequence: 1 })
            .unwrap();
        queue.sent();
        queue.sent();
        queue.reconnect();
        queue.sent();
        assert!(queue.next().is_none());
        queue.acknowledge_operation("op", &OperationStatus::Accepted);
        queue.reconnect();
        assert!(queue.next().is_none());
    }
}
