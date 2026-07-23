#!/bin/sh
set -eu

REPOSITORY="dark-hxx/CLI-Manager"
R2_PUBLIC_BASE_URL="https://github.bwm.de5.net"
PUBLIC_KEY="RWQ2q8PpYSJOegTuwYHCPZ5ArX7D8RnAyC2LCylqKghGnRGfzuioR+KL"
manifest_url=""
fallback_manifest_url=""
install_dir=""
requested_version=""
requested_channel=""
allow_http=0
allow_downgrade=0
dry_run=0
json=0
uninstall=0
purge=0

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

log() {
  printf '%s\n' "$1" >&2
}

usage() {
  cat <<'EOF'
Usage: install-ssh-agent.sh [options]
  --manifest-url URL   Signed release manifest; defaults to the latest desktop release
  --version VERSION    Use the manifest from release ssh-agent-vVERSION
  --channel CHANNEL    Require a matching manifest channel
  --install-dir PATH   Custom absolute Agent install root
  --allow-http         Permit a signed manifest and artifact over HTTP
  --allow-downgrade    Permit installing a lower Agent version
  --dry-run            Verify and print the selected plan without installing
  --json               Keep stdout machine-readable
  --uninstall          Uninstall the discovered Agent
  --purge              With --uninstall, remove Agent state as well
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --manifest-url|--version|--channel|--install-dir)
      [ "$#" -ge 2 ] || fail "missing value for $1"
      case "$1" in
        --manifest-url) manifest_url=$2 ;;
        --version) requested_version=$2 ;;
        --channel) requested_channel=$2 ;;
        --install-dir) install_dir=$2 ;;
      esac
      shift 2
      ;;
    --allow-http) allow_http=1; shift ;;
    --allow-downgrade) allow_downgrade=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --json) json=1; shift ;;
    --uninstall) uninstall=1; shift ;;
    --purge) purge=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1" ;;
  esac
done

case "$requested_version" in
  ""|*[!0-9A-Za-z.+-]*) [ -z "$requested_version" ] || fail "invalid requested version" ;;
esac

