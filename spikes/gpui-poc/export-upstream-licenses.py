"""Save upstream license evidence; distinguish pinned revisions from live snapshots."""
import hashlib
import json
from pathlib import Path
import urllib.request
from datetime import datetime, timezone

root = Path(__file__).resolve().parent / "research" / "upstream-licenses"
sources = [
    ("microsoft-terminal", "microsoft/terminal",
     "1283c0f5b99a2961673249fa77c6b986efb5086c", "LICENSE",
     "Exact revision cited by GPUI platform.rs and shader headers."),
    ("display-link", "BrainiumLLC/display-link",
     "32780138c65ee3981d0fa44f321bb9946146a580", "LICENSE-MIT",
     "Pinned review snapshot; GPUI header references master, original copied revision unknown."),
    ("ghostty", "ghostty-org/ghostty",
     "b58a761aba75fadf1e3dd2ea23df9e38c4284c92", "LICENSE",
     "Merge commit of PR 8625 cited by GPUI macOS platform.rs."),
    ("winit", "rust-windowing/winit", "8b6c8ef323e8a7a41bb6541c6f000b2ec34ccca4", "LICENSE",
     "Commit resolved from v0.29.11, the version cited by GPUI Linux mode_refresh_rate."),
    ("gpui-kit-docs", "longbridge/gpui-kit",
     "99576db58ec8103417c41a092e891b4022d24e7e", "LICENSE-DOCS.md",
     "Repository-root documentation notice at gpui-component 0.8.1 .cargo_vcs_info revision; "
     "not included in registry package. Links CC BY 4.0; this notice is not the full legal code."),
]
root.mkdir(parents=True, exist_ok=True)
records = []
for name, repository, revision, filename, scope in sources:
    url = f"https://raw.githubusercontent.com/{repository}/{revision}/{filename}"
    request = urllib.request.Request(url, headers={"User-Agent": "CLI-Manager-license-evidence"})
    with urllib.request.urlopen(request, timeout=20) as response:
        content = response.read()
    destination = root / f"{name}.txt"
    destination.write_bytes(content)
    records.append({"file": destination.name, "url": url, "scope": scope,
                    "sha256": hashlib.sha256(content).hexdigest()})
# The author's linked license is a live endpoint, not a known source revision.
oklab_url = "https://bottosson.github.io/misc/License.txt"
request = urllib.request.Request(oklab_url, headers={"User-Agent": "CLI-Manager-license-evidence"})
with urllib.request.urlopen(request, timeout=20) as response:
    content = response.read()
(root / "oklab.txt").write_bytes(content)
records.append({
    "file": "oklab.txt", "url": oklab_url,
    "scope": "Author-linked MIT license for Oklab example code; original copied revision unknown.",
    "sourcePage": "https://bottosson.github.io/posts/oklab/",
    "revisionPinned": False,
    "retrievedAt": datetime.now(timezone.utc).isoformat(),
    "sha256": hashlib.sha256(content).hexdigest(),
})
(root / "sources.json").write_text(
    json.dumps(records, indent=2) + "\n", encoding="utf-8")
print(f"Saved {len(records)} upstream license snapshots to {root}")
