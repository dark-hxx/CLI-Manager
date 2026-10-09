//! Worktree 冲突解决的协议与安全内核；命令接入在后端 Gate P1 通过后启用。
mod file_io;
pub(super) mod cleanup_guard;
pub(super) mod main_recovery;
mod parser;
pub mod recovery_commands;
mod types;
mod session_store;
mod session_files;
mod session_index;
mod session_write;
mod session_commit;
mod session_abort;
mod session_lifecycle;
mod session_capabilities;
mod session_prepare;
mod session_service;
pub mod conflict_commands;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod recovery_tests;
#[cfg(test)]
mod session_tests;
#[cfg(test)]
mod file_tests;
#[cfg(test)]
mod index_tests;
#[cfg(test)]
mod write_tests;
#[cfg(test)]
mod commit_tests;
#[cfg(test)]
mod abort_tests;
#[cfg(test)]
mod lifecycle_tests;
#[cfg(test)]
mod prepare_tests;
#[cfg(test)]
mod service_tests;
#[cfg(test)]
mod ordinary_write_tests;
#[cfg(test)]
mod performance_tests;
