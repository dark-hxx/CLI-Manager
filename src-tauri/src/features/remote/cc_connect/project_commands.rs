use super::{
    config_path_value, remote_manager_dir, user_path_string, CcConnectAgent, CcConnectLanguage,
    CcConnectProfile, ManagedAlias, ManagedCommand, RegisteredProject, PROJECT_LIST_FILE_NAME,
    PROJECT_SWITCH_SCRIPT_FILE_NAME, REMOTE_SWITCH_ARG_PREFIX,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

pub(super) fn build_remote_project_commands(
    profile: &CcConnectProfile,
    project_list_path: &Path,
    project_switch_script_path: &Path,
) -> Result<(Vec<ManagedCommand>, Vec<ManagedAlias>), String> {
    let work_dir = config_path_value(&remote_manager_dir()?);
    let list_path = powershell_single_quoted(&user_path_string(project_list_path));
    let list_description = match profile.language {
        CcConnectLanguage::Zh => "列出 CLI-Manager 已登记项目",
        CcConnectLanguage::En => "List projects registered in CLI-Manager",
    };
    let list_exec = format!(
        "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding; \
         Get-Content -Raw -Encoding UTF8 -LiteralPath {list_path}; $null='{{{{0:}}}}'"
    );
    let switch_script = powershell_single_quoted(&user_path_string(project_switch_script_path));
    let switch_description = match profile.language {
        CcConnectLanguage::Zh => "按序号切换 CLI-Manager 项目，例如 /cli_manager_switch 2",
        CcConnectLanguage::En => {
            "Switch CLI-Manager project by number, for example /cli_manager_switch 2"
        }
    };
    // cc-connect v1.4.1 removes ASCII quote characters while tokenizing command
    // arguments. A single-quoted here-string therefore keeps newlines and every
    // remaining PowerShell metacharacter as data; its ASCII footer cannot be
    // supplied by the remote user. The pinned cc-connect hash protects this
    // parser contract until a newer version is reviewed explicitly.
    let switch_exec = format!(
        "$raw=@'\n{{{{args:}}}}\n'@\n\
         $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($raw))\n\
         powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
         -File {switch_script} $encoded"
    );
    Ok((
        vec![
            ManagedCommand {
                name: "cli_manager_list".to_string(),
                description: list_description.to_string(),
                exec: list_exec,
                work_dir: work_dir.clone(),
            },
            ManagedCommand {
                name: "cli_manager_switch".to_string(),
                description: switch_description.to_string(),
                exec: switch_exec,
                work_dir,
            },
        ],
        Vec::new(),
    ))
}

pub(super) fn powershell_single_quoted(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

pub(super) fn project_switch_token(project_id: &str) -> String {
    format!("{:x}", Sha256::digest(project_id.as_bytes()))[..32].to_string()
}

pub(super) fn project_list_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROJECT_LIST_FILE_NAME))
}

pub(super) fn project_switch_script_path() -> Result<PathBuf, String> {
    Ok(remote_manager_dir()?.join(PROJECT_SWITCH_SCRIPT_FILE_NAME))
}

