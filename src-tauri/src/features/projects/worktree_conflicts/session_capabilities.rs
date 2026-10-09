//! 保守分类不运行相似度搜索、不加载 blob；不能证明独立的路径交由外部工具。
use std::collections::{BTreeMap, BTreeSet};
use git2::{Delta, Oid, Repository};
use super::types::*;

/// Windows 同名及父目录大小写别名均不可作为两个独立的写入白名单。
fn case_aliases(index: &IndexState) -> BTreeSet<String> {
    let mut prefixes: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for path in index.keys() {
        let mut prefix = String::new();
        for part in path.split('/') {
            if !prefix.is_empty() { prefix.push('/'); }
            prefix.push_str(part);
            prefixes.entry(prefix.to_lowercase()).or_default().insert(prefix.clone());
        }
    }
    let aliases: BTreeSet<_> = prefixes.into_iter().filter(|(_, values)| values.len() > 1).map(|(key, _)| key).collect();
    index.keys().filter(|path| {
        let mut prefix = String::new();
        path.split('/').any(|part| {
            if !prefix.is_empty() { prefix.push('/'); }
            prefix.push_str(&part.to_lowercase());
            aliases.contains(&prefix)
        })
    }).cloned().collect()
}

/// 删除与新增/修改共存可能是 rename 或覆盖目标；宁可降级，不将组拆成独立删除。
/// 仅单路径删除的 modify/delete 仍支持整取存在侧或显式删除缺失侧。
pub fn classify(repo: &Repository, head: &str, base: &str, index: &IndexState) -> Result<BTreeMap<String, String>> {
    let mut reasons: BTreeMap<_, _> = case_aliases(index).into_iter().map(|path| (path, "case_collision".into())).collect();
    let head = Oid::from_str(head)?; let base = Oid::from_str(base)?;
    let ancestors = repo.merge_bases(head, base)?;
    if ancestors.len() != 1 {
        for (path, stages) in index {
            if stages.iter().any(|stage| stage.stage != 0) { reasons.entry(path.clone()).or_insert_with(|| "complex_merge_base".into()); }
        }
        return Ok(reasons);
    }
    let ancestor = repo.find_commit(ancestors[0])?.tree()?;
    for tip in [head, base] {
        let tree = repo.find_commit(tip)?.tree()?;
        let diff = repo.diff_tree_to_tree(Some(&ancestor), Some(&tree), None)?;
        let mut removed = BTreeSet::new(); let mut changed = BTreeSet::new();
        for delta in diff.deltas() {
            let path = if delta.status() == Delta::Deleted { delta.old_file().path() } else { delta.new_file().path() };
            let path = path.and_then(|value| value.to_str()).ok_or_else(|| Error::new("unsupported", "non UTF-8 tree path"))?.to_string();
            if delta.status() == Delta::Deleted { removed.insert(path); } else { changed.insert(path); }
        }
        if !removed.is_empty() && !changed.is_empty() {
            for path in removed.into_iter().chain(changed) { reasons.entry(path).or_insert_with(|| "possible_rename_group".into()); }
        }
    }
    Ok(reasons)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aliases_include_parent_case_but_not_unrelated_files() {
        let index: IndexState = ["Source/a.txt", "source/b.txt", "plain.txt", "Readme", "README"]
            .into_iter().map(|path| (path.into(), Vec::new())).collect();
        assert_eq!(case_aliases(&index), ["Source/a.txt", "source/b.txt", "Readme", "README"].into_iter().map(String::from).collect());
    }
}
