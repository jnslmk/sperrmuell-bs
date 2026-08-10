#!/usr/bin/env python3
"""Scrape ALBA Braunschweig Sperrmüll collection dates per tour.

Reverse-engineered booking flow (TYPO3 shop, extension mf_bulktrash):

    1. ajaxlist   POST street search (min 3 chars, case-insensitive
                  PREFIX match on the street name) -> street names
    2. hnrlist    GET per street -> house numbers, each carrying a
                  `mf-bulktrash-tour` id (the collection zone)
    3. datelist   GET per (street, house number, tour) -> upcoming dates
                  with remaining booking capacity

Dates depend only on the tour id; a street can span several tours.
All requests work without cookies/session; the GET endpoints ignore the
cHash parameter entirely (verified), so links can be built directly.

State lives in ./data and is incremental: interrupted runs resume.

Usage:
    ./scrape.py enumerate   # 1. discover all streets (3-char prefix search)
    ./scrape.py streets     # 2. street -> {tour: [house numbers]}
    ./scrape.py dates       # 3. tour -> dates + capacity (with verification)
    ./scrape.py all         # steps 1-3
    ./scrape.py report      # summary of collected data
"""

from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

BASE = "https://alba-bs.de"
PRODUCT_URL = BASE + "/service/abfallentsorgung/sperrmuell/shop/product/sperrmuell-bestellung.html"
AJAX_URL = BASE + "/service/abfallentsorgung/sperrmuell/shop/ajax-bulktrash.html"
PAGE_ID = "135"  # TYPO3 page id observed on the product page form

DATA = Path(__file__).parent / "data"
STREETS_RAW = DATA / "streets_raw.json"    # {prefix: [street names]}
STREET_NAMES = DATA / "street_names.json"  # [street names] (deduped)
STREETS = DATA / "streets.json"            # {street: {tour: [hnr[+zusatz], ...]}}
TOURS = DATA / "tours.json"                # {tour: [{"date", "capacity_left"}, ...]}
META = DATA / "meta.json"
FAILURES = DATA / "failures.log"

UA = "Mozilla/5.0 (X11; Linux x86_64) sperrmuell-bs-scraper"
WORKERS = 16
TIMEOUT = 30
RETRIES = 3
# ponytail: flat enumeration over all 3-char prefixes (~24k requests). A
# cheaper 2-char search is blocked server-side (min 3 chars) and a trie walk
# cannot prune without queries, so this is the smallest complete set.
PREFIX_ALPHABET = "abcdefghijklmnopqrstuvwxyzäöü"
FAKE_CHASH = "cHash=00000000000000000000000000000000"  # ignored by the server


# --------------------------------------------------------------------------
# HTTP + parsing
# --------------------------------------------------------------------------