pub(super) fn is_switch_identifier(value: &str) -> bool {
    value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

pub(super) fn switch_result_path(request_id: &str) -> Result<PathBuf, String> {
    if !is_switch_identifier(request_id) {
        return Err("invalid CLI-Manager project switch request ID".to_string());
    }
    Ok(remote_manager_dir()?.join(format!("switch-result-{request_id}.txt")))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RemoteSwitchRequest {
    pub(super) project_token: String,
    pub(super) request_id: String,
}

pub(super) fn remote_switch_request_from_args(args: &[String]) -> Option<RemoteSwitchRequest> {
    args.iter().find_map(|arg| {
        let payload = arg.strip_prefix(REMOTE_SWITCH_ARG_PREFIX)?;
        let (project_token, request_id) = payload.split_once(':').unwrap_or((payload, payload));
        Some(RemoteSwitchRequest {
            project_token: project_token.to_string(),
            request_id: request_id.to_string(),
        })
    })
}

pub(super) fn base64_utf8(value: &str) -> String {
    BASE64_STANDARD.encode(value.as_bytes())
}

pub(super) fn render_project_switch_script(
    profile: &CcConnectProfile,
    registered_projects: &[RegisteredProject],
    cli_manager_executable: &Path,
) -> Result<String, String> {
    let project_tokens = registered_projects
        .iter()
        .map(|project| format!("    '{}'", project_switch_token(&project.id)))
        .collect::<Vec<_>>()
        .join(",\n");
    let cli_manager = base64_utf8(&user_path_string(cli_manager_executable));
    let result_directory = base64_utf8(&user_path_string(&remote_manager_dir()?));
    let (invalid_message, range_message, timeout_message) = match profile.language {
        CcConnectLanguage::Zh => (
            "请输入有效的项目序号，例如 /cli_manager_switch 2。",
            "项目序号超出范围，请先发送 /cli_manager_list 查看可用项目。",
            "CLI-Manager 项目切换请求超时。",
        ),
        CcConnectLanguage::En => (
            "Enter a valid project number, for example /cli_manager_switch 2.",
            "The project number is out of range. Send /cli_manager_list to view available projects.",
            "The CLI-Manager project switch request timed out.",
        ),
    };
    let invalid_message = base64_utf8(invalid_message);
    let range_message = base64_utf8(range_message);
    let timeout_message = base64_utf8(timeout_message);
    Ok(format!(
        r#"$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding

function Decode-Base64Utf8([string]$Value) {{
    [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Value))
}}

$invalidMessage = Decode-Base64Utf8 '{invalid_message}'
$rangeMessage = Decode-Base64Utf8 '{range_message}'
$timeoutMessage = Decode-Base64Utf8 '{timeout_message}'

if ($args.Count -ne 1) {{
    Write-Output $invalidMessage
    exit 0
}}

$raw = ''
try {{
    $raw = Decode-Base64Utf8 $args[0]
}} catch {{
    Write-Output $invalidMessage
    exit 0
}}
if ($raw -notmatch '^[1-9][0-9]*$') {{
    Write-Output $invalidMessage
    exit 0
}}

$projectNumber = 0
if (-not [int]::TryParse($raw, [ref]$projectNumber)) {{
    Write-Output $invalidMessage
    exit 0
}}

$tokens = @(
{project_tokens}
)
if ($projectNumber -gt $tokens.Count) {{
    Write-Output $rangeMessage
    exit 0
}}

$cliManager = Decode-Base64Utf8 '{cli_manager}'
$resultDirectory = Decode-Base64Utf8 '{result_directory}'
$token = $tokens[$projectNumber - 1]
$request = [Guid]::NewGuid().ToString('N')
$result = Join-Path -Path $resultDirectory -ChildPath "switch-result-$request.txt"
$argument = "{REMOTE_SWITCH_ARG_PREFIX}" + $token + ':' + $request
Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $cliManager -ArgumentList $argument -Wait -WindowStyle Hidden | Out-Null
$deadline = (Get-Date).AddSeconds(10)
while (!(Test-Path -LiteralPath $result) -and (Get-Date) -lt $deadline) {{
    Start-Sleep -Milliseconds 100
}}
if (Test-Path -LiteralPath $result) {{
    try {{
        Get-Content -Raw -Encoding UTF8 -LiteralPath $result
    }} finally {{
        Remove-Item -LiteralPath $result -Force -ErrorAction SilentlyContinue
    }}
}} else {{
    Write-Output $timeoutMessage
}}
"#
    ))
}

pub(super) fn render_project_list(
    profile: &CcConnectProfile,
    registered_projects: &[RegisteredProject],
) -> String {
    let current_summary = registered_projects
        .iter()
        .find(|project| profile.runtime_project_id.as_deref() == Some(project.id.as_str()))
        .map(|project| project_summary(profile.language, project))
        .unwrap_or_else(|| match profile.language {
            CcConnectLanguage::Zh => "等待宠物选择托管会话".to_string(),
            CcConnectLanguage::En => "waiting for a desktop-pet handoff".to_string(),
        });
    let mut output = match profile.language {
        CcConnectLanguage::Zh => format!("CLI-Manager 项目（当前：{current_summary}）"),
        CcConnectLanguage::En => format!("CLI-Manager projects (current: {current_summary})"),
    };
    if registered_projects.is_empty() {
        output.push_str(match profile.language {
            CcConnectLanguage::Zh => "\n暂无已登记项目。",
            CcConnectLanguage::En => "\nNo registered projects.",
        });
        return output;
    }

    let mut previous_group_ids = Vec::<String>::new();
    let mut ungrouped_header_rendered = false;
    for (index, project) in registered_projects.iter().enumerate() {
        let item_depth = if project.group_path.is_empty() {
            previous_group_ids.clear();
            if !ungrouped_header_rendered {
                output.push_str(match profile.language {
                    CcConnectLanguage::Zh => "\n📁 未分组",
                    CcConnectLanguage::En => "\n📁 Ungrouped",
                });
                ungrouped_header_rendered = true;
            }
            1
        } else {
            let common_depth = project
                .group_path
                .iter()
                .zip(&previous_group_ids)
                .take_while(|(group, previous_id)| group.id == **previous_id)
                .count();
            for (offset, group) in project.group_path[common_depth..].iter().enumerate() {
                let depth = common_depth + offset;
                output.push_str(&format!(
                    "\n{}📁 {}",
                    "  ".repeat(depth),
                    single_line(&group.name)
                ));
            }
            previous_group_ids = project
                .group_path
                .iter()
                .map(|group| group.id.clone())
                .collect();
            project.group_path.len()
        };
        let current = profile.runtime_project_id.as_deref() == Some(project.id.as_str());
        let unavailable = !Path::new(&project.path).is_dir();
        let state = match (profile.language, current, unavailable) {
            (CcConnectLanguage::Zh, true, false) => " [当前]",
            (CcConnectLanguage::Zh, _, true) => " [路径不可用]",
            (CcConnectLanguage::En, true, false) => " [current]",
            (CcConnectLanguage::En, _, true) => " [path unavailable]",
            _ => "",
        };
        let item_indent = "  ".repeat(item_depth);
        let detail_indent = format!("{item_indent}   ");
        let path_label = match profile.language {
            CcConnectLanguage::Zh => "路径：",
            CcConnectLanguage::En => "Path: ",
        };
        output.push_str(&format!(
            "\n{item_indent}{}. {}{}\n{detail_indent}{} · {}\n{detail_indent}{path_label}{}",
            index + 1,
            single_line(&project.name),
            state,
            agent_display_name(project.agent),
            provider_display_value(profile.language, project),
            single_line(&user_path_string(Path::new(&project.path)))
        ));
    }
    output.push_str(match profile.language {
        CcConnectLanguage::Zh => "\n\n切换项目：/cli_manager_switch <序号>",
        CcConnectLanguage::En => "\n\nSwitch project: /cli_manager_switch <number>",
    });
    output
}

pub(super) fn agent_display_name(agent: CcConnectAgent) -> &'static str {
    match agent {
        CcConnectAgent::Claude => "Claude Code",
        CcConnectAgent::Codex => "Codex",
        CcConnectAgent::Pi => "Pi",
        CcConnectAgent::Opencode => "OpenCode",
    }
}

