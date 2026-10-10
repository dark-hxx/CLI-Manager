use super::*;
use serde_json::json;

const HOME: &str = r#"
# local state must survive
windows_wsl_setup_acknowledged = false
[hooks.state.local]
trusted_hash = "sha256:current"
enabled = false
[notice]
hide_full_access_warning = false
model_migrations = { old = "current" }
[tui]
status_line = []
model_availability_nux = { current = 2 }
[projects.'C:\repo']
trust_level = "untrusted"
[projects.'C:\home-only']
trust_level = "trusted"
"#;

#[test]
// 普通、内联与点路径来源都不能回放本机信任；运行选项和显式用户 profile 保留。
fn codex_source_state_is_filtered_before_merging_into_each_home() {
    for source in [
        r#"
windows_wsl_setup_acknowledged = true
[notice]
hide_full_access_warning = true
model_migrations = { old = "stale" }
[hooks.state.local]
trusted_hash = "sha256:stale"
enabled = true
[hooks.state.old]
trusted_hash = "sha256:foreign"
[hooks]
future_flag = false
[tui]
status_line = ['old']
model_availability_nux = { stale = 1 }
theme = 'user-theme'
[projects.'C:\repo']
trust_level = 'trusted'
custom = 7
[projects.'C:\foreign']
trust_level = 'trusted'
"#,
        r#"
windows_wsl_setup_acknowledged = true
notice = { hide_full_access_warning = true, model_migrations = { old = "stale" } }
hooks = { state = { local = { trusted_hash = 'sha256:stale', enabled = true }, old = { trusted_hash = 'sha256:foreign' } }, future_flag = false }
tui = { status_line = ['old'], model_availability_nux = { stale = 1 }, theme = 'user-theme' }
projects = { 'C:\repo' = { trust_level = 'trusted', custom = 7 }, 'C:\foreign' = { trust_level = 'trusted' } }
"#,
        r#"
windows_wsl_setup_acknowledged = true
notice.hide_full_access_warning = true
notice.model_migrations.old = 'stale'
hooks.state.local.trusted_hash = 'sha256:stale'
hooks.state.local.enabled = true
hooks.state.old.trusted_hash = 'sha256:foreign'
hooks.future_flag = false
tui.status_line = ['old']
tui.model_availability_nux.stale = 1
tui.theme = 'user-theme'
projects.'C:\repo'.trust_level = 'trusted'
projects.'C:\repo'.custom = 7
projects.'C:\foreign'.trust_level = 'trusted'
"#,
    ] {
        let source = format!("{source}\n[features]\nhooks = false\n[windows]\nsandbox = 'unelevated'\n[profiles.personal.tui]\nstatus_line = ['model']\n");
        let settings = json!({"config": source});
        for home in [None, Some(HOME.as_bytes()), Some(b"".as_slice())] {
            let (bytes, owned) = materialize_codex_config(home, &settings).unwrap();
            let actual: toml::Value = toml::from_str(std::str::from_utf8(&bytes).unwrap()).unwrap();
            if home == Some(HOME.as_bytes()) {
                let original: toml::Value = toml::from_str(HOME).unwrap();
                assert_eq!(actual["hooks"]["state"], original["hooks"]["state"]);
                assert_eq!(actual["notice"], original["notice"]);
                assert_eq!(actual["tui"]["status_line"], original["tui"]["status_line"]);
                assert_eq!(actual["tui"]["model_availability_nux"], original["tui"]["model_availability_nux"]);
                assert_eq!(actual["windows_wsl_setup_acknowledged"], original["windows_wsl_setup_acknowledged"]);
                assert_eq!(actual["projects"][r"C:\repo"]["trust_level"].as_str(), Some("untrusted"));
                assert_eq!(actual["projects"][r"C:\home-only"], original["projects"][r"C:\home-only"]);
            } else {
                assert!(actual["hooks"].get("state").is_none());
                assert!(actual.get("notice").is_none());
                assert!(actual.get("windows_wsl_setup_acknowledged").is_none());
                assert!(actual["tui"].get("status_line").is_none());
                assert!(actual["tui"].get("model_availability_nux").is_none());
                assert!(actual["projects"][r"C:\repo"].get("trust_level").is_none());
            }
            assert!(actual["projects"].get(r"C:\foreign").is_none());
            assert_eq!(actual["projects"][r"C:\repo"]["custom"].as_integer(), Some(7));
            assert_eq!(actual["hooks"]["future_flag"].as_bool(), Some(false));
            assert_eq!(actual["features"]["hooks"].as_bool(), Some(false));
            assert_eq!(actual["windows"]["sandbox"].as_str(), Some("unelevated"));
            assert_eq!(actual["tui"]["theme"].as_str(), Some("user-theme"));
            assert_eq!(actual["profiles"]["personal"]["tui"]["status_line"][0].as_str(), Some("model"));
            assert!(!owned.iter().any(|key| key == "notice" || key == "windows_wsl_setup_acknowledged"));
        }
    }
}

