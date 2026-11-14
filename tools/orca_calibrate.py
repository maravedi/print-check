#!/usr/bin/env python3
"""Ground truth for the web estimator: slice STLs with OrcaSlicer's real P1S and
AD5M PLA profiles (supports on, as students' prints will be) and record the
slicer's own time estimates.

Usage:
    python3 tools/orca_calibrate.py STL [STL ...] [--scales 1,0.6,0.4] [--out tools/calibration.json]
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ORCA = "/Applications/OrcaSlicer.app/Contents/MacOS/OrcaSlicer"
FLAT = Path(__file__).parent / ".orca-flat"


def hms(s: str) -> float:
    total = 0.0
    for num, unit in re.findall(r"(\d+)([dhms])", s):
        total += int(num) * {"d": 86400, "h": 3600, "m": 60, "s": 1}[unit]
    return total


def with_supports(printer: str, tmp: Path) -> Path:
    p = json.loads((FLAT / f"{printer}-process.json").read_text())
    p["enable_support"] = "1"
    p["support_type"] = "tree(auto)"
    out = tmp / f"{printer}-process-sup.json"
    out.write_text(json.dumps(p))
    return out


def slice_one(stl: Path, printer: str, scale: float) -> dict:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        proc = with_supports(printer, tmp)
        cmd = [ORCA, "--debug", "2", "--logfile", str(tmp / "o.log"), "--arrange", "1",
               "--orient", "0", "--ensure-on-bed", "--scale", str(scale), "--slice", "0",
               "--load-settings", f"{FLAT / f'{printer}-machine.json'};{proc}",
               "--load-filaments", str(FLAT / f"{printer}-filament.json"),
               "--outputdir", str(tmp), str(stl)]
        rc = subprocess.run(cmd, capture_output=True, timeout=900).returncode
        rec = {"file": stl.name, "printer": printer, "scale": scale, "rc": rc}
        gcodes = list(tmp.glob("*.gcode"))
        if not gcodes:
            rec["error"] = (tmp / "o.log").read_text(errors="replace")[-400:]
            return rec
        head = gcodes[0].read_text(errors="replace")
        m = re.search(r"model printing time: ([^;]+); total estimated time: (.+)", head)
        if m:
            rec["model_s"], rec["total_s"] = hms(m.group(1)), hms(m.group(2))
        elif (m := re.search(r"estimated printing time \(normal mode\) = (.+)", head)):
            rec["model_s"] = rec["total_s"] = hms(m.group(1))
        if (m := re.search(r"total layer number: (\d+)", head)):
            rec["layers"] = int(m.group(1))
        if (m := re.search(r"filament used \[mm\] = ([\d.]+)", head)):
            rec["filament_mm"] = float(m.group(1))
        return rec


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("stls", nargs="+")
    ap.add_argument("--scales", default="1")
    ap.add_argument("--printers", default="p1s,ad5m")
    ap.add_argument("--out", default=str(Path(__file__).parent / "calibration.json"))
    args = ap.parse_args()
    jobs = [(Path(s), p, float(k)) for s in args.stls for p in args.printers.split(",")
            for k in args.scales.split(",")]
    with ThreadPoolExecutor(max_workers=4) as ex:
        results = list(ex.map(lambda j: slice_one(*j), jobs))
    Path(args.out).write_text(json.dumps(results, indent=1))
    for r in results:
        t = f"{r.get('model_s', 0) / 60:6.1f} min" if "model_s" in r else "ERROR"
        print(f"{r['printer']:5} x{r['scale']:<4} {t}  {r['file']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
