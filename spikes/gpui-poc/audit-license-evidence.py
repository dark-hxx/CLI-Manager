"""Export locked GPUI attribution and candidate assets; not release approval."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent
result = subprocess.run(
    ["cargo", "metadata", "--locked", "--format-version", "1", "--manifest-path",
     str(root / "Cargo.toml")], capture_output=True, text=True, encoding="utf-8", check=True,
)
metadata = json.loads(result.stdout)
packages = metadata["packages"]
features = {node["id"]: node["features"] for node in metadata["resolve"]["nodes"]}
source_extensions = {
    ".rs", ".h", ".c", ".cpp", ".m", ".mm", ".hlsl", ".wgsl", ".metal",
    ".scm", ".svg", ".md", ".txt", ".toml", ".json", ".js", ".ts", ".css",
}
resource_extensions = {
    ".hlsl", ".wgsl", ".metal", ".scm", ".svg", ".ttf", ".otf", ".woff",
    ".woff2", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns",
}
attribution_pattern = re.compile(
    r"copyright|SPDX-License-Identifier|adapted from|derived from|licensed under|"
    r"license\s*:|license terms|LICENSE-(?:MIT|APACHE)", re.IGNORECASE,
)
lines = ["# GPUI license evidence", "",
         "Generated from locked registry packages by `audit-license-evidence.py`.",
         "Hashes identify reviewed artifacts, not approval of all package contents.", "",
         "| Package | File | SHA-256 |", "|---|---|---|"]
attributions = []
artifacts = []
package_features = []
scanned_sources = 0
for package in sorted(packages, key=lambda p: (p["name"], p["version"])):
    if not package["name"].startswith("gpui"):
        continue
    package_root = Path(package["manifest_path"]).parent
    identity = f"{package['name']} {package['version']}"
    package_features.append({"package": identity, "features": features.get(package["id"], [])})
    defaults_file = package_root / "default-icons.txt"
    default_icons = set()
    if package["name"] == "gpui-kit-assets" and defaults_file.exists():
        default_icons = {f"assets/{line.strip()}" for line in
                         defaults_file.read_text(encoding="utf-8").splitlines() if line.strip()}
        missing = sorted(path for path in default_icons if not (package_root / path).is_file())
        if missing:
            raise RuntimeError(f"Default icon inputs missing: {missing}")
    for artifact in sorted(package_root.rglob("*")):
        if not artifact.is_file():
            continue
        relative = artifact.relative_to(package_root).as_posix()
        content = artifact.read_bytes()
        digest = hashlib.sha256(content).hexdigest()
        if re.match(r"^(LICENSE|COPYING|NOTICE)", artifact.name, re.IGNORECASE):
            lines.append(f"| {identity} | {relative} | {digest} |")
        if artifact.suffix.lower() in resource_extensions or artifact.name in {
            "build.rs", "default-icons.txt",
        }:
            role = "resource-candidate"
            if artifact.name in {"build.rs", "default-icons.txt"}:
                role = "build-definition"
            elif relative in default_icons:
                role = "default-icon-bundle-input"
            elif relative.startswith("examples/") or "/examples/" in relative:
                role = "example-candidate"
            artifacts.append({"package": identity, "file": relative, "role": role,
                              "bytes": len(content), "sha256": digest})
        if artifact.suffix.lower() not in source_extensions:
            continue
        scanned_sources += 1
        source = content.decode("utf-8", errors="replace")
        matches = []
        for number, line in enumerate(source.splitlines(), 1):
            shader_reference = artifact.suffix.lower() in {".hlsl", ".wgsl", ".metal"} and re.search(
                r"https?://", line,
            )
            if attribution_pattern.search(line) or shader_reference:
                matches.append({"line": number, "text": line.strip()})
        if matches:
            attributions.append({"package": identity, "file": relative,
                                 "sha256": digest, "matches": matches})
lines.extend(["", "## Source attribution scan", "",
              f"Scanned {scanned_sources} text candidates in {len(package_features)} GPUI packages.",
              "`source-attributions.json` preserves matching lines and file hashes, including Rust",
              "and Scheme queries. Heuristic matches are review candidates, not an exhaustive audit.",
              "`asset-candidates.json` inventories resource and build-script candidates from those",
              "packages; this does not prove compilation, linking, loading, or redistribution.",
              "`resolved-gpui-features.json` describes the all-platform default metadata graph,",
              "not an all-features build or a Windows-only reachability report.", ""])
destination = root / "research" / "license-evidence.md"
destination.write_text("\n".join(lines), encoding="utf-8")
print(f"Exported license evidence to {destination}")
for filename, payload in [
    ("source-attributions.json", attributions),
    ("asset-candidates.json", artifacts),
    ("resolved-gpui-features.json", package_features),
]:
    (destination.parent / filename).write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"Attribution files: {len(attributions)}; resource/build candidates: {len(artifacts)}")

deny_log = root / "research" / "deny-results.jsonl"
if deny_log.exists():
    summaries = [entry for line in deny_log.read_text(encoding="utf-8").splitlines()
                 if (entry := json.loads(line)).get("type") == "summary"]
    if not summaries:
        raise RuntimeError("cargo-deny log has no completed summary")
    summary = {"command": "cargo deny --format json check licenses bans",
               "allFeatures": False, "summary": summaries[-1]["fields"]}
    (root / "research" / "deny-summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8")
