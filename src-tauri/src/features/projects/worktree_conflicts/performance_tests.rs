//! Opt-in real-Git scale evidence; never runs with the ordinary unit suite.
use super::{conflict_commands as commands, session_store::PAGE_SIZE, session_tests::Fixture, types::*};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{collections::BTreeSet, fs, path::Path, process::Command, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

#[derive(Serialize, Deserialize)]
struct Input { context: Context, snapshot: Snapshot }

/// Rust process RSS only, not Git child RSS or WebView2. Sampling overhead is included.
fn memory_sampler() -> (Arc<AtomicBool>, std::thread::JoinHandle<u64>) {
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    let thread = std::thread::spawn(move || {
        let pid = sysinfo::get_current_pid().unwrap();
        let mut system = sysinfo::System::new();
        let mut peak = 0;
        loop {
            system.refresh_processes(sysinfo::ProcessesToUpdate::Some(&[pid]), true);
            peak = peak.max(system.process(pid).map_or(0, |process| process.memory()));
            if signal.load(Ordering::Relaxed) { return peak; }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
    (stop, thread)
}

fn stats(values: impl Iterator<Item = f64>) -> Value {
    let mut values: Vec<_> = values.collect();
    values.sort_by(f64::total_cmp);
    let percentile = |p: f64| values[((values.len() as f64 * p).ceil() as usize).saturating_sub(1)];
    json!({ "samples": values.len(), "p50": percentile(0.5), "p95": percentile(0.95), "max": values.last() })
}

fn page(runtime: &tokio::runtime::Runtime, input: &Input, cursor: usize) -> Page {
    runtime.block_on(commands::git_worktree_conflict_status(input.context.clone(), input.snapshot.session_id.clone(),
        input.snapshot.list_snapshot_id.clone(), cursor, PAGE_SIZE)).unwrap()
}

fn sample(runtime: &tokio::runtime::Runtime, input: &Input) -> Value {
    let started = Instant::now();
    let first = page(runtime, input, 0);
    let first_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(first.snapshot.total, input.snapshot.total);
    assert_eq!(first.files.len(), PAGE_SIZE.min(input.snapshot.total));
    let started = Instant::now();
    let bytes = serde_json::to_vec(&first).unwrap().len();
    let serialize_ms = started.elapsed().as_secs_f64() * 1000.0;
    let mut other_pages = Vec::new();
    for cursor in [input.snapshot.total / 2 / PAGE_SIZE * PAGE_SIZE, (input.snapshot.total - 1) / PAGE_SIZE * PAGE_SIZE] {
        let started = Instant::now();
        let result = page(runtime, input, cursor);
        other_pages.push(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!(result.files.len(), PAGE_SIZE.min(input.snapshot.total - cursor));
    }
    let started = Instant::now();
    let detail = runtime.block_on(commands::git_worktree_conflict_file(input.context.clone(), input.snapshot.session_id.clone(),
        first.files[0].file_id.clone(), 1)).unwrap();
    let detail_ms = started.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(detail.detail.capability, "blocks");
    assert_eq!(detail.request_epoch, 1);
    json!({ "firstPageMs": first_ms, "middlePageMs": other_pages[0], "lastPageMs": other_pages[1],
        "firstPageJsonBytes": bytes, "serializeMs": serialize_ms, "detailMs": detail_ms })
}

#[test]
#[ignore = "child of native_scale_evidence; requires an isolated fixture manifest"]
fn native_scale_reader() {
    let Some(path) = std::env::var_os("CONFLICT_NATIVE_INPUT") else { return; };
    let input: Input = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
    let output = std::env::var_os("CONFLICT_NATIVE_OUTPUT").expect("child output path");
    let samples = std::env::var("CONFLICT_NATIVE_SAMPLES").unwrap().parse::<usize>().unwrap();
    assert!([1, 20].contains(&samples));
    let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).build().unwrap();
    if samples == 20 { sample(&runtime, &input); }
    let (stop, memory) = memory_sampler();
    let rows: Vec<_> = (0..samples).map(|_| sample(&runtime, &input)).collect();
    stop.store(true, Ordering::Relaxed);
    fs::write(output, serde_json::to_vec(&json!({ "rows": rows, "sampledPeakRustProcessBytes": memory.join().unwrap() })).unwrap()).unwrap();
}

fn child(input: &Path, output: &Path, samples: usize) -> Value {
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["native_scale_reader", "--ignored", "--test-threads=1"])
        .env("CONFLICT_NATIVE_INPUT", input).env("CONFLICT_NATIVE_OUTPUT", output)
        .env("CONFLICT_NATIVE_SAMPLES", samples.to_string()).output().unwrap();
    assert!(result.status.success(), "native reader failed: {} {}", String::from_utf8_lossy(&result.stdout), String::from_utf8_lossy(&result.stderr));
    serde_json::from_slice(&fs::read(output).unwrap()).unwrap()
}

#[test]
#[ignore = "creates 1k/10k/64887 conflicting files; opt in and provide a report path"]
fn native_scale_evidence() {
    let report = std::env::var_os("CONFLICT_NATIVE_REPORT").expect("set CONFLICT_NATIVE_REPORT to an evidence JSON path");
    assert!(!Path::new(&report).exists(), "use a new report path to preserve prior evidence");
    let counts: Vec<usize> = std::env::var("CONFLICT_NATIVE_COUNTS").unwrap_or_else(|_| "1000,10000,64887".into())
        .split(',').map(|count| count.trim().parse().expect("comma-separated fixture sizes")).collect();
    assert!(!counts.is_empty() && counts.iter().all(|count| [1_000, 10_000, 64_887].contains(count)));
    assert_eq!(counts.iter().collect::<BTreeSet<_>>().len(), counts.len(), "duplicate fixture size");
    let mut evidence = json!({ "scope": "real Git + registered Rust command handlers; not Tauri IPC/WebView2",
        "profile": if cfg!(debug_assertions) { "debug" } else { "release" },
        "coldDefinition": "five fresh Rust processes; OS cache not flushed; executable launch excluded",
        "preparationDefinition": "one real prepare per scale; setup excluded; not five cold prepare samples",
        "memoryDefinition": "50ms sampled Rust process RSS; excludes Git children and WebView2; sampling overhead included",
        "os": sysinfo::System::long_os_version(), "cpu": sysinfo::System::new_all().cpus().first().map(|cpu| cpu.brand().to_owned()),
        "git": String::from_utf8(Command::new("git").arg("--version").output().unwrap().stdout).unwrap().trim(), "groups": [] });
    for count in counts {
        eprintln!("preparing isolated native fixture with {count} conflicting files");
        let fixture = Fixture::new(count);
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(2).build().unwrap();
        let (stop, memory) = memory_sampler();
        let (head, base) = fixture.tips();
        let started = Instant::now();
        let snapshot = runtime.block_on(commands::git_worktree_prepare_conflicts(fixture.context(), head, base, "native-scale".into())).unwrap();
        let prepare_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(snapshot.total, count);
        let input = Input { context: fixture.context(), snapshot };
        let started = Instant::now();
        let first = page(&runtime, &input, 0);
        let initial_page_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(first.files.len(), PAGE_SIZE);
        stop.store(true, Ordering::Relaxed);
        let preparation_memory = memory.join().unwrap();
        let input_path = fixture.root.join("benchmark-input.json");
        let output_path = fixture.root.join("benchmark-output.json");
        fs::write(&input_path, serde_json::to_vec(&input).unwrap()).unwrap();
        let cold: Vec<_> = (0..5).map(|_| child(&input_path, &output_path, 1)).collect();
        let warm = child(&input_path, &output_path, 20);
        let mut summary = serde_json::Map::new();
        for metric in ["firstPageMs", "middlePageMs", "lastPageMs", "detailMs", "serializeMs"] {
            summary.insert(metric.into(), json!({ "cold": stats(cold.iter().map(|value| value["rows"][0][metric].as_f64().unwrap())),
                "warm": stats(warm["rows"].as_array().unwrap().iter().map(|value| value[metric].as_f64().unwrap())) }));
        }
        // Complete enumeration is validated outside the latency sample windows.
        let mut paths = BTreeSet::new();
        for cursor in (0..count).step_by(PAGE_SIZE) {
            for file in page(&runtime, &input, cursor).files { assert!(paths.insert(file.display_path)); }
        }
        assert_eq!(paths.len(), count);
        for index in 0..count { assert!(paths.contains(&format!("file-{index:04}.txt"))); }
        evidence["groups"].as_array_mut().unwrap().push(json!({ "count": count, "reachableFiles": paths.len(),
            "prepareMs": prepare_ms, "initialPageMs": initial_page_ms, "prepareThroughFirstPageMs": prepare_ms + initial_page_ms,
            "sampledPreparationPeakRustProcessBytes": preparation_memory, "cold": cold, "warm": warm, "summary": summary }));
        fs::write(&report, serde_json::to_vec_pretty(&evidence).unwrap()).unwrap();
        eprintln!("native conflicts={count}: prepare={prepare_ms:.1}ms first page={initial_page_ms:.1}ms; 5 process-cold/20 warm; complete enumeration");
    }
}
