"""Manual Windows agy smoke check; requires agy, Python 3, Git for Windows.

Runs the interactive CLI to its welcome/login screen, not print mode. Each case
has its own empty home, CLI settings, project and PATH-local test command. No
prompts, credentials, account login or raw statusline payloads are supplied or
saved. A positive result does not validate post-login transcripts or billing.
"""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading


MARKER = 'CLIM_AGY_STATUSLINE_TEST'
FIELDS = ('cwd', 'conversation_id', 'session_id', 'model', 'context_window',
          'agent_state', 'task_count', 'tool_confirmation_pending', 'terminal_width')


def summarize_stdin():
    # Save only presence/types for a fixed public field allowlist, never values.
    payload = json.load(sys.stdin)
    schema = {key: type(payload[key]).__name__ for key in FIELDS if key in payload}
    Path(os.environ['CLIM_TEST_SCHEMA']).write_text(json.dumps(schema), encoding='utf8')
    print(MARKER, flush=True)


def run_case(root, agy, winpty, mode):
    home, project, tmp, tools = [root / name for name in ('home', 'project', 'tmp', 'tools')]
    for directory in (home, project, tmp, tools):
        directory.mkdir(parents=True)
    settings = home / '.gemini/antigravity-cli/settings.json'
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({'statusLine': {
        'type': 'command', 'command': 'clim-agy-schema-probe.cmd',
        'enabled': mode != 'disabled', 'stack_with_default': mode == 'stack',
    }}), encoding='utf8')
    probe = tools / 'schema.py'
    shutil.copyfile(Path(__file__).resolve(), probe)
    (tools / 'clim-agy-schema-probe.cmd').write_text(
        '@echo off\r\n"%CLIM_TEST_PYTHON%" "%~dp0schema.py" --schema\r\n',
        encoding='ascii', newline='')
    schema_path = root / 'schema.json'
    env = {k: os.environ[k] for k in ('SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'SystemDrive') if k in os.environ}
    env.update(PATH=str(tools) + os.pathsep + env['PATH'], HOME=str(home), USERPROFILE=str(home),
               HOMEDRIVE=home.drive, HOMEPATH=str(home)[len(home.drive):], TEMP=str(tmp), TMP=str(tmp),
               TERM='xterm-256color', NO_COLOR='1', CLIM_TEST_PYTHON=sys.executable, CLIM_TEST_SCHEMA=str(schema_path),
               HTTP_PROXY='http://127.0.0.1:1', HTTPS_PROXY='http://127.0.0.1:1', NO_PROXY='localhost,127.0.0.1')
    for key, path in {'APPDATA': 'AppData/Roaming', 'LOCALAPPDATA': 'AppData/Local', 'CLOUDSDK_CONFIG': 'gcloud',
                      'XDG_CONFIG_HOME': '.config', 'XDG_DATA_HOME': '.local/share', 'XDG_CACHE_HOME': '.cache'}.items():
        (home / path).mkdir(parents=True, exist_ok=True)
        env[key] = str(home / path)
    # Git winpty's non-tty transport still gives the child a real Windows console.
    process = subprocess.Popen([str(winpty), '-Xallow-non-tty', '-Xplain', '--', agy], env=env, cwd=project,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    screen = bytearray()

    def read_screen():
        while True:
            chunk = os.read(process.stdout.fileno(), 8192)
            if not chunk:
                break
            screen.extend(chunk[:max(0, 100000 - len(screen))])

    reader = threading.Thread(target=read_screen, daemon=True)
    reader.start()
    try:
        process.wait(timeout=6)
    except subprocess.TimeoutExpired:
        try:
            process.stdin.write(b'\x03\x03')
            process.stdin.flush()
            process.wait(timeout=2)
        except (BrokenPipeError, subprocess.TimeoutExpired):
            if process.poll() is None:
                subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=5, check=False)
                process.wait(timeout=5)
    reader.join(timeout=2)
    process.stdin.close()
    process.stdout.close()
    text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', screen.decode('utf8', 'replace'))
    return {'mode': mode, 'loginScreen': bool(re.search(r'login|sign in|oauth', text, re.I)),
            'markerDisplayed': MARKER in text, 'probeCalled': schema_path.is_file(),
            'fieldTypes': json.loads(schema_path.read_text(encoding='utf8')) if schema_path.is_file() else {},
            'transcripts': len(list(home.glob('.gemini/antigravity-cli/brain/*/.system_generated/logs/transcript.jsonl')))}


def main():
    agy, git = shutil.which('agy'), shutil.which('git')
    if os.name != 'nt' or not agy or not git:
        sys.exit('Requires Windows, agy and Git for Windows on PATH.')
    winpty = Path(git).parents[1] / 'usr/bin/winpty.exe'
    if not winpty.is_file():
        sys.exit('Git for Windows winpty.exe not found.')
    print('agy', subprocess.check_output([agy, '--version'], text=True, timeout=8).strip(), flush=True)
    with tempfile.TemporaryDirectory(prefix='clim-agy-windows-smoke-') as fixture:
        results = [run_case(Path(fixture) / mode, agy, winpty, mode) for mode in ('custom', 'stack', 'disabled')]
    print(json.dumps(results, indent=2))
    return 0 if all(r['loginScreen'] and r['markerDisplayed'] == (r['mode'] != 'disabled')
                    and r['probeCalled'] == (r['mode'] != 'disabled') for r in results) else 1


if __name__ == '__main__':
    if sys.argv[1:] == ['--schema']:
        summarize_stdin()
    else:
        sys.exit(main())
