#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|arg| arg == "--smoke") {
        let fixture = args.iter().position(|a| a == "--fixture")
            .map(|i| args.get(i + 1).ok_or("missing fixture path")).transpose()?;
        let command = fixture.map(|path| {
            let path = std::path::PathBuf::from(path).canonicalize()?;
            if !path.is_file() { return Err("fixture must be a file".into()); }
            let path = path.to_str().ok_or("fixture path must be UTF-8")?;
            if path.contains(['\r', '\n', '"', '%']) { return Err("unsupported shell path character".into()); }
            Ok::<_, Box<dyn std::error::Error>>(format!("& cmd /d /c 'type \"{}\"'; Write-Output ('NATIVE_POC_' + 'DONE')\r", path.replace('\'', "''")))
        }).transpose()?;
        let mut frames = 0_u64;
        let mut bytes = 0_u64;
        let mut first = None;
        let mut last = None;
        let started = std::time::Instant::now();
        let result = poc_daemon::probe_with_nodelay(command.as_deref(), args.iter().any(|a| a == "--nodelay"), |frame| {
            first.get_or_insert_with(std::time::Instant::now);
            last = Some(std::time::Instant::now());
            frames += 1;
            bytes += frame.data.len() as u64;
        }).await;
        println!("transport_metrics={}", serde_json::json!({"frames":frames,"bytes":bytes,
            "receive_ms":first.zip(last).map(|(a,b)| (b-a).as_secs_f64()*1000.),
            "total_ms":started.elapsed().as_secs_f64()*1000.,"error":result.is_err(),
            "scope":"transport only; no parser or renderer"}));
        result
    } else {
        println!("poc-daemon: --smoke [--fixture PATH] [--nodelay]; POC_DAEMON_DISCOVERY optionally selects discovery JSON");
        Ok(())
    }
}
