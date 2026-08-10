#!/usr/bin/env python3
"""Build data/streets.geojson for the Sperrmüll map site.

Pipeline: scrape.py produces street/tour/date data; this script adds
geometry from OpenStreetMap (Overpass API) and merges everything into
one GeoJSON FeatureCollection consumable by the static site.

Matching: OSM ways in a bbox around Braunschweig are matched to the
scraped street names via a normalized form (lowercase, ß/ä/ö/ü -> ss/ae/oe/ue,
non-alphanumerics stripped), then filtered to ways whose centroid lies
inside the Braunschweig admin boundary (Nominatim). Multiple ways of the
same street are merged into one LineString.

Raw Overpass/Nominatim responses are cached in data/ so re-runs are offline.
"""

from __future__ import annotations

import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

DATA = Path(__file__).parent / "data"
OVERPASS_ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.osm.ch/api/interpreter",
]
BBOX = (52.12, 10.35, 52.38, 10.75)  # lat/lon box around Braunschweig
HIGHWAY_RE = r"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|path|track)$"
UA = "sperrmuell-bs-geodata/0.1"

# Same-name streets in different Stadtteile (Grenzweg, Eichenweg, Rosenweg …) and
# long arterials split across non-adjacent OSM ways (Celler Heerstraße,
# Salzdahlumer Straße …) would draw straight connectors if merged into one
# LineString. Ways are emitted as separate runs wherever two consecutive points
# are farther apart than this. Keep in sync with SPLIT_GAP_M in map.js.
SPLIT_GAP_M = 1000.0


def hav_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Haversine distance in meters; coords are (lon, lat)."""
    R = 6_371_000.0
    lon1, lat1, lon2, lat2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    dlon, dlat = lon2 - lon1, lat2 - lat1
    h = (math.sin(dlat / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2)
    return 2 * R * math.asin(math.sqrt(h))


def split_runs(line: list[tuple[float, float]]) -> list[list[tuple[float, float]]]:
    """Split a concatenated way line at gaps > SPLIT_GAP_M; drop runs with < 2 points."""
    runs: list[list[tuple[float, float]]] = []
    cur = [line[0]]
    for a, b in zip(line, line[1:]):
        if hav_m(a, b) > SPLIT_GAP_M:
            if len(cur) > 1:
                runs.append(cur)
            cur = [b]
        else:
            cur.append(b)
    if len(cur) > 1:
        runs.append(cur)
    return runs


def http_json(url: str, data: bytes | None = None, timeout: int = 300,
              tries: int = 3) -> dict:
    last: Exception | None = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except Exception as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise last  # type: ignore[misc]


def fetch_boundary() -> dict:
    """Braunschweig admin boundary as GeoJSON polygon."""
    cache = DATA / "bs_boundary.json"
    if cache.exists():
        return json.loads(cache.read_text())
    url = ("https://nominatim.openstreetmap.org/search"
           "?q=Braunschweig%2C%20Niedersachsen&format=json"
           "&polygon_geojson=1&limit=1&countrycodes=de&type=relation")
    place = http_json(url, timeout=60)[0]
    assert "Braunschweig" in place["display_name"], place["display_name"]
    gj = place["geojson"]
    cache.write_text(json.dumps(gj))
    time.sleep(1)  # Nominatim etiquette
    return gj


def fetch_ways() -> list[dict]:
    """All named roads in the bbox, from Overpass."""
    cache = DATA / "bs_ways_raw.json"
    if cache.exists():
        cached = json.loads(cache.read_text())
        return cached if isinstance(cached, list) else cached["elements"]
    q = ("[out:json][timeout:240];\n"
         f"(\n  way({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]})"
         f'["highway"~"{HIGHWAY_RE}"]["name"];\n'
         f"  way({BBOX[0]},{BBOX[1]},{BBOX[2]},{BBOX[3]})"
         f'["place"="square"]["name"];\n);\n'
         "out geom;")
    payload = urllib.parse.urlencode({"data": q}).encode()
    last: Exception | None = None
    for ep in OVERPASS_ENDPOINTS:
        try:
            data = http_json(ep, payload, tries=2)
            cache.write_text(json.dumps(data["elements"]))
            return data["elements"]
        except Exception as e:
            last = e
            print(f"  overpass {ep.split('/')[2]} failed: {str(e)[:80]}")
    raise last  # type: ignore[misc]


def norm(name: str) -> str:
    s = name.lower()
    s = s.replace("ß", "ss").replace("ä", "ae").replace("ö", "oe").replace("ü", "ue")
    return re.sub(r"[^a-z0-9]", "", s)


def rings_of(gj: dict) -> list[list[tuple[float, float]]]:
    """Outer rings of a (Multi)Polygon for point-in-polygon tests."""
    coords = gj["coordinates"] if gj["type"] == "Polygon" else [
        poly[0] for poly in gj["coordinates"]]
    return [[(lon, lat) for lon, lat in ring] for ring in coords]


def inside(pt: tuple[float, float], rings: list[list[tuple[float, float]]]) -> bool:
    """Ray casting, ignoring holes (tiny enclaves, irrelevant for streets)."""
    x, y = pt
    for ring in rings:
        hit = False
        for i in range(len(ring) - 1):
            (x1, y1), (x2, y2) = ring[i], ring[i + 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                hit = not hit
        if hit:
            return True
    return False


def main() -> None:
    streets = json.loads((DATA / "streets.json").read_text())
    names = json.loads((DATA / "street_names.json").read_text())
    tours = json.loads((DATA / "tours.json").read_text())

    print("fetching geometry data ...")
    boundary = fetch_boundary()
    rings = rings_of(boundary)
    ways = fetch_ways()
    print(f"  {len(ways)} ways in bbox")

    # group OSM ways by normalized name, keep those inside Braunschweig
    by_name: dict[str, list[list[tuple[float, float]]]] = {}
    kept = 0
    for w in ways:
        name = w.get("tags", {}).get("name")
        if not name:
            continue
        geom = [(p["lon"], p["lat"]) for p in w.get("geometry", [])]
        if not geom:
            continue
        cx = sum(p[0] for p in geom) / len(geom)
        cy = sum(p[1] for p in geom) / len(geom)
        if not inside((cx, cy), rings):
            continue
        kept += 1
        by_name.setdefault(norm(name), []).append(geom)
    print(f"  {kept} ways inside Braunschweig boundary")

    features = []
    unmatched = []
    for street in names:
        geoms = by_name.get(norm(street), [])
        if not geoms:
            unmatched.append(street)
            continue
        line = [pt for geom in geoms for pt in geom]
        runs = split_runs(line) or [line]
        geometry = (
            {"type": "LineString", "coordinates": runs[0]}
            if len(runs) == 1
            else {"type": "MultiLineString", "coordinates": runs}
        )
        tours_of = streets.get(street, {})
        props = {
            "name": street,
            "tours": tours_of,
            "dates": {t: [d["date"] for d in tours.get(t, [])] for t in tours_of},
        }
        features.append({
            "type": "Feature",
            "properties": props,
            "geometry": geometry,
        })

    fc = {"type": "FeatureCollection", "features": features}
    (DATA / "streets.geojson").write_text(json.dumps(fc, ensure_ascii=False))
    (DATA / "unmatched_streets.json").write_text(json.dumps(unmatched, ensure_ascii=False, indent=1))
    print(f"geojson: {len(features)}/{len(names)} streets mapped, {len(unmatched)} unmatched")
    if unmatched:
        print("  unmatched sample:", unmatched[:15])


if __name__ == "__main__":
    main()
