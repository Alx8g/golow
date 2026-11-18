# /// script
# requires-python = ">=3.10"
# dependencies = ["psutil>=5.9", "websocket-client>=1.7"]
# ///
"""Compare startup, CPU and memory of GoLow builds on the logged-out Discover page.

Each build gets a throwaway profile under .working/bench, never your real one, and
builds alternate run by run so network and thermal drift hit them equally.

    uv run scripts/benchmark.py --exe old=old.exe --exe new=target/release/golow.exe --cdp
"""

import argparse
import ctypes
import json
import os
import re
import statistics
import subprocess
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path

import psutil
import websocket

ROOT = Path(__file__).resolve().parent.parent
user32 = ctypes.WinDLL("user32")
ENUM_PROC = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows.argtypes = (ENUM_PROC, wintypes.LPARAM)
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.IsWindowVisible.argtypes = (wintypes.HWND,)
user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
user32.PostMessageW.argtypes = (wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)


def main_window(pid):
    found = []

    def visit(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            found.append(hwnd)
        return not found

    user32.EnumWindows(ENUM_PROC(visit), 0)
    return found[0] if found else None


def tree(root):
    try:
        return [root, *root.children(recursive=True)]
    except psutil.NoSuchProcess:
        return []


def total(procs, read):
    value = 0.0
    for proc in procs:
        try:
            value += read(proc)
        except psutil.Error:
            pass
    return value


class Cdp:
    """Page metrics through the DevTools port WebView2 opens for this run only."""

    def __init__(self, port):
        for _ in range(80):
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/json", timeout=2) as reply:
                    page = next(t for t in json.load(reply) if t["type"] == "page" and "soundcloud" in t["url"])
                break
            except (OSError, StopIteration):
                time.sleep(0.25)
        else:
            raise TimeoutError("DevTools endpoint did not expose the page")
        self.ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
        self.id = 0
        self.call("Performance.enable")

    def call(self, method):
        self.id += 1
        self.ws.send(json.dumps({"id": self.id, "method": method}))
        while (message := json.loads(self.ws.recv())).get("id") != self.id:
            pass
        return message.get("result", {})

    def metrics(self):
        return {m["name"]: m["value"] for m in self.call("Performance.getMetrics")["metrics"]}


def sample(root, seconds, cdp):
    cpu = lambda: total(tree(root), lambda p: sum(p.cpu_times()[:2]))
    start_cpu, start_page, started, memory = cpu(), cdp.metrics() if cdp else {}, time.monotonic(), []
    while time.monotonic() - started < seconds:
        time.sleep(1)
        memory.append(total(tree(root), lambda p: p.memory_info().private) / 2**20)
    elapsed = time.monotonic() - started
    result = {"cpu_pct_one_core": 100 * (cpu() - start_cpu) / elapsed, "private_mib": statistics.mean(memory),
              "processes": len(tree(root))}
    if cdp:
        end = cdp.metrics()
        for name in ("TaskDuration", "LayoutDuration", "RecalcStyleDuration", "ScriptDuration"):
            result[f"main_thread_{name}_ms_per_s"] = 1000 * (end[name] - start_page[name]) / elapsed
        result["js_heap_mib"] = end["JSHeapUsedSize"] / 2**20
    return result


def run(exe, profile, settings, args, port):
    profile.mkdir(parents=True, exist_ok=True)
    (profile / "startup.log").unlink(missing_ok=True)  # Never read the previous run's timings.
    if settings:
        (profile / "settings.json").write_text(settings)
    # SOUNDCLOUD_PROFILE_DIR lets this compare against builds from before the rename.
    env = dict(os.environ, GOLOW_PROFILE_DIR=str(profile), SOUNDCLOUD_PROFILE_DIR=str(profile))
    if args.cdp:
        env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = f"--remote-debugging-port={port}"
    child = subprocess.Popen([exe], env=env)
    root, deadline, result, cdp = psutil.Process(child.pid), time.monotonic() + 90, {}, None
    try:
        log = ""
        while "page_finished" not in log:
            if time.monotonic() > deadline or child.poll() is not None:
                raise TimeoutError("page did not finish loading")
            time.sleep(0.05)
            log = (profile / "startup.log").read_text(errors="replace") if (profile / "startup.log").exists() else ""
        # Reversed so the first occurrence of each mark wins over later navigations.
        result["startup_s"] = {k: float(v) for v, k in re.findall(r"^t=([\d.]+)s (\w+)", log, re.M)[::-1]}
        cdp = Cdp(port) if args.cdp else None
        time.sleep(args.settle)
        # Page milestones (first paint, content) arrive after the load; read them now too.
        late = (profile / "startup.log").read_text(errors="replace")
        for k, v in {k: float(v) for v, k in re.findall(r"^t=([\d.]+)s (\w+)", late, re.M)[::-1]}.items():
            result["startup_s"].setdefault(k, v)
        result["visible"] = sample(root, args.sample, cdp)
        user32.ShowWindow(main_window(child.pid), 6)  # SW_MINIMIZE
        time.sleep(args.settle)
        result["minimized"] = sample(root, args.sample, cdp)
    finally:
        if cdp:
            cdp.ws.close()
        if hwnd := main_window(child.pid):
            user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
        try:
            child.wait(15)
        except subprocess.TimeoutExpired:
            for proc in tree(root):
                proc.kill()
        psutil.wait_procs([p for p in tree(root) if p.is_running()], timeout=15)
    return result


def flatten(value, prefix=""):
    if isinstance(value, dict):
        return {k: v for key, inner in value.items() for k, v in flatten(inner, f"{prefix}{key}.").items()}
    return {prefix[:-1]: value}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--exe", action="append", required=True, help="label=path; repeat to compare builds")
    parser.add_argument("--settings", action="append", default=[], help="label=JSON written as that build's settings.json")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--settle", type=float, default=15, help="seconds before each sample")
    parser.add_argument("--sample", type=float, default=30, help="seconds per sample")
    parser.add_argument("--cdp", action="store_true", help="also record main-thread page metrics")
    parser.add_argument("--out", type=Path, default=ROOT / ".working" / "bench" / "results.json")
    args = parser.parse_args()
    builds = {label: str(Path(path).resolve()) for label, path in (item.split("=", 1) for item in args.exe)}
    for path in builds.values():
        if not Path(path).is_file():
            parser.error(f"missing build: {path}")
    settings = dict(item.split("=", 1) for item in args.settings)
    profiles = {label: ROOT / ".working" / "bench" / "profiles" / label for label in builds}
    runs = {label: [] for label in builds}
    for index in range(args.runs + 1):  # Run 0 warms each profile's cache and is discarded.
        for offset, (label, exe) in enumerate(builds.items()):
            print(f"run {index}/{args.runs} {label}", flush=True)
            try:
                result = run(exe, profiles[label], settings.get(label), args, 9301 + offset)
                if index:
                    runs[label].append(flatten(result))
            except Exception as error:
                print(f"  failed: {error}", flush=True)
    medians = {label: {k: statistics.median(r[k] for r in rs if k in r) for k in rs[0]} for label, rs in runs.items() if rs}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps({"runs": runs, "medians": medians}, indent=2))
    print(f"\n{'median':52}" + "".join(f"{label:>12}" for label in medians))
    for key in sorted({k for m in medians.values() for k in m}):
        print(f"{key:52}" + "".join(f"{m.get(key, float('nan')):>12.2f}" for m in medians.values()))


if __name__ == "__main__":
    main()
