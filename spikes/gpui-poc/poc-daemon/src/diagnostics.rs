//! Bounded transport diagnostics; never retain payloads, session IDs, or tokens.
use std::time::Instant;

#[derive(Default)]
pub(crate) struct Diagnostics {
    pub frames: u64,
    pub bytes: u64,
    pub control_frames: u64,
    pub ack_replies: u64,
    pub sequence_gaps: u64,
    pub non_increasing_sequences: u64,
    pub consume_ns: u128,
    pub ack_send_ns: u128,
    pub max_ack_send_ns: u128,
    previous: Option<Instant>,
    sequence: Option<u64>,
    // <1, <5, <10, <25, <50, <100, <1000, >=1000 ms.
    gaps: [u64; 8],
}

impl Diagnostics {
    pub fn output(&mut self, sequence: u64, bytes: usize) {
        let now = Instant::now();
        if let Some(previous) = self.previous {
            let ms = (now - previous).as_secs_f64() * 1000.;
            let bucket = [1., 5., 10., 25., 50., 100., 1000.]
                .iter().position(|limit| ms < *limit).unwrap_or(7);
            self.gaps[bucket] += 1;
        }
        if let Some(previous) = self.sequence {
            if sequence <= previous {
                self.non_increasing_sequences += 1;
            } else {
                self.sequence_gaps += sequence - previous - 1;
            }
        }
        self.previous = Some(now);
        self.sequence = Some(sequence);
        self.frames += 1;
        self.bytes += bytes as u64;
    }

    pub fn report(&self, failed: bool) {
        println!("transport_detail={}", serde_json::json!({
            "frames": self.frames, "bytes": self.bytes,
            "control_frames": self.control_frames, "ack_replies": self.ack_replies,
            "sequence_gaps": self.sequence_gaps,
            "non_increasing_sequences": self.non_increasing_sequences,
            "consume_ms": self.consume_ns as f64 / 1e6,
            "ack_send_ms": self.ack_send_ns as f64 / 1e6,
            "max_ack_send_ms": self.max_ack_send_ns as f64 / 1e6,
            "receive_gap_upper_bounds_ms": [1,5,10,25,50,100,1000],
            "receive_gap_histogram": self.gaps,
            "error": failed,
            "scope": "marker phase only; send time excludes remote ACK processing; sequence gaps may include reset/replay"
        }));
    }
}
