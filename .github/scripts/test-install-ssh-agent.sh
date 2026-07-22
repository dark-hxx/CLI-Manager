#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)
tmp=$(mktemp -d "${TMPDIR:-/tmp}/ssh-agent-installer-test.XXXXXX")
trap 'rm -rf "$tmp"' EXIT HUP INT TERM
bin="$tmp/bin"
mkdir -p "$bin"

cat > "$tmp/artifact" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "$RESULT_FILE"
printf '%s\n' '{"action":"installed","installation":{"installationId":"00000000-0000-4000-8000-000000000001","remoteMachineId":"test","agentVersion":"1.2.3","protocolVersion":"1.0","target":"linux/x86_64","installRoot":"/opt/agent","installPath":"/home/test/.local/bin/cli-manager-ssh-agent","source":"http-script","manifestUrl":"http://mirror/manifest.json","artifactSha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","previousVersion":""}}'
EOF
chmod +x "$tmp/artifact"
size=$(wc -c < "$tmp/artifact" | tr -d ' ')
sha=$(sha256sum "$tmp/artifact" | awk '{print $1}')
printf '%s\n' '{}' > "$tmp/manifest.json"
printf '%s\n' 'c2lnbmF0dXJlCg==' > "$tmp/manifest.sig"

cat > "$bin/curl" <<'EOF'
#!/bin/sh
set -eu
output=""
url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    --max-filesize|--max-redirs|--proto|--proto-redir) shift 2 ;;
    *) shift ;;
  esac
done
case "$url" in
  *.json.sig) cp "$FIXTURE_SIGNATURE" "$output" ;;
  *.json) cp "$FIXTURE_MANIFEST" "$output" ;;
  */agent) cp "$FIXTURE_ARTIFACT" "$output" ;;
  *) exit 22 ;;
esac
EOF

cat > "$bin/minisign" <<'EOF'
#!/bin/sh
exit 0
EOF

cat > "$bin/jq" <<'EOF'
#!/bin/sh
printf '1\ttemp\t1.2.3\t1\t1\t%s\t%s\t%s\n' "$ARTIFACT_URL" "$ARTIFACT_SIZE" "$ARTIFACT_SHA256"
EOF

cat > "$bin/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in -s) printf 'Linux\n' ;; -m) printf 'x86_64\n' ;; *) printf 'Linux\n' ;; esac
EOF
chmod +x "$bin/curl" "$bin/minisign" "$bin/jq" "$bin/uname"

export PATH="$bin:$PATH"
export FIXTURE_SIGNATURE="$tmp/manifest.sig"
export FIXTURE_MANIFEST="$tmp/manifest.json"
export FIXTURE_ARTIFACT="$tmp/artifact"
export ARTIFACT_SIZE="$size"
export ARTIFACT_SHA256="$sha"
export RESULT_FILE="$tmp/result.txt"
export TMPDIR="$tmp/installer-tmp"
mkdir -p "$TMPDIR"

ARTIFACT_URL="https://mirror/agent"
export ARTIFACT_URL
dry_run=$(sh "$root/scripts/install-ssh-agent.sh" --manifest-url https://mirror/manifest.json --dry-run --json)
case "$dry_run" in *'"action":"dryRun"'*'"target":"linux-x86_64"'*) ;; *) exit 1 ;; esac

if sh "$root/scripts/install-ssh-agent.sh" --manifest-url http://mirror/manifest.json --dry-run >/dev/null 2>&1; then
  exit 1
fi

ARTIFACT_URL="http://mirror/agent"
export ARTIFACT_URL
sh "$root/scripts/install-ssh-agent.sh" \
  --manifest-url http://mirror/manifest.json \
  --allow-http \
  --allow-downgrade \
  --install-dir /opt/agent >/dev/null
grep -F -- "install --source http-script --manifest-url http://mirror/manifest.json" "$RESULT_FILE" >/dev/null
grep -F -- "--install-dir /opt/agent --allow-downgrade" "$RESULT_FILE" >/dev/null
[ -z "$(find "$TMPDIR" -mindepth 1 -maxdepth 1 -print -quit)" ]
