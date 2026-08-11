#!/usr/bin/env python3
"""Build per-tour iCalendar (.ics) feeds from data/tours.json.

One file per tour (data/tour-<id>.ics) with an all-day event per announced
collection date, so visitors can subscribe ("webcal") in their calendar app.
Dates exist per tour only; a street maps to a tour via streets.json.

UIDs are deterministic (tour + date), so weekly re-scrapes update events in
subscribed calendars instead of duplicating them.
"""

import json
import sys
from datetime import date, datetime, timezone
from pathlib import Path

DATA = Path(__file__).parent / "data"
SITE = "https://jnslmk.github.io/sperrmuell-bs/"
PRODID = "-//Sperrmüll Braunschweig//Tour-Feeds//DE"


def esc(text: str) -> str:
    """RFC 5545 text escaping."""
    return text.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,")


def fold(text: str) -> str:
    """Fold a content line to <=75 octets per RFC 5545 (continuation: CRLF + space)."""
    if len(text) <= 75:
        return text
    parts = [text[:75]]
    rest = text[75:]
    while len(rest) > 74:
        parts.append(rest[:74])
        rest = rest[74:]
    parts.append(rest)
    return "\r\n ".join(parts)


def build_feed(tour: str, dates: list[str], stamped: str) -> str:
    calname = f"Sperrmüll Braunschweig · Tour {tour}"
    summary = f"Sperrmüll-Abholung Tour {tour}"
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:" + PRODID,
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "X-WR-CALNAME:" + esc(calname),
    ]
    for iso in dates:
        y, m, d = iso.split("-")
        lines += [
            "BEGIN:VEVENT",
            f"UID:sperrmuell-bs-tour-{tour}-{iso}@jnslmk.github.io",
            "DTSTAMP:" + stamped,
            f"DTSTART;VALUE=DATE:{y}{m}{d}",
            "SUMMARY:" + esc(summary),
            "DESCRIPTION:" + esc("Weitere Infos: " + SITE),
            "URL:" + SITE,
            "END:VEVENT",
        ]
    lines.append("END:VCALENDAR")
    return "\r\n".join(fold(l) for l in lines) + "\r\n"


def check(feed: str, tour: str, dates: list[str]) -> None:
    """Self-check: aborts the build if the feed violates the format rules."""
    assert feed.endswith("\r\n"), "feed must end with CRLF"
    assert "\n" not in feed.replace("\r\n", ""), "line endings must be CRLF"
    assert "BEGIN:VCALENDAR" in feed and "END:VCALENDAR" in feed
    uids = [l for l in feed.split("\r\n") if l.startswith("UID:")]
    assert len(uids) == len(set(uids)), "UIDs must be unique per tour+date"
    for iso in dates:
        y, m, d = iso.split("-")
        assert f"DTSTART;VALUE=DATE:{y}{m}{d}" in feed, f"missing DTSTART for {iso}"
    assert "VALARM" not in feed, "no reminders by design"


def main() -> int:
    tours = json.loads((DATA / "tours.json").read_text())
    today = date.today().isoformat()
    stamped = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for tour in sorted(tours, key=int):
        dates = sorted(d["date"] for d in tours[tour] if d["date"] >= today)
        feed = build_feed(tour, dates, stamped)
        check(feed, tour, dates)
        (DATA / f"tour-{tour}.ics").write_text(feed)
        print(f"tour {tour}: {len(dates)} dates -> data/tour-{tour}.ics")
    return 0


if __name__ == "__main__":
    sys.exit(main())
