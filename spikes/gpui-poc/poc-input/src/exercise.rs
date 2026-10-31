//! Real component edits/actions in an isolated window, not synthetic model tests.
use gpui::{App, Entity, Window};
use gpui_component::input::{EditorState, Redo, Undo};
use std::{sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};

pub fn schedule(editor: Entity<EditorState>, window: &Window, cx: &App, passed: Arc<AtomicBool>) {
    window.spawn(cx, async move |cx| {
        cx.background_executor().timer(Duration::from_millis(500)).await;
        let Ok(original) = cx.update(|window, cx| {
            editor.update(cx, |state, cx| {
                let original = state.value().to_string();
                let input = format!("{original}\n// POC_NEEDLE 中文🙂 POC_NEEDLE\n");
                // set_value deliberately clears history; search replacement is the sole edit.
                state.set_value(input, window, cx);
                state.focus(window, cx);
                original
            })
        }) else { return; };
        cx.background_executor().timer(Duration::from_millis(250)).await;
        let before = format!("{original}\n// POC_NEEDLE 中文🙂 POC_NEEDLE\n");
        let after = before.replace("POC_NEEDLE", "POC_REPLACED");
        let Ok(replaced) = cx.update(|window, cx| {
            editor.update(cx, |state, cx| {
                let start = Instant::now();
                state.set_search_query("POC_NEEDLE", false, cx);
                let count = state.replace_all_search_matches("POC_REPLACED", window, cx);
                let matches = count == 2 && state.value().as_ref() == after;
                state.close_search(cx);
                println!("editor_exercise: bytes={} replacements={count} search_replace_ms={:.3} exact={matches}",
                    before.len(), start.elapsed().as_secs_f64()*1000.);
                matches
            })
        }) else { return; };
        let Ok(()) = cx.update(|window, cx| window.dispatch_action(Box::new(Undo), cx)) else { return; };
        cx.background_executor().timer(Duration::from_millis(250)).await;
        let Ok(undone) = cx.update(|window, cx| {
            let exact = editor.read(cx).value().as_ref() == before;
            println!("editor_exercise: undo_exact={exact}");
            window.dispatch_action(Box::new(Redo), cx);
            exact
        }) else { return; };
        cx.background_executor().timer(Duration::from_millis(250)).await;
        let Ok(redone) = cx.update(|window, cx| {
            let exact = editor.read(cx).value().as_ref() == after;
            println!("editor_exercise: redo_exact={exact}; programmatic actions, not keyboard/IME acceptance");
            editor.update(cx, |state, cx| state.set_value(original, window, cx));
            exact
        }) else { return; };
        passed.store(replaced && undone && redone, Ordering::SeqCst);
    }).detach();
}
