"""Paired parser diagnostic. Launches only explicitly supplied isolated binaries."""
import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
from pathlib import Path
import platform
import subprocess
import sys
import time


class MemoryCounters(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage",
            "PrivateUsage")]


def run(binary, fixture, expected_allocator, expected_bytes):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    psapi.GetProcessMemoryInfo.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(MemoryCounters), wintypes.DWORD]
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    started = time.perf_counter()
    process = subprocess.Popen([str(binary), "--parse-fixture", str(fixture)],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               creationflags=subprocess.CREATE_NO_WINDOW)
    handle = kernel.OpenProcess(0x0400 | 0x0010, False, process.pid)
    peak_ws = peak_commit = samples = 0
    try:
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        while process.poll() is None:
            counters = MemoryCounters()
            counters.cb = ctypes.sizeof(counters)
            if psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
                samples += 1
                peak_ws = max(peak_ws, counters.PeakWorkingSetSize)
                peak_commit = max(peak_commit, counters.PeakPagefileUsage)
            if time.perf_counter() - started > 60:
                raise TimeoutError("Isolated parser exceeded 60 seconds")
            time.sleep(0.002)
        stdout, stderr = process.communicate(timeout=5)
        elapsed = (time.perf_counter() - started) * 1000
        if process.returncode:
            raise RuntimeError(f"Parser exit {process.returncode}: {stderr.decode(errors='replace')}")
        lines = [line.removeprefix("offline_parser_metrics=")
                 for line in stdout.decode().splitlines()
                 if line.startswith("offline_parser_metrics=")]
        if len(lines) != 1 or not samples:
            raise RuntimeError("Missing parser metrics or memory observations")
        metric = json.loads(lines[0])
        if metric["allocator"] != expected_allocator or metric["bytes"] != expected_bytes:
            raise RuntimeError("Wrong allocator or incomplete fixture")
        return dict(metric, process_ms=elapsed, memory_samples=samples,
                    observed_peak_working_set_bytes=peak_ws,
                    observed_peak_commit_bytes=peak_commit)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
        if handle:
            kernel.CloseHandle(handle)
        if process.stdout:
            process.stdout.close()
        if process.stderr:
            process.stderr.close()


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--system", type=Path, required=True)
    parser.add_argument("--mimalloc", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--pairs", type=int, default=5, choices=range(2, 11))
    args = parser.parse_args()
    if sys.platform != "win32":
        parser.error("Memory counters require Windows")
    paths = [args.system.resolve(strict=True), args.mimalloc.resolve(strict=True)]
    if paths[0] == paths[1]:
        parser.error("Distinct binary snapshots are required")
    fixture = args.fixture.resolve(strict=True)
    report = dict(schemaVersion=1, formalPerformance=False,
                  machine=platform.platform(), pairs=args.pairs,
                  fixture=dict(bytes=fixture.stat().st_size, sha256=digest(fixture)),
                  binaries=[dict(path=str(path), bytes=path.stat().st_size,
                                 sha256=digest(path)) for path in paths], runs=[],
                  limitations=["Parser-only; no PTY, ACK, shaping or GPU.",
                               "Warm cache, active developer host; no cold-start evidence.",
                               "Process duration includes launch, I/O, parsing and exit.",
                               "Observed OS high-water counters may miss final activity.",
                               "Working set includes shared pages; commit is not resident memory."])
    args.output.parent.mkdir(parents=True, exist_ok=True)
    allocators = ["system", "mimalloc-0.1.52"]
    try:
        for pair in range(args.pairs):
            for index in ([0, 1] if pair % 2 == 0 else [1, 0]):
                result = run(paths[index], fixture, allocators[index], fixture.stat().st_size)
                report["runs"].append(dict(pair=pair, **result))
                print(json.dumps(dict(pair=pair, **result)), flush=True)
        report["passed"] = True
    finally:
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
