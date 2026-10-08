use super::*;

fn add_skill(path: &Path) {
    fs::create_dir_all(path).unwrap();
    fs::write(path.join("SKILL.md"), "---\nname: fixture\n---").unwrap();
}

fn deep_branch(root: &Path, directory_at_limit: bool) {
    let mut path = root.join("00-unrelated-cache");
    for depth in 2..=MAX_INVENTORY_DEPTH {
        path = path.join(format!("level-{depth}"));
    }
    fs::create_dir_all(&path).unwrap();
    if directory_at_limit {
        fs::create_dir(path.join("level-9")).unwrap();
    } else {
        fs::write(path.join("ordinary.txt"), "not a Skill").unwrap();
    }
}

fn scan_fixture(root: &Path) -> (Result<(), String>, Vec<InventoryEntry>) {
    let mut entries = Vec::new();
    let result = scan_local(
        root,
        ExtensionCli::Claude,
        "plugin",
        0,
        &mut BTreeSet::new(),
        &mut entries,
    );
    (result, entries)
}

#[test]
fn discovers_native_plugin_and_builtin_without_reading_skill_bodies() {
    let root = tempfile::tempdir().unwrap();
    for name in ["one", ".system/builtin", "vendor/plugin/skills/two"] {
        add_skill(&root.path().join(name));
    }
    let mut entries = Vec::new();
    scan_local(
        root.path(),
        ExtensionCli::Claude,
        "native",
        0,
        &mut BTreeSet::new(),
        &mut entries,
    )
    .unwrap();
    assert_eq!(entries.len(), 3);
    assert!(entries.iter().any(|e| e.source_kind == "builtin"));
    assert!(entries.iter().all(|e| e.import_path.is_some()));
}

#[test]
fn deep_ordinary_file_does_not_hide_shallow_skill_or_report_truncation() {
    let root = tempfile::tempdir().unwrap();
    deep_branch(root.path(), false);
    add_skill(&root.path().join("99-valid-skill"));
    let (result, entries) = scan_fixture(root.path());
    result.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "99-valid-skill");
}

#[test]
fn truncated_directory_preserves_siblings_and_partial_scan_warning() {
    let root = tempfile::tempdir().unwrap();
    deep_branch(root.path(), true);
    add_skill(&root.path().join("99-valid-skill"));
    let (result, entries) = scan_fixture(root.path());
    assert_eq!(result.unwrap_err(), "extensions_inventory_limit");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].name, "99-valid-skill");
}

#[test]
fn skill_at_depth_eight_is_discovered_but_depth_nine_is_not_traversed() {
    let root = tempfile::tempdir().unwrap();
    let mut allowed = root.path().join("allowed");
    let mut blocked = root.path().join("blocked");
    for depth in 2..=MAX_INVENTORY_DEPTH {
        allowed = allowed.join(format!("level-{depth}"));
        blocked = blocked.join(format!("level-{depth}"));
    }
    add_skill(&allowed);
    add_skill(&blocked.join("too-deep"));
    let (result, entries) = scan_fixture(root.path());
    assert_eq!(result.unwrap_err(), "extensions_inventory_limit");
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0].path, allowed.to_string_lossy());
}

#[test]
fn discovered_entries_remain_capped() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..=MAX_INVENTORY_ENTRIES {
        add_skill(&root.path().join(format!("skill-{index:04}")));
    }
    let (result, entries) = scan_fixture(root.path());
    assert_eq!(result.unwrap_err(), "extensions_inventory_limit");
    assert_eq!(entries.len(), MAX_INVENTORY_ENTRIES);
}

#[test]
fn examined_path_budget_stops_before_more_filesystem_work() {
    let root = tempfile::tempdir().unwrap();
    add_skill(&root.path().join("skill"));
    let mut visited = BTreeSet::new();
    let mut budget = ScanBudget {
        examined: MAX_INVENTORY_PATHS,
        depth_limited: false,
        visited: &mut visited,
    };
    let mut entries = Vec::new();
    let error = scan_local_bounded(
        root.path(),
        ExtensionCli::Claude,
        "plugin",
        0,
        &mut budget,
        &mut entries,
    )
    .unwrap_err();
    assert_eq!(error, "extensions_inventory_limit");
    assert!(entries.is_empty());
    assert_eq!(budget.examined, MAX_INVENTORY_PATHS);
}

