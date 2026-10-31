//! Capture only this experiment's WebView surface, including PDF pixels.
pub type Captures = std::sync::Arc<std::sync::Mutex<Vec<Result<std::path::PathBuf, String>>>>;
#[cfg(target_os = "windows")]
pub fn capture(view: &wry::WebView, path: std::path::PathBuf, completed: Captures) -> Result<(), Box<dyn std::error::Error>> {
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::{
        core::HSTRING,
        Win32::{System::Com::{STGC_DEFAULT, STGM_CREATE, STGM_READWRITE, STGM_SHARE_EXCLUSIVE},
            UI::Shell::SHCreateStreamOnFileEx},
    };
    use wry::WebViewExtWindows;
    // The stream is retained by the completion closure until CapturePreview finishes.
    let stream = unsafe { SHCreateStreamOnFileEx(&HSTRING::from(path.as_os_str()),
        (STGM_CREATE | STGM_READWRITE | STGM_SHARE_EXCLUSIVE).0, 0, true, None)? };
    let completed_stream = stream.clone();
    let callback = CapturePreviewCompletedHandler::create(Box::new(move |result| {
        // The wrapper already converts HRESULT into Result<(), Error>.
        let outcome = result.and_then(|_| unsafe { completed_stream.Commit(STGC_DEFAULT) });
        match outcome {
            Ok(()) => {
                println!("webview_capture={}", path.display());
                completed.lock().unwrap().push(Ok(path));
            }
            Err(error) => {
                eprintln!("WebView capture completion failed: {error}");
                completed.lock().unwrap().push(Err(error.to_string()));
            }
        }
        Ok(())
    }));
    unsafe { view.webview().CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
        &stream, &callback)?; }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn capture(_: &wry::WebView, _: std::path::PathBuf, _: Captures) -> Result<(), Box<dyn std::error::Error>> {
    Err("surface capture currently implemented for Windows only".into())
}