case "$install_dir" in
  ""|/*|~/*) ;;
  *) fail "install directory must be absolute or start with ~/" ;;
esac
case "$install_dir" in
  *"/../"*|*"/.."|"../"*) fail "install directory cannot contain .." ;;
esac

find_agent() {
  if [ -n "${CLI_MANAGER_SSH_AGENT_PATH:-}" ] && [ -x "$CLI_MANAGER_SSH_AGENT_PATH" ]; then
    printf '%s\n' "$CLI_MANAGER_SSH_AGENT_PATH"
  elif command -v cli-manager-ssh-agent >/dev/null 2>&1; then
    command -v cli-manager-ssh-agent
  elif [ -x "${HOME:-}/.local/bin/cli-manager-ssh-agent" ]; then
    printf '%s\n' "$HOME/.local/bin/cli-manager-ssh-agent"
  elif [ -n "$install_dir" ] && [ -x "$install_dir/current/cli-manager-ssh-agent" ]; then
    printf '%s\n' "$install_dir/current/cli-manager-ssh-agent"
  else
    return 1
  fi
}

if [ "$uninstall" -eq 1 ]; then
  agent=$(find_agent) || fail "cli-manager-ssh-agent is not installed"
  set -- uninstall
  [ -z "$install_dir" ] || set -- "$@" --install-dir "$install_dir"
  [ "$purge" -eq 0 ] || set -- "$@" --purge
  exec "$agent" "$@"
fi
[ "$purge" -eq 0 ] || fail "--purge requires --uninstall"

command -v curl >/dev/null 2>&1 || fail "curl is required"
command -v minisign >/dev/null 2>&1 || fail "minisign is required to verify the signed manifest"
if [ -z "$manifest_url" ]; then
  if [ -n "$requested_version" ]; then
    case "$requested_version" in
      1.3.0) release_tag="V$requested_version" ;;
      *) release_tag="ssh-agent-v$requested_version" ;;
    esac
    manifest_url="$R2_PUBLIC_BASE_URL/CLI-Manager/releases/$release_tag/ssh-agent-release-manifest.json"
    fallback_manifest_url="https://github.com/$REPOSITORY/releases/download/$release_tag/ssh-agent-release-manifest.json"
  else
    manifest_url="$R2_PUBLIC_BASE_URL/CLI-Manager/releases/ssh-agent/latest/ssh-agent-release-manifest.json"
    fallback_manifest_url="https://github.com/$REPOSITORY/releases/latest/download/ssh-agent-release-manifest.json"
  fi
fi
case "$manifest_url" in
  https://*) ;;
  http://*) [ "$allow_http" -eq 1 ] || fail "HTTP requires --allow-http" ;;
  *) fail "manifest URL must use HTTPS or explicitly allowed HTTP" ;;
esac
case "$manifest_url" in *\?*|*\#*) fail "manifest URL cannot contain a query or fragment" ;; esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/cli-manager-ssh-agent.XXXXXX") || fail "unable to create temporary directory"
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
manifest="$tmp/manifest.json"
signature_encoded="$tmp/manifest.sig"
signature="$tmp/manifest.minisig"
artifact="$tmp/cli-manager-ssh-agent"

download() {
  output=$1
  url=$2
  maximum=$3
  if [ "$allow_http" -eq 1 ]; then
    curl -fL --proto '=https,http' --proto-redir '=https,http' --max-redirs 3 --max-filesize "$maximum" -o "$output" "$url" || return 1
  else
    curl -fL --proto '=https' --proto-redir '=https' --max-redirs 3 --max-filesize "$maximum" -o "$output" "$url" || return 1
  fi
  bytes=$(wc -c < "$output" 2>/dev/null | tr -d ' ') || return 1
  [ -n "$bytes" ] && [ "$bytes" -le "$maximum" ] || return 1
}

if ! command -v base64 >/dev/null 2>&1 && ! command -v openssl >/dev/null 2>&1; then
  fail "base64 or openssl is required"
fi

load_manifest() {
  candidate=$1
  rm -f "$manifest" "$signature_encoded" "$signature"
  download "$manifest" "$candidate" 1048576 || return 1
  download "$signature_encoded" "$candidate.sig" 65536 || return 1
  if command -v base64 >/dev/null 2>&1; then
    if ! base64 -d "$signature_encoded" > "$signature" 2>/dev/null; then
      base64 --decode "$signature_encoded" > "$signature" 2>/dev/null || return 1
    fi
  elif command -v openssl >/dev/null 2>&1; then
    openssl base64 -d -A -in "$signature_encoded" -out "$signature" || return 1
  fi
  minisign -Vm "$manifest" -P "$PUBLIC_KEY" -x "$signature" >/dev/null 2>&1 || return 1
  manifest_url=$candidate
}

if ! load_manifest "$manifest_url"; then
  [ -n "$fallback_manifest_url" ] || fail "unable to load or verify the release manifest"
  load_manifest "$fallback_manifest_url" || fail "unable to load or verify the release manifest"
fi

case "$(uname -s 2>/dev/null)/$(uname -m 2>/dev/null)" in
  Linux/x86_64|Linux/amd64) target="linux-x86_64" ;;
  Linux/aarch64|Linux/arm64) target="linux-aarch64" ;;
  *) fail "unsupported target" ;;
esac

parse_with_jq() {
  jq -r --arg target "$target" '
    [.schemaVersion, .channel, .version, .protocolMin, .protocolMax,
     (.artifacts[] | select(.target == $target) | .url, .size, .sha256)] | @tsv
  ' "$manifest"
}

parse_with_python() {
  python3 - "$manifest" "$target" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    manifest = json.load(handle)
artifact = next((item for item in manifest.get("artifacts", []) if item.get("target") == sys.argv[2]), None)
if artifact is None:
    raise SystemExit("target missing")
values = [manifest.get("schemaVersion"), manifest.get("channel"), manifest.get("version"),
          manifest.get("protocolMin"), manifest.get("protocolMax"), artifact.get("url"),
          artifact.get("size"), artifact.get("sha256")]
if any(value is None or "\t" in str(value) or "\n" in str(value) for value in values):
    raise SystemExit("invalid manifest fields")
print("\t".join(map(str, values)))
PY
}

read_release() {
  if command -v jq >/dev/null 2>&1; then
    fields=$(parse_with_jq) || fail "invalid release manifest"
  elif command -v python3 >/dev/null 2>&1; then
    fields=$(parse_with_python) || fail "invalid release manifest"
  else
    fail "jq or python3 is required to parse the signed manifest"
  fi
  old_ifs=$IFS
  IFS='	'
  set -- $fields
  IFS=$old_ifs
  [ "$#" -eq 8 ] || fail "signed manifest does not contain the selected target"
  schema=$1 channel=$2 version=$3 protocol_min=$4 protocol_max=$5 artifact_url=$6 expected_size=$7 expected_sha256=$8
  [ "$schema" = "1" ] || fail "unsupported manifest schema"
  case "$protocol_min:$protocol_max" in *[!0-9:]*) fail "invalid Agent protocol range" ;; esac
  [ "$protocol_min" -le 1 ] && [ "$protocol_max" -ge 1 ] || fail "incompatible Agent protocol"
  [ -z "$requested_version" ] || [ "$version" = "$requested_version" ] || fail "manifest version mismatch"
  [ -z "$requested_channel" ] || [ "$channel" = "$requested_channel" ] || fail "manifest channel mismatch"
  case "$artifact_url" in
    https://*) ;;
    http://*) [ "$allow_http" -eq 1 ] || fail "HTTP artifact requires --allow-http" ;;
    *) fail "invalid artifact URL" ;;
  esac
  case "$artifact_url" in *\?*|*\#*) fail "artifact URL cannot contain a query or fragment" ;; esac
  case "$expected_size" in *[!0-9]*|"") fail "invalid artifact size" ;; esac
  [ "$expected_size" -le 134217728 ] || fail "artifact exceeds the 128 MB limit"
  case "$expected_sha256" in *[!0-9a-fA-F]*|"") fail "invalid artifact SHA-256" ;; esac
  [ "${#expected_sha256}" -eq 64 ] || fail "invalid artifact SHA-256"
}

read_release
artifact_sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$artifact" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$artifact" | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$artifact" | awk '{print $NF}'
  else
    fail "sha256sum, shasum, or openssl is required"
  fi
}

download_verified_artifact() {
  rm -f "$artifact"
  download "$artifact" "$artifact_url" "$expected_size" || return 1
  actual_size=$(wc -c < "$artifact" | tr -d ' ')
  [ "$actual_size" = "$expected_size" ] || return 1
  actual_sha256=$(artifact_sha256)
  [ "$(printf '%s' "$actual_sha256" | tr 'A-F' 'a-f')" = "$(printf '%s' "$expected_sha256" | tr 'A-F' 'a-f')" ]
}

primary_version=$version
primary_size=$expected_size
primary_sha256=$expected_sha256
if ! download_verified_artifact; then
  [ -n "$fallback_manifest_url" ] && [ "$manifest_url" != "$fallback_manifest_url" ] \
    || fail "unable to download Agent artifact"
  load_manifest "$fallback_manifest_url" || fail "unable to load or verify the fallback release manifest"
  read_release
  [ "$version" = "$primary_version" ] \
    && [ "$expected_size" = "$primary_size" ] \
    && [ "$(printf '%s' "$expected_sha256" | tr 'A-F' 'a-f')" = "$(printf '%s' "$primary_sha256" | tr 'A-F' 'a-f')" ] \
    || fail "fallback release does not match the primary release"
  download_verified_artifact || fail "unable to download or verify Agent artifact"
fi
chmod 700 "$artifact"

if [ "$dry_run" -eq 1 ]; then
  if [ "$json" -eq 1 ]; then
    printf '{"action":"dryRun","version":"%s","target":"%s","size":%s}\n' "$version" "$target" "$expected_size"
  else
    log "Verified Agent $version for $target ($expected_size bytes). No files changed."
  fi
  exit 0
fi

case "$manifest_url" in http://*) install_source=http-script ;; *) install_source=https-script ;; esac
set -- install --source "$install_source" --manifest-url "$manifest_url" --artifact-sha256 "$expected_sha256"
[ -z "$install_dir" ] || set -- "$@" --install-dir "$install_dir"
[ "$allow_downgrade" -eq 0 ] || set -- "$@" --allow-downgrade
"$artifact" "$@"
