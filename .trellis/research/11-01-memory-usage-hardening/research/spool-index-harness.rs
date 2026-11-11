// Standalone synthetic regression harness for the production seek-hint module.
#[path = "../../../../src-tauri/src/infrastructure/daemon/server/spool_cursor_index.rs"]
mod index;

#[test]
fn seek_hint_allocation_is_counted_and_metadata_can_be_rebound() {
    let mut index = index::SpoolCursorIndex::default();
    index.append(1, 0, 16, None);
    assert!(index.resident_bytes() >= 16);
    index.set_modified(Some(std::time::SystemTime::UNIX_EPOCH));
    assert_eq!(index.seek_offset(1, 16, Some(std::time::SystemTime::UNIX_EPOCH)), 16);
}