#[test]
fn missing_root_is_not_a_scan_failure() {
    let root = tempfile::tempdir().unwrap();
    let (result, entries) = scan_fixture(&root.path().join("missing"));
    result.unwrap();
    assert!(entries.is_empty());
}

// 枚举后的候选路径可能已消失；不能因此中断同一预算中的其他兄弟。
#[test]
fn vanished_child_keeps_already_discovered_and_later_siblings() {
    let root = tempfile::tempdir().unwrap();
    add_skill(&root.path().join("before"));
    add_skill(&root.path().join("after"));
    let vanished = root.path().join("vanishing.txt");
    fs::write(&vanished, "fixture").unwrap();
    fs::remove_file(&vanished).unwrap();
    let mut visited = BTreeSet::new();
    let mut budget = ScanBudget {
        examined: 0,
        depth_limited: false,
        visited: &mut visited,
    };
    let mut entries = Vec::new();
    for path in [
        root.path().join("before"),
        vanished,
        root.path().join("after"),
    ] {
        scan_local_bounded(
            &path,
            ExtensionCli::Claude,
            "plugin",
            1,
            &mut budget,
            &mut entries,
        )
        .unwrap();
    }
    assert_eq!(entries.len(), 2);
    assert_eq!(budget.examined, 3);
}

// 预算恰好耗尽时保留最后一个允许处理的 Skill，不再窥探下一条目录项。
#[test]
fn exact_path_budget_retains_last_skill_and_reports_partial_scan() {
    let root = tempfile::tempdir().unwrap();
    add_skill(&root.path().join("skill"));
    let mut visited = BTreeSet::new();
    let mut budget = ScanBudget {
        examined: MAX_INVENTORY_PATHS - 2,
        depth_limited: false,
        visited: &mut visited,
    };
    let mut entries = Vec::new();
    let error = scan_local_bounded(
        root.path(),
        ExtensionCli::Claude,
        "plugin",
        0,
        &mut budget,
        &mut entries,
    )
    .unwrap_err();
    assert_eq!(error, "extensions_inventory_limit");
    assert_eq!(entries.len(), 1);
    assert_eq!(budget.examined, MAX_INVENTORY_PATHS);
}

#[test]
fn embedded_wsl_budgets_match_local_limits() {
    for (name, value) in [
        ("MAX_INVENTORY_DEPTH", MAX_INVENTORY_DEPTH),
        ("MAX_INVENTORY_ENTRIES", MAX_INVENTORY_ENTRIES),
        ("MAX_INVENTORY_PATHS", MAX_INVENTORY_PATHS),
    ] {
        assert!(WSL_SCAN.contains(&format!("{name} = {value}")));
    }
}

#[test]
fn partial_wsl_results_keep_entries_and_limit_status() {
    let inventory: WslInventory = serde_json::from_str(
        r#"{"entries":[{"cli":"claude","name":"fixture","path":"/fixture",
        "sourceKind":"plugin","status":"present","linkTarget":null,
        "importPath":"/fixture","managed":false}],"limited":true}"#,
    )
    .unwrap();
    assert!(inventory.limited);
    assert_eq!(inventory.entries.len(), 1);
}

#[cfg(unix)]
#[test]
fn directory_links_and_dangling_links_are_not_traversed() {
    let root = tempfile::tempdir().unwrap();
    std::os::unix::fs::symlink(root.path(), root.path().join("loop")).unwrap();
    std::os::unix::fs::symlink(root.path().join("missing"), root.path().join("dangling")).unwrap();
    let (result, entries) = scan_fixture(root.path());
    result.unwrap();
    assert_eq!(entries.len(), 2);
    assert!(entries.iter().any(|entry| entry.status == "missing"));
}
