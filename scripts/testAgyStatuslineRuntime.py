"""Test a built CLI-Manager statusline helper using only a temporary home.

python scripts/testAgyStatuslineRuntime.py path/to/cli-manager[.exe]
On Windows, --tui also checks visible helper output in an isolated agy login
screen using the installed agy and Git for Windows winpty. Never signs in.
"""

import argparse
import functools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading


@functools.cache
def test_binary():
    manifest = Path(__file__).resolve().parents[1] / 'src-tauri/Cargo.toml'
    out = subprocess.check_output(['cargo', 'test', '--manifest-path', str(manifest), '--lib', '--no-run', '--message-format=json-render-diagnostics'], encoding='utf8')
    return next(row['executable'] for line in out.splitlines() if (row := json.loads(line)).get('executable') and row['profile']['test'])


def command(path, items, color, *, posix=False):
    # Ask the Rust production generator rather than reimplementing platform quoting in this smoke driver.
    env = dict(os.environ, AGY_P5_FIXTURE_EXE=str(path), AGY_P5_FIXTURE_LAYOUT=json.dumps({'items': items, 'color': color}))
    env.pop('AGY_P5_FIXTURE_POSIX', None)
    if posix:
        env['AGY_P5_FIXTURE_POSIX'] = '1'
    out = subprocess.check_output([test_binary(), '--exact', 'agy_statusline::tests::command_for_runtime_smoke', '--ignored', '--nocapture'], env=env, encoding='utf8')
    return next(line.removeprefix('AGY_P5_COMMAND=') for line in out.splitlines() if line.startswith('AGY_P5_COMMAND='))


def setup(root, source):
    executable = root / ("CLI 管理器 & O'Brien’s %fixture%!" + source.suffix)
    try:
        os.link(source, executable)
    except OSError:
        shutil.copy2(source, executable)
    home, cwd, temp = root / 'home', root / 'AGY-P5-VISIBLE', root / 'tmp'
    env = {k: os.environ[k] for k in ('SystemRoot', 'WINDIR', 'ComSpec', 'PATH', 'PATHEXT', 'SystemDrive') if k in os.environ}
    for name, folder in {'HOME': home, 'USERPROFILE': home, 'APPDATA': home / 'roaming', 'LOCALAPPDATA': home / 'local',
                         'CLOUDSDK_CONFIG': home / 'gcloud', 'XDG_DATA_HOME': home / 'data', 'XDG_CONFIG_HOME': home / 'config',
                         'XDG_CACHE_HOME': home / 'cache', 'TMP': temp, 'TEMP': temp, 'TMPDIR': temp}.items():
        folder.mkdir(exist_ok=True, parents=True)
        env[name] = str(folder)
    cwd.mkdir()
    if os.name == 'nt':
        env.update(HOMEDRIVE=home.drive, HOMEPATH=str(home)[len(home.drive):])
    env.update(TERM='xterm-256color', HTTP_PROXY='http://127.0.0.1:1', HTTPS_PROXY='http://127.0.0.1:1', NO_PROXY='localhost,127.0.0.1')
    return executable, home, cwd, env


def pipe_smoke(executable, cwd, env, posix_shell=None):
    # Git's sh checks POSIX quoting on Windows; it is not a substitute for macOS or WSL interoperability.
    line = command(executable.as_posix() if posix_shell else executable, ['model', 'state', 'input', 'output'], True, posix=bool(posix_shell))
    if os.name == 'nt' and not posix_shell:
        argv = 'cmd.exe /d /c ' + line
    else:
        argv = [str(posix_shell or 'sh'), '-c', line]
    data = {'model': None, 'agent_state': '空闲', 'context_window': {'total_output_tokens': 0}, 'terminal_width': 5}
    result = subprocess.run(argv, cwd=cwd, env=env, input=json.dumps(data, ensure_ascii=False).encode(), capture_output=True, timeout=12, check=True)
    if result.stdout != '\x1b[32m空闲\x1b[0m\n\x1b[35m↑0\x1b[0m'.encode() or result.stderr:
        raise RuntimeError('Real helper stdout/stderr did not match the expected ANSI bytes')
    print('PASS: ' + ('POSIX sh' if posix_shell or os.name != 'nt' else 'Windows cmd') + ', complex executable path, UTF-8/ANSI, missing values, genuine zero and wrapping')


def tui_frame(line, home, cwd, env, enabled, stack):
    # Only our managed command is present. Compare custom and stacked against the disabled negative control.
    agy, git = shutil.which('agy'), shutil.which('git')
    if os.name != 'nt' or not (agy and git):
        raise RuntimeError('--tui needs Windows, agy and Git for Windows')
    winpty = Path(git).parents[1] / 'usr/bin/winpty.exe'
    config = home / '.gemini/antigravity-cli/settings.json'
    config.parent.mkdir(parents=True, exist_ok=True)
    config.write_text(json.dumps({'statusLine': {'command': line, 'type': 'command', 'enabled': enabled, 'stack_with_default': stack}}), encoding='utf8')
    process = subprocess.Popen([str(winpty), '-Xallow-non-tty', '-Xplain', '--', agy], env=env, cwd=cwd,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    screen = bytearray()

    def read_screen():
        while chunk := os.read(process.stdout.fileno(), 4096):
            screen.extend(chunk[:max(0, 120000 - len(screen))])

    reader = threading.Thread(target=read_screen, daemon=True)
    reader.start()
    try:
        process.wait(timeout=7)
    except subprocess.TimeoutExpired:
        subprocess.run(['taskkill', '/PID', str(process.pid), '/T', '/F'], capture_output=True, timeout=6, check=False)
        process.wait(timeout=6)
    reader.join(timeout=3)
    process.stdin.close()
    process.stdout.close()
    plain = re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]', b'', bytes(screen))
    if not any(s in plain.lower() for s in [b'login', b'sign in', b'oauth']):
        raise RuntimeError('Did not reach the expected pre-login TUI')
    return b'AGY-P5-VISIBLE' in plain


def tui_smoke(executable, home, cwd, env):
    line = command(executable, ['directory'], False)
    for label, enabled, stack in [('disabled', False, False), ('custom', True, False), ('stacked', True, True)]:
        if tui_frame(line, home, cwd, env, enabled, stack) != enabled:
            raise RuntimeError('Unexpected pre-login TUI result: ' + label)
        print('PASS: isolated pre-login agy TUI ' + label + (' showed helper output' if enabled else ' did not show helper output'))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binary', type=Path)
    parser.add_argument('--tui', action='store_true')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='agy-p5-') as fixture:
        binary, home, cwd, environment = setup(Path(fixture), args.binary.resolve(strict=True))
        pipe_smoke(binary, cwd, environment)
        if args.tui:
            git = shutil.which('git')
            if os.name == 'nt' and git:
                pipe_smoke(binary, cwd, environment, Path(git).parents[1] / 'usr/bin/sh.exe')
            tui_smoke(binary, home, cwd, environment)