#[test]
// 只有来源状态的表不能留下空覆盖；清理幂等且不删 Hook 定义、偏好和未知字段。
fn codex_state_cleanup_is_idempotent_and_keeps_hook_definitions() {
    for source in [
        "[hooks.state.old]\ntrusted_hash='old'\n[tui]\nstatus_line=[]\nmodel_availability_nux={}\n[projects.old]\ntrust_level='trusted'\n[notice]\nmodel_migrations={}\n",
        "hooks={state={old={trusted_hash='old'}}}\ntui={status_line=[],model_availability_nux={}}\nprojects={old={trust_level='trusted'}}\nnotice={model_migrations={}}\n",
    ] {
        let mut doc = source.parse::<toml_edit::DocumentMut>().unwrap();
        assert!(remove_provider_home_state(&mut doc));
        assert!(doc.is_empty());
        assert!(!remove_provider_home_state(&mut doc));
    }
    let source = r#"
model_reasoning_effort = 'max'
service_tier = 'fast'
unknown_runtime_option = []
hooks = { PreToolUse = [{ matcher = '*', hooks = [{ type = 'command', command = 'user-hook' }] }] }
tui = { theme = 'theme', notifications = false, animations = false }
desktop = { followUpQueueMode = 'steer' }
"#;
    let mut doc = source.parse::<toml_edit::DocumentMut>().unwrap();
    assert!(!remove_provider_home_state(&mut doc));
    assert_eq!(doc.to_string(), source);
}

#[test]
// 公共配置与供应商双重污染也在实际 runtime 入口统一清理，原文仍可保存/编辑。
fn codex_common_and_provider_state_never_enters_generated_runtime() {
    let common = format!("{HOME}\n[features]\nhooks=true\n[mcp_servers.common]\ncommand='tool'\n");
    let supplier = json!({"base_url":"https://example.test/v1", "auth":{"OPENAI_API_KEY":"test-only"},
        "config":"service_tier='fast'\n[hooks.state.old]\ntrusted_hash='stale'\n[tui]\nmodel_availability_nux={old=1}\n"}).to_string();
    let merged = crate::provider::repository::merge_common_into_settings("codex", &common, &supplier).unwrap();
    assert!(merged.contains("trusted_hash"));
    for input in [&supplier, &merged] {
        for _ in 0..3 {
            let runtime = crate::provider::runtime::parse_runtime_config("test", input).unwrap();
            let actual: toml::Value = toml::from_str(&runtime.profile.profile_text).unwrap();
            assert!(actual.get("hooks").is_none());
            assert!(actual.get("notice").is_none());
            assert!(actual.get("projects").is_none());
            assert!(actual.get("tui").is_none());
            assert_eq!(actual["service_tier"].as_str(), Some("fast"));
            if input == &merged {
                assert_eq!(actual["features"]["hooks"].as_bool(), Some(true));
                assert_eq!(actual["mcp_servers"]["common"]["command"].as_str(), Some("tool"));
            }
            assert!(!runtime.profile.profile_text.contains("test-only"));
        }
    }
}
