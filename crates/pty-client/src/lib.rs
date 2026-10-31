//! Native PtyHost transport. This crate never creates a PTY in the UI process.
pub mod frame;
pub mod session;
mod socket;

pub use socket::{Client, ConnectionOptions, Endpoint, Event};
