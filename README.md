# Sperrmüll Braunschweig

Map of the ALBA Braunschweig bulky-waste (Sperrmüll) collection dates — which of the 5 collection tours picks up on which day, across the whole city.

**Live map:** the GitHub Actions workflow (`.github/workflows/ci.yml`) scrapes the dates weekly (and on every push / manual run), merges them into the accumulated calendar, rebuilds `data/streets.geojson`, and deploys to GitHub Pages — the page shows all announced collections from today onward. For local preview, run `python3 -m http.server` in this directory and open `index.html`.

## How it works

The site is **fully static** — it renders `data/streets.geojson` with Leaflet. A date chip highlights the tour(s) collecting that day; clicking a street shows its tour, house-number range, and next dates.

The data is gathered in two steps, neither of which needs a server:

1. **`scrape.py`** — reverse-engineers ALBA's TYPO3 booking endpoint (`ajax-bulktrash.html`). Flow: street search (`ajaxlist`, min 3 chars, prefix match) → house numbers with a `mf-bulktrash-tour` id (`hnrlist`) → upcoming dates + remaining capacity (`datelist`). **Dates depend only on the tour id**, not the address; a street can span two tours. Braunschweig has exactly 5 tours: `1, 4, 7, 10, 60`.

   ```
   ./scrape.py enumerate   # discover all streets (3-char prefix search, ~24k requests)
   ./scrape.py streets     # street -> {tour: [house numbers]}
   ./scrape.py dates       # tour -> dates + capacity (verifies 2 extra addresses/tour)
   ./scrape.py all / report
   ```

   `data/streets.json` + `data/street_names.json` are committed (refreshed manually with `./scrape.py all` when ALBA changes the tours); CI only re-fetches the dates.

2. **`build_geodata.py`** — adds geometry: Overpass bbox query (named roads incl. paths/service ways) filtered to ways inside Braunschweig's admin boundary (Nominatim), matched to the scraped street names by a normalized form (~99.6% coverage). Writes `data/streets.geojson`.

3. **`merge_dates.py`** (CI) — ALBA only exposes a rolling window of upcoming dates. Each CI run captures that window and merges it into the calendar accumulated from previous runs (`merge_dates.py PREV.json NEW.json OUT.json`), keeping every announced date ≥ today, so dates don't fall off the map when they roll out of the booking window. Past dates are dropped; the newest scrape's capacity wins per date.

## Data files (`data/`)

| file | content |
|------|---------|
| `streets.geojson` | the site's data — street geometry + tours + dates per tour |
| `streets.json` | scraped street → `{tour: [house numbers]}` |
| `tours.json` | scraped tour → `[{date, capacity_left}]` |
| `street_names.json` | flat list of all streets |
| `streets_raw.json` | enumeration cache (prefix → streets) |

## Notes

- Live client-side retrieval from alba-bs.de is blocked by CORS, hence the static two-step pipeline.
- The 15 streets spanning two tours are drawn with one line (first tour's color); the popup lists both tours.
- Overpass public mirrors are flaky — `build_geodata.py` falls back across endpoints and caches raw responses in `data/` (gitignored).

Data source: [alba-bs.de](https://alba-bs.de/service/abfallentsorgung/sperrmuell/shop/product/sperrmuell-bestellung.html) · map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL.
