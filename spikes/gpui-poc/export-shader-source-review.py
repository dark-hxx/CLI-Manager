"""Record official source metadata and expression matches, without copying answer prose."""
from datetime import datetime, timezone
import hashlib
import html
import json
from pathlib import Path
import re
import subprocess
import urllib.request

root = Path(__file__).resolve().parent
answers_url = "https://api.stackexchange.com/2.3/questions/92015/answers?site=gamedev&filter=withbody"
revisions_url = "https://api.stackexchange.com/2.3/posts/148088;194038/revisions?site=gamedev"


def fetch(url):
    request = urllib.request.Request(url, headers={"User-Agent": "CLI-Manager-license-evidence"})
    with urllib.request.urlopen(request, timeout=20) as response:
        payload = response.read()
    data = json.loads(payload)
    if data.get("error_id") or data.get("has_more") or data.get("backoff"):
        raise RuntimeError("Incomplete or throttled API response; retain previous evidence.")
    return data["items"], hashlib.sha256(payload).hexdigest()


def normalized(source):
    # Explicitly account for GLSL -> WGSL syntax; this is similarity, not provenance proof.
    source = source.replace("sRGB.rgb", "srgb").replace("linearRGB.rgb", "linear")
    source = source.replace("linearRGB", "linear").replace("sRGB", "srgb")
    source = source.replace("vec3<f32>", "V").replace("vec3", "V").replace("vec4", "V")
    source = source.replace("mix(", "select(")
    return re.sub(r"\s+", "", source)


answers, answers_hash = fetch(answers_url)
revisions, revisions_hash = fetch(revisions_url)
metadata = json.loads(subprocess.run(
    ["cargo", "metadata", "--locked", "--format-version", "1", "--manifest-path",
     str(root / "Cargo.toml")], capture_output=True, text=True, encoding="utf-8", check=True,
).stdout)
package = next(p for p in metadata["packages"] if p["name"] == "gpui-pre-wgpu")
shader_path = Path(package["manifest_path"]).parent / "src/shaders.wgsl"
shader_bytes = shader_path.read_bytes()
shader = shader_bytes.decode("utf-8")
start = shader.index("fn srgb_to_linear(")
end = shader.index("/// Convert a linear color", start)
shader_fragment = shader[start:end]
expressions = [
    "pow((srgb + V(0.055)) / V(1.055), V(2.4))",
    "srgb / V(12.92)",
    "V(1.055) * pow(linear, V(1.0/2.4)) - V(0.055)",
    "linear * V(12.92)",
    "select(higher, lower, cutoff)",
]
records = []
for answer_id in [148088, 194038]:
    answer = next(a for a in answers if a["answer_id"] == answer_id)
    history = [r for r in revisions if r["post_id"] == answer_id]
    if not history:
        raise RuntimeError(f"No revision evidence for {answer_id}")
    code = "\n".join(html.unescape(text) for text in
                     re.findall(r"<code>(.*?)</code>", answer["body"], re.DOTALL))
    records.append({
        "answerId": answer_id,
        "url": f"https://gamedev.stackexchange.com/a/{answer_id}",
        "author": answer["owner"]["display_name"],
        "authorUrl": answer["owner"]["link"],
        "createdAt": datetime.fromtimestamp(answer["creation_date"], timezone.utc).isoformat(),
        "contentLicense": answer["content_license"],
        "bodySha256": hashlib.sha256(answer["body"].encode("utf-8")).hexdigest(),
        "revisions": [{key: rev[key] for key in [
            "revision_guid", "revision_number", "creation_date", "content_license",
        ]} for rev in history],
        "matchingNormalizedExpressions": [expression for expression in expressions
            if normalized(expression) in normalized(code)
            and normalized(expression) in normalized(shader_fragment)],
    })
report = {
    "retrievedAt": datetime.now(timezone.utc).isoformat(),
    "sources": [{"url": answers_url, "responseSha256": answers_hash},
                {"url": revisions_url, "responseSha256": revisions_hash}],
    "package": f"{package['name']} {package['version']}",
    "file": "src/shaders.wgsl",
    "fileSha256": hashlib.sha256(shader_bytes).hexdigest(),
    "reviewedLines": [209, 229],
    "answers": records,
    "verdict": "Source similarity found; copied revision and license compatibility unresolved.",
    "limitations": [
        "Normalization compares selected expressions, not authorship or legal protectability.",
        "Threshold/branch and alpha handling are not proven identical by this comparison.",
        "Raw API response hashes identify retrievals; answer prose is not redistributed here.",
        "Current Windows default target does not select gpui-pre-wgpu; other targets require review.",
    ],
}
destination = root / "research" / "shader-source-review.json"
destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Saved {len(records)} source/revision records to {destination}")
