use super::*;

fn failed_compaction_with_empty_memory() -> (tempfile::TempDir, SessionBuffer) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("session.bin");
    let mut buffer = SessionBuffer::with_spool(Some(path.clone()));
    buffer
        .accept_checkpoint(80, 24, 0, b"checkpoint".to_vec())
        .unwrap();
    let frames: Vec<_> = (1..=22)
        .map(|sequence| ReplayFrame {
            cols: 80,
            rows: 24,
            sequence,
            data: vec![b'x'; 512 * 1024],
        })
        .collect();
    buffer.write_spooled_frames(&frames).unwrap();
    // A directory at the replacement path fails compaction without relying on real disk exhaustion.
    std::fs::create_dir(path.with_extension("tmp")).unwrap();
    buffer.enforce_spool_cap();
    assert!(buffer.frames.is_empty());
    assert!(buffer.truncated);
    assert!(buffer.spool_failed);
    assert!(buffer.checkpoint.is_none());
    assert!(buffer.live_frames().is_empty());
    (dir, buffer)
}

#[test]
fn failed_spool_compaction_with_empty_memory_requires_attach_replay_reset() {
    use super::super::{
        ClientHandle, ClientTransport, ClientWriter, DaemonHost, DaemonServer, SessionEntry,
    };
    use crate::daemon::protocol::{DaemonFrame, SessionMeta};
    use std::collections::{HashMap, HashSet};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::AtomicU64;

    let (_dir, buffer) = failed_compaction_with_empty_memory();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let _peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
    let (stream, _) = listener.accept().unwrap();
    let session_id = "compaction-failure";
    let host = Arc::new(DaemonHost::new());
    host.sessions.lock().unwrap().insert(
        session_id.to_string(),
        Arc::new(Mutex::new(SessionEntry {
            meta: SessionMeta {
                session_id: session_id.to_string(),
                cwd: None,
                shell: None,
                environment_type: None,
                ssh_host_id: None,
                remote_path: None,
                alive: true,
                task_status: None,
                task_updated_at_ms: None,
                created_at_ms: 1,
                process_traits: None,
                replay_available: buffer.replay_available(),
                replay_truncated: buffer.truncated,
            },
            buffer,
            cols: 80,
            rows: 24,
            next_sequence: 23,
            ssh_hook_binding: None,
            hook_goal_key: None,
            hook_goal_status: None,
        })),
    );
    host.clients.lock().unwrap().insert(
        1,
        ClientHandle {
            writer: ClientWriter::new(ClientTransport::Ndjson(Mutex::new(stream))),
            attached: HashSet::new(),
            unacknowledged_chars: HashMap::new(),
            flow_control_paused: HashSet::new(),
            last_sent_sequence: HashMap::new(),
            last_acknowledged_sequence: HashMap::new(),
            attaching: HashMap::new(),
        },
    );
    let server = DaemonServer {
        host,
        next_client_id: AtomicU64::new(2),
        token: String::new(),
        version: String::new(),
        info_path: PathBuf::new(),
    };
    for cursor in [None, Some(0), Some(21), Some(22)] {
        match server.attach_session(1, 1, session_id.to_string(), cursor) {
            DaemonFrame::Attached {
                replay,
                replay_reset,
                replay_truncated,
                oldest_sequence,
                ..
            } => {
                assert!(replay.is_empty());
                assert!(replay_truncated);
                assert_eq!(replay_reset, cursor != Some(22));
                assert_eq!(oldest_sequence, 23);
            }
            other => panic!("unexpected attach reply: {other:?}"),
        }
    }
}

#[test]
fn failed_spool_compaction_recovers_disk_replay_after_successful_append() {
    let (dir, mut buffer) = failed_compaction_with_empty_memory();
    std::fs::remove_dir(dir.path().join("session.tmp")).unwrap();
    let data = vec![b'y'; 512 * 1024];
    for sequence in 23..=27 {
        buffer.push_output(80, 24, sequence, &data);
    }
    assert!(!buffer.spool_failed);
    assert!(buffer.truncated);
    assert_eq!(buffer.frames.front().unwrap().sequence, 24);
    let replay = buffer.live_frames_after(22, 1);
    assert_eq!(replay.len(), 1);
    assert_eq!(replay[0].sequence, 23);
    assert_eq!(replay[0].data, data);
    assert_eq!(buffer.live_frames().len(), 5);
}

#[cfg(windows)]
#[test]
fn failed_spool_compaction_marks_empty_unreadable_replay_as_truncated() {
    use std::os::windows::fs::OpenOptionsExt;

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("unreadable.bin");
    let mut file = File::create(&path).unwrap();
    let mut header = [0u8; 16];
    header[12..].copy_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_be_bytes());
    file.write_all(&header).unwrap();
    file.set_len(SESSION_SPOOL_MAX_BYTES as u64 + 1).unwrap();
    drop(file);
    // Denying delete sharing makes replacement fail even when unreadable frames yield an empty suffix.
    let lock = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(&path)
        .unwrap();
    let mut buffer = SessionBuffer::with_spool(Some(path));
    buffer.enforce_spool_cap();
    drop(lock);
    assert!(buffer.frames.is_empty());
    assert!(buffer.spool_failed);
    assert!(buffer.truncated);
}