class Client:
    def __init__(self) -> None:
        self.form = self._load_form()

    def _load_form(self) -> dict:
        """GET the product page, extract the ajax cHash + hidden fields."""
        page = self.get(PRODUCT_URL)
        action = re.search(r'action="([^"]*ajax-bulktrash[^"]*)"', page)
        if not action:
            raise RuntimeError("ajax-bulktrash form action not found on product page")
        self.c_hash = re.search(r"cHash=([0-9a-f]+)", action.group(1)).group(1)
        form = re.search(r'<form id="mf-bulktrash-form"[\s\S]*?</form>', page).group(0)
        return dict(re.findall(r'<input type="hidden" name="([^"]+)" value="([^"]*)">', form))

    def get(self, url: str, data: bytes | None = None) -> str:
        last_err: Exception | None = None
        for attempt in range(RETRIES):
            try:
                req = urllib.request.Request(url, data=data, headers={
                    "User-Agent": UA,
                    "Referer": PRODUCT_URL,
                    "Content-Type": "application/x-www-form-urlencoded",
                })
                with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                    return resp.read().decode("utf-8", "replace")
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
                last_err = e
                if attempt < RETRIES - 1:
                    time.sleep(0.5 * (2 ** attempt) + random.random() * 0.3)
        raise last_err  # type: ignore[misc]

    # -- endpoints ---------------------------------------------------------

    def ajaxlist(self, term: str) -> list[str]:
        """POST the street search; returns matching street names."""
        post = dict(self.form)
        post["mf-bulktrash-search"] = term
        url = (AJAX_URL
               + "?tx_mfbulktrash_mfbulktrash%5Baction%5D=ajaxlist"
               + "&tx_mfbulktrash_mfbulktrash%5Bcontroller%5D=Bulktrash"
               + "&cHash=" + self.c_hash
               + "&tx_mfbulktrash_mfbulktrash%5Bmf-bulktrash-search%5D=" + urllib.parse.quote(term)
               + "&id=" + PAGE_ID)
        html = self.get(url, urllib.parse.urlencode(post).encode())
        return re.findall(r'class="mf-bulktrash-street"[^>]*>\s*([^<]+?)\s*<', html)

    def hnrlist(self, street: str) -> list[dict]:
        """GET house numbers for a street (each: street, hnr, zusatz, tour)."""
        url = (AJAX_URL
               + "?tx_mfbulktrash_mfbulktrash%5Baction%5D=hnrlist"
               + "&tx_mfbulktrash_mfbulktrash%5Bcontroller%5D=Bulktrash"
               + "&tx_mfbulktrash_mfbulktrash%5Bmf-bulktrash-street%5D=" + urllib.parse.quote(street)
               + "&" + FAKE_CHASH)
        html = self.get(url)
        out = []
        for m in re.finditer(
                r'class="mf-bulktrash-street-nr"[^>]*href="([^"]*)"[^>]*>\s*([^<]+?)\s*</a>', html):
            q = urllib.parse.parse_qs(
                urllib.parse.urlparse(m.group(1).replace("&amp;", "&")).query)
            out.append({
                "street": q.get("tx_mfbulktrash_mfbulktrash[mf-bulktrash-street]", [""])[0],
                "label": m.group(2).strip(),
                "hnr": q.get("tx_mfbulktrash_mfbulktrash[mf-bulktrash-hnr]", [""])[0],
                "zusatz": q.get("tx_mfbulktrash_mfbulktrash[mf-bulktrash-hausnrzusatz]", [""])[0],
                "tour": q.get("tx_mfbulktrash_mfbulktrash[mf-bulktrash-tour]", [""])[0],
            })
        return out

    def datelist(self, street: str, hnr: str, zusatz: str, tour: str) -> list[dict]:
        """GET upcoming dates + remaining capacity for one address."""
        url = (AJAX_URL
               + "?tx_mfbulktrash_mfbulktrash%5Baction%5D=datelist"
               + "&tx_mfbulktrash_mfbulktrash%5Bcontroller%5D=Bulktrash"
               + "&tx_mfbulktrash_mfbulktrash%5Bmf-bulktrash-hausnrzusatz%5D=" + urllib.parse.quote(zusatz)
               + "&tx_mfbulktrash_mfbulktrash%5Bmf-bulktrash-hnr%5D=" + urllib.parse.quote(hnr)
               + "&tx_mfbulktrash_mfbulktrash%5Bmf-bulktrash-street%5D=" + urllib.parse.quote(street)
               + "&tx_mfbulktrash_mfbulktrash%5Bmf-bulktrash-tour%5D=" + tour
               + "&" + FAKE_CHASH)
        html = self.get(url)
        out = []
        for m in re.finditer(
                r'href="([^"]*mf-bulktrash-date%5D=[^"]*)"[^>]*>([\s\S]*?)</a>', html):
            href, inner = m.group(1).replace("&amp;", "&"), m.group(2)
            date = re.search(r"mf-bulktrash-date%5D=(\d{4}-\d{2}-\d{2})", href)
            cap = re.search(r"Noch (\d+) Sperrm", inner)
            if date:
                out.append({"date": date.group(1),
                            "capacity_left": int(cap.group(1)) if cap else None})
        return out


# --------------------------------------------------------------------------
# Steps
# --------------------------------------------------------------------------

def load(path: Path, default):
    return json.loads(path.read_text()) if path.exists() else default


def save(path: Path, obj) -> None:
    path.parent.mkdir(exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1))
    tmp.replace(path)


def log_failure(kind: str, what: str, err: Exception) -> None:
    with FAILURES.open("a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {kind} {what!r}: {err}\n")


def run_pool(items, fetch, on_result, chunk: int):
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(fetch, it): it for it in items}
        for i, fut in enumerate(as_completed(futs), 1):
            on_result(*fut.result())
            if i % chunk == 0:
                print(f"  {i}/{len(items)}", flush=True)
            time.sleep(0.02)  # politeness


def step_enumerate() -> None:
    """Discover every street via all 3-char prefixes."""
    client = Client()
    raw = load(STREETS_RAW, {})
    prefixes = [a + b + c for a in PREFIX_ALPHABET
                for b in PREFIX_ALPHABET
                for c in PREFIX_ALPHABET]
    todo = [p for p in prefixes if p not in raw]
    print(f"enumerate: {len(prefixes) - len(todo)}/{len(prefixes)} prefixes done, {len(todo)} to go")

    def fetch(p: str) -> tuple[str, list[str]]:
        try:
            return p, client.ajaxlist(p)
        except Exception as e:
            log_failure("ajaxlist", p, e)
            return p, []

    def on_result(p: str, streets: list[str]) -> None:
        raw[p] = streets
        if len(raw) % 1000 == 0:
            save(STREETS_RAW, raw)

    run_pool(todo, fetch, on_result, chunk=1000)
    save(STREETS_RAW, raw)
    all_streets = sorted({s for v in raw.values() for s in v})
    save(STREET_NAMES, all_streets)
    print(f"enumerate: {len(all_streets)} unique streets")


