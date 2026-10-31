//! File I/O and parser-only diagnostic; never interpreted as PTY/GPU throughput.
use crate::model::Model;
use std::{fs::File, io::Read, path::Path, time::Instant};

pub fn parse(path: &Path) -> Result<(), Box<dyn std::error::Error>> {
    let mut file = File::open(path)?;
    let mut model = Model::new();
    let mut buffer = [0_u8; 4096];
    let started = Instant::now();
    loop {
        let count = file.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        model.advance(&buffer[..count]);
    }
    println!(
        "offline_parser_metrics={}",
        serde_json::json!({
            "bytes":model.bytes,"allocator":crate::ALLOCATOR_NAME,"parse_ms":model.parse_ns as f64 / 1e6,
            "read_parse_ms":started.elapsed().as_secs_f64()*1000.,
            "cols":crate::model::COLS,"rows":crate::model::ROWS,
            "scope":"file read and parser only; no PTY, ACK, shaping or GPU presentation"
        })
    );
    Ok(())
}
