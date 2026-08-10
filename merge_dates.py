#!/usr/bin/env python3
"""Merge fresh ALBA scrape findings into the accumulated Sperrmüll calendar.

ALBA only exposes a rolling window of upcoming collection dates; each CI run
captures that window.  This script merges the new window into the calendar
accumulated from previous runs, keeping every announced date >= today, so a
date does not vanish from the map when it rolls out of the booking window.

Usage:  merge_dates.py PREV.json NEW.json OUT.json
(PREV may be missing; per date, the newest scrape's capacity wins.)
"""

from __future__ import annotations

import json
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("Europe/Berlin")


def merge(prev: dict, new: dict, today: str) -> dict:
    """Union of per-tour dates >= today; newest capacity wins per date."""
    out: dict[str, list[dict]] = {}
    for tour in sorted(set(prev) | set(new), key=int):
        by_date: dict[str, int | None] = {}
        for d in prev.get(tour, []):          # older runs: keep announced dates
            by_date[d["date"]] = d.get("capacity_left")
        for d in new.get(tour, []):           # fresh run overrides capacity
            by_date[d["date"]] = d.get("capacity_left")
        out[tour] = [{"date": d, "capacity_left": c}
                     for d, c in sorted(by_date.items()) if d >= today]
    return out


def main(argv: list[str]) -> int:
    if "--check" in argv:
        _check()
        print("merge_dates: self-check ok")
        return 0
    prev_path, new_path, out_path = argv[1:4]
    prev = json.loads(Path(prev_path).read_text()) if Path(prev_path).exists() else {}
    new = json.loads(Path(new_path).read_text())
    if not new or not any(new.values()):
        print("error: new findings contain no dates; refusing to drop the calendar")
        return 1
    out = merge(prev, new, datetime.now(TZ).date().isoformat())
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    Path(out_path).write_text(json.dumps(out, ensure_ascii=False, indent=1) + "\n")
    print(f"merge: {len(out)} tours, {sum(len(v) for v in out.values())} dates from today")
    return 0


def _check() -> None:
    prev = {"1": [{"date": "2026-01-05", "capacity_left": 3},   # past: dropped
                  {"date": "2026-09-01", "capacity_left": 5}]}
    new = {"1": [{"date": "2026-09-01", "capacity_left": 2},   # fresh capacity wins
                 {"date": "2026-10-05", "capacity_left": 9}],
           "4": [{"date": "2026-09-02", "capacity_left": 1}]}
    got = merge(prev, new, "2026-08-10")
    assert got == {"1": [{"date": "2026-09-01", "capacity_left": 2},
                         {"date": "2026-10-05", "capacity_left": 9}],
                   "4": [{"date": "2026-09-02", "capacity_left": 1}]}, got


if __name__ == "__main__":
    sys.exit(main(sys.argv))
