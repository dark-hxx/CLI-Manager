use super::*;

fn link_directory(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        if std::os::windows::fs::symlink_dir(target, link).is_ok() {
            return;
        }
        // Junctions also exercise directory links when symlink privilege is unavailable.
        let output = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link.to_string_lossy().replace('/', "\\"))
            .arg(target.to_string_lossy().replace('/', "\\"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    }
}

fn skill(path: &Path, name: &str) {
    fs::create_dir_all(path).unwrap();
    fs::write(path.join("SKILL.md"), format!("---\nname: {name}\ndescription: fixture\n---\n")).unwrap();
}

#[test]
fn codex_custom_home_discovers_linked_skills_without_looping() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("project");
    let config = temp.path().join("custom-codex");
    let target = temp.path().join("packages/review");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(cwd.join(".git")).unwrap();
    fs::create_dir_all(config.join("skills")).unwrap();
    skill(&target, "review");
    link_directory(&target, &config.join("skills/review"));
    link_directory(&target, &target.join("cycle"));

    let layout = discovery_layout(AgentKind::Codex, &home, &cwd, Some(&config));
    let bundle = collect_local_bundle(&layout);
    assert_eq!(bundle.skills.len(), 1);
    assert!(bundle.skills[0].path_label.ends_with("skills/review/SKILL.md"));
    let snapshot = assemble_snapshot(request(), bundle);
    assert_eq!(snapshot.skill_summary.available, 1);
    assert_eq!(snapshot.skills[0].name, "review");
}

#[test]
fn codex_project_worktree_skill_links_are_discovered() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("worktree");
    fs::create_dir_all(cwd.join(".agents/skills")).unwrap();
    fs::write(cwd.join(".git"), "gitdir: ../main/.git/worktrees/test").unwrap();
    let target = temp.path().join("packages/build");
    skill(&target, "build");
    link_directory(&target, &cwd.join(".agents/skills/build"));
    let bundle = collect_local_bundle(&discovery_layout(AgentKind::Codex, &home, &cwd, None));
    assert_eq!(bundle.skills.len(), 1);
    assert_eq!(bundle.skills[0].scope, "project");
}

#[test]
fn other_agents_keep_directory_link_exclusion() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("project");
    let config = temp.path().join("claude");
    fs::create_dir_all(cwd.join(".git")).unwrap();
    fs::create_dir_all(config.join("skills")).unwrap();
    let target = temp.path().join("packages/review");
    skill(&target, "review");
    link_directory(&target, &config.join("skills/review"));
    let bundle = collect_local_bundle(&discovery_layout(AgentKind::Claude, &home, &cwd, Some(&config)));
    assert!(bundle.skills.is_empty());
}

#[cfg(windows)]
#[test]
fn codex_windows_junctions_are_discovered() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("project");
    let config = temp.path().join("codex");
    fs::create_dir_all(cwd.join(".git")).unwrap();
    fs::create_dir_all(config.join("skills")).unwrap();
    let target = temp.path().join("packages/review");
    skill(&target, "review");
    let output = std::process::Command::new("cmd").args(["/C", "mklink", "/J"])
        .arg(config.join("skills/review").to_string_lossy().replace('/', "\\"))
        .arg(target.to_string_lossy().replace('/', "\\"))
        .output().unwrap();
    assert!(output.status.success());
    let codex = collect_local_bundle(&discovery_layout(AgentKind::Codex, &home, &cwd, Some(&config)));
    assert_eq!(codex.skills.len(), 1);
}

#[test]
fn linked_skill_manifests_retain_the_read_byte_limit() {
    let temp = tempfile::tempdir().unwrap();
    let home = temp.path().join("home");
    let cwd = temp.path().join("project");
    let config = temp.path().join("codex");
    fs::create_dir_all(cwd.join(".git")).unwrap();
    fs::create_dir_all(config.join("skills")).unwrap();
    let target = temp.path().join("packages/large");
    skill(&target, "large");
    fs::write(target.join("SKILL.md"), vec![b'a'; MAX_SKILL_BYTES as usize + 1]).unwrap();
    link_directory(&target, &config.join("skills/large"));
    let bundle = collect_local_bundle(&discovery_layout(AgentKind::Codex, &home, &cwd, Some(&config)));
    assert_eq!(bundle.skills.len(), 1);
    assert_eq!(bundle.skills[0].content, "__CLI_MANAGER_ERROR__:source_invalid");
    assert_eq!(assemble_snapshot(request(), bundle).skill_summary.invalid, 1);
}

fn request() -> InspectRequest {
    InspectRequest {
        terminal_session_id: "pty".into(), cli_session_id: "cli".into(), agent: AgentKind::Codex,
        environment: EnvironmentKind::Local, cwd: "fixture".into(), config_root: None, launch_args: String::new(),
        baseline_config_fingerprint: None, runtime_evidence: Vec::new(),
    }
}
