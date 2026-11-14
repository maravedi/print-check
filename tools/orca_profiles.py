#!/usr/bin/env python3
"""Flatten OrcaSlicer system profiles (resolve the `inherits` chain) for the two
supported printers, so the CLI can slice with them and the web app can read
their speeds.

Usage:
    python3 tools/orca_profiles.py --out tools/.orca-flat     # writes flat JSONs
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

PROFILES = Path("/Applications/OrcaSlicer.app/Contents/Resources/profiles")

# printer id -> (vendor dir, machine, process, filament)
PRINTERS = {
    "p1s": ("BBL", "Bambu Lab P1S 0.4 nozzle", "0.20mm Standard @BBL X1C",
            "Bambu PLA Basic @BBL X1C"),
    "ad5m": ("Flashforge", "Flashforge Adventurer 5M 0.4 Nozzle",
             "0.20mm Standard @Flashforge AD5M 0.4 Nozzle", "Flashforge Generic PLA"),
}


def _index(vendor: str) -> dict[str, Path]:
    idx: dict[str, Path] = {}
    for root in (PROFILES / vendor, PROFILES / "OrcaFilamentLibrary"):
        for p in root.rglob("*.json"):
            try:
                name = json.loads(p.read_text()).get("name")
            except (json.JSONDecodeError, UnicodeDecodeError):
                continue
            if name:
                idx.setdefault(name, p)
    return idx


def resolve(name: str, idx: dict[str, Path]) -> dict:
    if name not in idx:
        raise SystemExit(f"profile not found: {name}")
    data = json.loads(idx[name].read_text())
    parent = data.get("inherits")
    merged = resolve(parent, idx) if parent else {}
    merged.update(data)
    merged.pop("inherits", None)
    return merged


def flatten(printer: str) -> dict[str, dict]:
    vendor, machine, process, filament = PRINTERS[printer]
    idx = _index(vendor)
    out = {}
    for kind, name in (("machine", machine), ("process", process), ("filament", filament)):
        d = resolve(name, idx)
        d["from"] = "system"
        d["name"] = f"precheck-{printer}-{kind}"
        if kind != "machine":
            d["compatible_printers"] = [f"precheck-{printer}-machine"]
            d["compatible_printers_condition"] = ""
        out[kind] = d
    out["process"]["print_settings_id"] = out["process"]["name"]
    out["filament"]["filament_settings_id"] = [out["filament"]["name"]]
    out["machine"]["printer_settings_id"] = out["machine"]["name"]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).parent / ".orca-flat"))
    args = ap.parse_args()
    outdir = Path(args.out)
    outdir.mkdir(parents=True, exist_ok=True)
    for printer in PRINTERS:
        for kind, d in flatten(printer).items():
            (outdir / f"{printer}-{kind}.json").write_text(json.dumps(d, indent=1))
    print(f"wrote flat profiles to {outdir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
