mod classify;
#[cfg(target_os = "windows")]
mod platform;

use serde_json::{json, Value};
use std::{ffi::OsString, io::Write, path::PathBuf, time::Duration};

struct Options {
    probe: bool,
    loader: Option<PathBuf>,
    minimum_major: u32,
    hold_ms: u64,
}

fn parse_options() -> Result<Options, &'static str> {
    let mut options = Options {
        probe: false,
        loader: None,
        minimum_major: 1,
        hold_ms: 0,
    };
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--probe") => options.probe = true,
            Some("--loader") => {
                options.loader = Some(PathBuf::from(args.next().ok_or("missing_loader")?))
            }
            Some("--minimum-major") => {
                options.minimum_major = number(args.next())?
                    .try_into()
                    .map_err(|_| "invalid_minimum_major")?;
                if options.minimum_major == 0 {
                    return Err("invalid_minimum_major");
                }
            }
            Some("--hold-ms") => {
                options.hold_ms = number(args.next())?;
                if options.hold_ms > 10000 {
                    return Err("hold_ms_above_10000");
                }
            }
            _ => return Err("unknown_argument"),
        }
    }
    if options.probe && options.loader.is_none() {
        return Err("explicit_loader_required");
    }
    if !options.probe && options.loader.is_some() {
        return Err("loader_requires_probe");
    }
    Ok(options)
}

fn number(value: Option<OsString>) -> Result<u64, &'static str> {
    value
        .and_then(|s| s.to_str().and_then(|s| s.parse().ok()))
        .ok_or("invalid_number")
}

fn emit(value: Value) {
    println!("{value}");
    let _ = std::io::stdout().flush();
}

fn hold(milliseconds: u64) {
    std::thread::sleep(Duration::from_millis(milliseconds));
}

fn run() -> Result<(), &'static str> {
    let options = parse_options()?;
    #[cfg(target_os = "windows")]
    {
        let before = platform::loader_loaded();
        emit(json!({"event": "before_probe", "pid": std::process::id(),
            "loaderLoaded": before, "probeRequested": options.probe}));
        hold(options.hold_ms);
        if options.probe {
            let result = platform::probe(
                options.loader.as_ref().unwrap(),
                options.minimum_major,
                options.hold_ms,
            );
            emit(json!({"event": "result", "beforeLoaderLoaded": before,
                "afterLoaderLoaded": platform::loader_loaded(), "p8BeforePassed": !before,
                "registry": platform::registry_evidence(), "probe": result,
                "formalPerformance": false}));
        } else {
            emit(json!({"event": "result", "availability": "NotProbed",
                "afterLoaderLoaded": platform::loader_loaded()}));
        }
        hold(options.hold_ms);
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = options;
        emit(json!({"availability": "Unsupported", "platform": std::env::consts::OS}));
        Ok(())
    }
}

fn main() {
    if let Err(reason) = run() {
        emit(json!({"event": "argument_error", "reason": reason}));
        std::process::exit(2);
    }
}
