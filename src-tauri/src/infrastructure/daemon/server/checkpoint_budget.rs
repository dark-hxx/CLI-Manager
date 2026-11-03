use std::sync::atomic::{AtomicUsize, Ordering};

pub(super) const CHECKPOINT_MEMORY_MAX_BYTES: usize = 128 * 1024 * 1024;

pub(super) struct CheckpointBudget {
    bytes: AtomicUsize,
    limit: usize,
}

impl CheckpointBudget {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            bytes: AtomicUsize::new(0),
            limit,
        }
    }

    // Reserve replacement bytes atomically across sessions; rejection leaves the old snapshot intact.
    pub(super) fn replace(&self, old: usize, new: usize) -> Result<(), String> {
        self.bytes
            .try_update(Ordering::AcqRel, Ordering::Acquire, |bytes| {
                bytes
                    .checked_sub(old)?
                    .checked_add(new)
                    .filter(|next| *next <= self.limit)
            })
            .map(|_| ())
            .map_err(|_| "checkpoint_memory_budget_exceeded".to_string())
    }

    pub(super) fn release(&self, bytes: usize) {
        self.bytes.fetch_sub(bytes, Ordering::AcqRel);
    }
}