#[test]
fn cursor_index_replay_matches_sequential_bytes_after_append_and_compaction() {
    let dir = tempfile::tempdir().unwrap();
    let mut buffer = SessionBuffer::with_spool(Some(dir.path().join("indexed.bin")));
    let frames: Vec<_> = (1..=600)
        .map(|sequence| ReplayFrame {
            cols: 80,
            rows: 24,
            sequence,
            data: vec![sequence as u8; 31],
        })
        .collect();
    buffer.write_spooled_frames(&frames).unwrap();
    for cursor in [0, 1, 128, 255, 599, 600] {
        let replay = buffer.live_frames_after(cursor, 150);
        let expected: Vec<_> = frames
            .iter()
            .filter(|f| f.sequence > cursor)
            .take(4)
            .map(|f| f.sequence)
            .collect();
        assert_eq!(
            replay.iter().map(|f| f.sequence).collect::<Vec<_>>(),
            expected
        );
        for frame in replay {
            assert_eq!(frame.data, vec![frame.sequence as u8; 31]);
        }
    }
    buffer.write_spooled_frames(&frames[400..]).unwrap();
    assert_eq!(buffer.live_frames_after(450, 1)[0].sequence, 451);
    let last = ReplayFrame {
        cols: 90,
        rows: 30,
        sequence: 601,
        data: b"suffix".to_vec(),
    };
    buffer.append_spooled_frame(&last).unwrap();
    let replay = buffer.live_frames_after(600, 1);
    assert_eq!(replay[0].data, b"suffix");
    assert_eq!(replay[0].cols, 90);
}

#[test]
fn unavailable_spool_keeps_a_bounded_tail_and_reports_truncation() {
    let mut buffer = SessionBuffer::new();
    let frame = vec![b'x'; 512 * 1024];
    for sequence in 1..=20 {
        buffer.push_output(80, 24, sequence, &frame);
    }
    assert!(buffer.total_bytes <= SESSION_BUFFER_MAX_BYTES);
    assert!(buffer.truncated);
    let replay = buffer.live_frames();
    assert_eq!(replay.last().unwrap().sequence, 20);
    assert_eq!(replay.first().unwrap().sequence, 17);
}

#[test]
fn checkpoint_budget_is_shared_and_rejection_preserves_the_previous_snapshot() {
    let budget = Arc::new(CheckpointBudget::new(8));
    let mut first = SessionBuffer::with_budget(None, Arc::clone(&budget));
    let mut second = SessionBuffer::with_budget(None, Arc::clone(&budget));
    let mut third = SessionBuffer::with_budget(None, Arc::clone(&budget));
    first.accept_checkpoint(80, 24, 1, b"one".to_vec()).unwrap();
    second
        .accept_checkpoint(80, 24, 1, b"two".to_vec())
        .unwrap();
    assert_eq!(
        third
            .accept_checkpoint(80, 24, 1, b"new".to_vec())
            .unwrap_err(),
        "checkpoint_memory_budget_exceeded"
    );
    assert!(first
        .accept_checkpoint(80, 24, 2, b"1234567".to_vec())
        .is_err());
    assert_eq!(first.checkpoint.as_ref().unwrap().data, b"one");
    drop(second);
    third.accept_checkpoint(80, 24, 2, b"new".to_vec()).unwrap();
    assert!(first.resident_bytes() >= 3);
}

#[test]
fn spool_fault_recovers_without_replaying_an_old_prefix_across_the_gap() {
    let dir = tempfile::tempdir().unwrap();
    let blocked = dir.path().join("blocked");
    std::fs::write(&blocked, b"not a directory").unwrap();
    let mut buffer = SessionBuffer::with_spool(Some(blocked.join("session.bin")));
    let data = vec![b'x'; 512 * 1024];
    for sequence in 1..=6 {
        buffer.push_output(80, 24, sequence, &data);
    }
    assert!(buffer.truncated);
    assert!(buffer.total_bytes <= SESSION_BUFFER_MAX_BYTES);
    std::fs::remove_file(&blocked).unwrap();
    for sequence in 7..=10 {
        buffer.push_output(80, 24, sequence, &data);
    }
    let frames = buffer.live_frames();
    assert_eq!(frames.first().unwrap().sequence, 3);
    assert_eq!(frames.last().unwrap().sequence, 10);
    let suffix = buffer.live_frames_after(7, 1);
    assert_eq!(suffix.len(), 1);
    assert_eq!(suffix[0].sequence, 8);
}

#[test]
fn spool_compaction_reclaims_a_batch_and_keeps_sequence_order() {
    let dir = tempfile::tempdir().unwrap();
    let mut buffer = SessionBuffer::with_spool(Some(dir.path().join("session.bin")));
    let frame = vec![b'x'; 512 * 1024];
    for sequence in 1..=25 {
        buffer.push_output(80, 24, sequence, &frame);
    }
    assert!(buffer.truncated);
    assert!(buffer.spool_bytes < SESSION_SPOOL_MAX_BYTES * 9 / 10);
    let frames = buffer.live_frames();
    assert_eq!(frames.last().unwrap().sequence, 25);
    assert!(frames
        .windows(2)
        .all(|pair| pair[1].sequence == pair[0].sequence + 1));
}