pub(super) fn provider_display_value(
    language: CcConnectLanguage,
    project: &RegisteredProject,
) -> String {
    if matches!(project.agent, CcConnectAgent::Pi | CcConnectAgent::Opencode) {
        return match (language, project.agent) {
            (CcConnectLanguage::Zh, CcConnectAgent::Pi) => "Provider：跟随 Pi 配置".to_string(),
            (CcConnectLanguage::En, CcConnectAgent::Pi) => {
                "Provider: follow Pi configuration".to_string()
            }
            (CcConnectLanguage::Zh, CcConnectAgent::Opencode) => {
                "Provider：跟随 OpenCode 配置".to_string()
            }
            (CcConnectLanguage::En, CcConnectAgent::Opencode) => {
                "Provider: follow OpenCode configuration".to_string()
            }
            _ => unreachable!(),
        };
    }
    let provider_name = project.provider_name.as_deref().map(single_line);
    match (language, project.provider_is_global, provider_name) {
        (CcConnectLanguage::Zh, true, Some(name)) => format!("Provider：{name}（全局）"),
        (CcConnectLanguage::Zh, true, None) => "Provider：跟随全局".to_string(),
        (CcConnectLanguage::Zh, false, Some(name)) => format!("Provider：{name}"),
        (CcConnectLanguage::Zh, false, None) => "Provider：项目指定".to_string(),
        (CcConnectLanguage::En, true, Some(name)) => format!("Provider: {name} (global)"),
        (CcConnectLanguage::En, true, None) => "Provider: follow global".to_string(),
        (CcConnectLanguage::En, false, Some(name)) => format!("Provider: {name}"),
        (CcConnectLanguage::En, false, None) => "Provider: project override".to_string(),
    }
}

pub(super) fn project_summary(language: CcConnectLanguage, project: &RegisteredProject) -> String {
    format!(
        "{} · {} · {}",
        single_line(&project.name),
        agent_display_name(project.agent),
        provider_display_value(language, project)
    )
}

pub(super) fn single_line(value: &str) -> String {
    value.replace(['\r', '\n'], " ").trim().to_string()
}