def step_streets() -> None:
    """Resolve every street to its {tour: [house numbers]} mapping."""
    client = Client()
    names = load(STREET_NAMES, [])
    if not names:
        sys.exit("no street list; run 'enumerate' first")
    current = load(STREETS, {})
    todo = [n for n in names if n not in current]
    print(f"streets: {len(current)}/{len(names)} done, {len(todo)} to go")

    def fetch(name: str) -> tuple[str, dict]:
        try:
            by_tour: dict[str, list[str]] = {}
            for e in client.hnrlist(name):
                key = e["hnr"] + (e["zusatz"] or "")
                by_tour.setdefault(e["tour"], []).append(key)
            return name, by_tour
        except Exception as e:
            log_failure("hnrlist", name, e)
            return name, {}

    def on_result(name: str, by_tour: dict) -> None:
        if by_tour:
            current[name] = by_tour
        if len(current) % 100 == 0:
            save(STREETS, current)

    run_pool(todo, fetch, on_result, chunk=500)
    save(STREETS, current)
    tours = sorted({t for v in current.values() for t in v}, key=int)
    print(f"streets: {len(current)} streets mapped, {len(tours)} distinct tours: {tours}")
    missing = [n for n in names if n not in current]
    if missing:
        print(f"  WARNING: {len(missing)} streets unresolved: {missing[:10]}")


def step_dates() -> None:
    """Fetch dates + capacity per tour, then verify a second address per tour."""
    client = Client()
    streets = load(STREETS, {})
    if not streets:
        sys.exit("no street mapping; run 'streets' first")
    # one address per tour as the canonical sample
    pick: dict[str, tuple[str, str]] = {}
    for name, by_tour in streets.items():
        for tour, hnrs in by_tour.items():
            if tour not in pick and hnrs:
                pick[tour] = (name, hnrs[0])
    tours = load(TOURS, {})
    todo = [t for t in pick if t not in tours]
    print(f"dates: {len(tours)}/{len(pick)} tours done, {len(todo)} to go")

    def fetch(tour: str) -> tuple[str, list[dict]]:
        name, hnr = pick[tour]
        try:
            return tour, client.datelist(name, hnr, "", tour)
        except Exception as e:
            log_failure("datelist", f"tour {tour} ({name} {hnr})", e)
            return tour, []

    def on_result(tour: str, dates: list[dict]) -> None:
        if dates:
            tours[tour] = dates
        if len(tours) % 5 == 0:
            save(TOURS, tours)

    run_pool(todo, fetch, on_result, chunk=100)
    save(TOURS, tours)

    # verification: dates must be identical across addresses in the same tour
    mismatches = []
    for tour, dates in tours.items():
        verified = 0
        for name, by_tour in streets.items():
            if tour not in by_tour:
                continue
            for hnr in by_tour[tour][:1]:
                try:
                    d2 = client.datelist(name, hnr, "", tour)
                    if [d["date"] for d in d2] != [d["date"] for d in dates]:
                        mismatches.append((tour, name, hnr))
                except Exception as e:
                    log_failure("verify", f"tour {tour} ({name} {hnr})", e)
                verified += 1
                if verified >= 2:
                    break
            if verified >= 2:
                break
    if mismatches:
        print(f"  WARNING: {len(mismatches)} addresses with different dates: {mismatches}")
    print(f"dates: {len(tours)} tours, each with {len(next(iter(tours.values()), []))} dates")


def step_report() -> None:
    names = load(STREET_NAMES, [])
    streets = load(STREETS, {})
    tours = load(TOURS, {})
    print(f"streets: {len(names)} total, {len(streets)} with tour mapping")
    print(f"tours:   {len(tours)}")
    for tour in sorted(tours, key=int):
        dates = tours[tour]
        print(f"  tour {tour}: {len(dates)} dates, "
              f"{dates[0]['date']} .. {dates[-1]['date']}"
              f"{'  (example: ' + dates[0]['date'] + ', cap ' + str(dates[0]['capacity_left']) + ')' if dates else ''}")
    by_tour: dict[str, int] = {}
    for v in streets.values():
        for t in v:
            by_tour[t] = by_tour.get(t, 0) + 1
    print("streets per tour:", dict(sorted(by_tour.items(), key=lambda kv: int(kv[0]))))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["enumerate", "streets", "dates", "all", "report"])
    args = ap.parse_args()

    if args.step in ("enumerate", "all"):
        step_enumerate()
    if args.step in ("streets", "all"):
        step_streets()
    if args.step in ("dates", "all"):
        step_dates()
    if args.step == "report":
        step_report()

    save(META, {"fetched_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "product_url": PRODUCT_URL,
                "note": "dates are per tour; street->tour mapping in streets.json"})


if __name__ == "__main__":
    main()
