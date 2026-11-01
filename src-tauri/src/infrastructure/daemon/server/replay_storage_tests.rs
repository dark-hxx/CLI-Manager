use super::*;

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
