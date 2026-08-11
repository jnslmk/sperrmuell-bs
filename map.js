/* Sperrmüll Braunschweig — Variante B: Editorial.
   Daten: ../../data/streets.geojson (Straßengeometrie + Tour + Termine je Tour).
   Termine gelten pro Tour: ein Datum hebt jede Tour hervor, die an diesem Tag fährt. */

"use strict";

const TOURS = ["1", "4", "7", "10", "60"];

/* Rückfallwerte, falls der Browser die oklch()-Tokens nicht in ein
   Canvas-taugliches Format auflöst. */
const TOUR_FALLBACK = {
  1: "#9c412f",
  4: "#2c5789",
  7: "#2b6a5c",
  10: "#8f6113",
  60: "#65477c",
};
const FADED_FALLBACK = "#7d7168";

const FADED_WEIGHT = 1.3;
const FADED_OPACITY = 0.45;
const LIVE_WEIGHT = 3.4;
const STORE_KEY = "sperrmuell-bs:editorial:date";
const SRC = "data/streets.geojson";

/* Geometry split: streets.geojson concatenates all OSM ways sharing a name into
   one LineString. Same-name streets in different Stadtteile (Grenzweg, Eichenweg,
   Rosenweg …) or long arterials (Celler Heerstraße, Salzdahlumer Straße …) then
   draw straight connectors between fragments. Splitting wherever two consecutive
   coordinates are farther apart than SPLIT_GAP_M renders each run separately.
   Threshold in meters — raise it if a real road gets fragmented, lower it if
   connectors reappear (checked on the live map: 1000 m removes every visible
   connector while keeping all continuous roads intact). */
const SPLIT_GAP_M = 1000;

/* Returns a LineString for unsplit geometries, a MultiLineString when the
   coordinates contain runs separated by gaps > SPLIT_GAP_M. Runs with fewer
   than 2 points are dropped (isolated OSM points are noise). */
function splitGeometry(coords) {
  const runs = [];
  let cur = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    if (L.latLng(a[1], a[0]).distanceTo(L.latLng(b[1], b[0])) > SPLIT_GAP_M) {
      if (cur.length > 1) runs.push(cur);
      cur = [b];
    } else {
      cur.push(b);
    }
  }
  if (cur.length > 1) runs.push(cur);
  if (runs.length <= 1) return null; // nothing to split
  return { type: "MultiLineString", coordinates: runs };
}

const DOW = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const DOW_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"];

let TOUR_COLORS = {};
let FADED = FADED_FALLBACK;

let map;
let layer = null;
let features = [];
let selected = null;   // ISO-Datum oder null (= alle Touren)
let hoverTour = null;  // Tour unter dem Zeiger / Fokus
let tourStats = {};    // Tour -> {count, next}
let allDates = [];
const tourDates = {};  // Tour -> sortierte ISO-Daten
let attempts = 0;
let slowTimer = null;

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* Abonnier-Link je Tour: webcal://…/data/tour-<id>.ics — abgeleitet aus der
   aktuellen URL, funktioniert lokal und auf GitHub Pages. */
const calUrl = (tour) =>
  new URL(`data/tour-${tour}.ics`, location.href).href.replace(/^https?:/, "webcal:");

/* ---------- Datum ---------- */

const asDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const fmtDate = (iso) => { const [, m, d] = iso.split("-"); return `${d}.${m}.`; };
const fmtFull = (iso) => { const [y, m, d] = iso.split("-"); return `${d}.${m}.${y}`; };
const fmtLong = (iso) => {
  const dt = asDate(iso);
  return `${DOW_LONG[dt.getDay()]}, ${dt.getDate()}. ${MONTHS[dt.getMonth()]} ${dt.getFullYear()}`;
};
const num = (n) => n.toLocaleString("de-DE");

/* ---------- Farben aus den CSS-Tokens ---------- */

function resolveColors() {
  const probe = document.createElement("span");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  document.body.appendChild(probe);

  const ctx = document.createElement("canvas").getContext("2d");
  const usable = (value) => {
    if (!value) return false;
    ctx.strokeStyle = "#010101";
    ctx.strokeStyle = value;          // ungültige Werte lässt Canvas fallen
    return ctx.strokeStyle !== "#010101";
  };
  const read = (token, fallback) => {
    probe.style.color = "";
    probe.style.color = `var(${token})`;
    const value = getComputedStyle(probe).color;
    return usable(value) ? value : fallback;
  };

  for (const t of TOURS) TOUR_COLORS[t] = read(`--tour-${t}`, TOUR_FALLBACK[t]);
  FADED = read("--muted", FADED_FALLBACK);
  probe.remove();
}

/* ---------- Karte ---------- */

function initMap() {
  map = L.map("map", { preferCanvas: true, zoomControl: false });
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  }).addTo(map);

  const container = map.getContainer();
  map.on("popupopen", () => container.classList.add("has-popup"));
  map.on("popupclose", () => container.classList.remove("has-popup"));
}

const tourOf = (feature) => Object.keys(feature.properties.tours)[0];

const picksUpOn = (feature, iso) =>
  Object.values(feature.properties.dates).some((list) => list.includes(iso));

function styleFor(feature) {
  if (hoverTour !== null) {
    return tourOf(feature) === hoverTour
      ? { color: TOUR_COLORS[hoverTour], weight: 4.4, opacity: 0.95 }
      : { color: FADED, weight: FADED_WEIGHT, opacity: FADED_OPACITY };
  }
  const active = !selected || picksUpOn(feature, selected);
  return active
    ? { color: TOUR_COLORS[tourOf(feature)], weight: LIVE_WEIGHT, opacity: 0.95 }
    : { color: FADED, weight: FADED_WEIGHT, opacity: FADED_OPACITY };
}

/* ---------- Popup & Tooltip ---------- */

function hnrRange(list) {
  if (!list || !list.length) return "—";
  const n = (s) => parseInt(String(s).match(/\d+/)?.[0] ?? "0", 10);
  const sorted = [...list].sort((a, b) => n(a) - n(b) || String(a).localeCompare(String(b), "de"));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return first === last ? esc(first) : `${esc(first)}–${esc(last)}`;
}

function popupFor(feature) {
  const p = feature.properties;
  const rows = Object.entries(p.tours).map(([tour, hnrs]) => {
    const dates = p.dates[tour] || [];
    const shown = dates.slice(0, 4).map(fmtDate).join(" · ");
    const more = dates.length > 4 ? `<span class="pop-more">+ ${dates.length - 4} weitere Termine</span>` : "";
    return `<div class="pop-row">
      <div class="pop-head">
        <span class="ink dot" data-tour="${esc(tour)}"></span>
        <span class="pop-tour">Tour ${esc(tour)}</span>
        <span class="pop-hnr">Hausnr. ${hnrRange(hnrs)} · ${hnrs.length} Nrn.</span>
      </div>
      <span class="pop-label">Termine</span>
      <p class="pop-dates">${shown || "keine Termine"}${more}</p>
    </div>`;
  }).join("");
  return `<article class="pop">
    <p class="pop-kicker">Straßenzug</p>
    <h3 class="pop-name">${esc(p.name)}</h3>
    ${rows}
  </article>`;
}

function tooltipFor(feature) {
  const tour = tourOf(feature);
  const dates = (tourDates[tour] || []).map(fmtDate).join(" · ");
  return `<div class="tip-head">
      <span class="ink dot" data-tour="${esc(tour)}"></span>
      <span class="tip-name">${esc(feature.properties.name)}</span>
      <span class="tip-tour">Tour ${esc(tour)}</span>
    </div>
    <div class="tip-dates">${dates || "keine Termine"}</div>`;
}

/* ---------- Terminkalender ---------- */

function makeChip(iso, pressed) {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.iso = iso ?? "";
  b.setAttribute("aria-pressed", String(pressed));
  if (iso === null) {
    b.className = "chip-all";
    b.textContent = "Alle Termine anzeigen";
    b.title = "Alle Touren anzeigen";
  } else {
    b.className = "chip" + (iso === allDates[0] ? " chip-next" : "");
    b.title = iso === allDates[0] ? `${fmtLong(iso)} — nächster Termin` : fmtLong(iso);
    const dt = asDate(iso);
    b.innerHTML = `<span class="chip-dow">${DOW[dt.getDay()]}</span>` +
      `<span class="chip-day">${String(dt.getDate()).padStart(2, "0")}</span>`;
  }
  b.addEventListener("click", () => selectDate(iso));
  return b;
}

function buildChips() {
  const chipsEl = el("chips");
  chipsEl.innerHTML = "";

  if (!allDates.length) {
    chipsEl.innerHTML = `<p class="empty-note">
      <strong>Zurzeit keine Termine veröffentlicht.</strong>
      Die ALBA gibt neue Sperrmülltermine meist wenige Wochen im Voraus frei.
      Die Karte zeigt weiterhin alle Straßen mit ihrer Tourzuordnung.</p>`;
    return;
  }

  chipsEl.appendChild(makeChip(null, selected === null));

  let current = null;
  let grid = null;
  for (const iso of allDates) {
    const dt = asDate(iso);
    const key = `${dt.getFullYear()}-${dt.getMonth()}`;
    if (key !== current) {
      current = key;
      const month = document.createElement("div");
      month.className = "month";
      const count = allDates.filter((d) => {
        const o = asDate(d);
        return `${o.getFullYear()}-${o.getMonth()}` === key;
      }).length;
      month.innerHTML = `<h3 class="month-head">${MONTHS[dt.getMonth()]} ${dt.getFullYear()}
        <span class="month-n">${count} ${count === 1 ? "Termin" : "Termine"}</span></h3>
        <div class="month-grid"></div>`;
      chipsEl.appendChild(month);
      grid = month.querySelector(".month-grid");
    }
    grid.appendChild(makeChip(iso, selected === iso));
  }
}

function selectDate(iso) {
  selected = iso;
  for (const b of el("chips").querySelectorAll("[data-iso]")) {
    b.setAttribute("aria-pressed", String((b.dataset.iso || null) === iso));
  }
  try { localStorage.setItem(STORE_KEY, iso ?? ""); } catch (e) { /* privater Modus */ }
  if (layer) layer.setStyle(styleFor);
  renderLegend();
  updateStatus();
}

/* Klick auf eine Tour wählt ihren nächstgelegenen Termin — die Termine sind
   je Tour disjunkt, der Datumsfilter hebt danach genau diese Tour hervor. */
function selectTour(tour) {
  const soonest = (tourDates[tour] || [])[0];
  if (soonest) selectDate(soonest);
}

function setHover(tour) {
  hoverTour = tour;
  if (layer) layer.setStyle(styleFor);
  for (const row of el("legend").querySelectorAll(".tour-row")) {
    row.classList.toggle("is-hover", tour !== null && row.dataset.tour === tour);
  }
}

/* ---------- Legende ---------- */

function selectedDateTours() {
  if (!selected) return null;
  const set = {};
  for (const f of features) {
    for (const [tour, dates] of Object.entries(f.properties.dates)) {
      if (dates.includes(selected)) set[tour] = true;
    }
  }
  return set;
}

function renderLegend() {
  const legendEl = el("legend");
  const active = selectedDateTours();
  legendEl.innerHTML = "";

  for (const [tour, st] of Object.entries(tourStats).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const on = !selected || tour in active;
    const row = document.createElement("div");
    row.className = "tour-row";
    row.dataset.tour = tour;
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    row.setAttribute("aria-pressed", String(on));
    row.title = `Tour ${tour} auf der Karte hervorheben`;
    row.innerHTML = `
      <span class="tour-no">${esc(tour)}</span>
      <span class="tour-body">
        <span class="tour-name">
          <span class="ink tour-rule" data-tour="${esc(tour)}"></span>Tour ${esc(tour)}
          <span class="tour-state">${selected ? (on ? "holt ab" : "keine Abholung") : `${(tourDates[tour] || []).length} Termine`}</span>
        </span>
        <span class="tour-meta">${num(st.count)} Straßen · nächster ${st.next ? fmtDate(st.next) : "—"}</span>
      </span>
      <a class="tour-cal" href="${calUrl(tour)}"
         aria-label="Tour ${esc(tour)} als Kalender abonnieren"
         title="Tour ${esc(tour)} als Kalender abonnieren">Kalender</a>`;
    row.addEventListener("click", (e) => {
      if (e.target.closest("a")) return; // Kalender-Link: nicht die Tour wählen
      selectTour(tour);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectTour(tour);
      }
    });
    row.addEventListener("mouseenter", () => setHover(tour));
    row.addEventListener("mouseleave", () => setHover(null));
    row.addEventListener("focus", () => setHover(tour));
    row.addEventListener("blur", () => setHover(null));
    legendEl.appendChild(row);
  }

  el("legend-caption").textContent = selected
    ? `Abholung am ${fmtFull(selected)}`
    : "Nächste Termine je Tour";
}

/* ---------- Statuszeilen ---------- */

function updateStatus() {
  const countEl = el("count");
  const statusEl = el("plate-status");

  if (!selected) {
    countEl.textContent = allDates.length
      ? `${allDates.length} Termine`
      : "keine Termine";
    statusEl.textContent = `Alle Touren · ${num(features.length)} Straßen`;
    return;
  }

  const tours = Object.keys(selectedDateTours()).sort((a, b) => Number(a) - Number(b));
  const n = features.filter((f) => picksUpOn(f, selected)).length;
  countEl.textContent = tours.length === 0
    ? "keine Abholung"
    : `Tour${tours.length > 1 ? "en" : ""} ${tours.join(", ")} · ${num(n)} Straßen`;

  // Auf schmalen Karten die Kurzform, damit die Bildunterschrift einzeilig bleibt.
  const narrow = window.matchMedia("(max-width: 560px)").matches;
  const dt = asDate(selected);
  statusEl.textContent = narrow
    ? `Abholung am ${DOW[dt.getDay()]}, ${fmtFull(selected)}`
    : `Abholung am ${fmtLong(selected)}`;
}

function buildStats() {
  tourStats = {};
  for (const f of features) {
    for (const tour of Object.keys(f.properties.tours)) {
      const st = tourStats[tour] || (tourStats[tour] = { count: 0, next: null });
      st.count += 1;
      const first = (f.properties.dates[tour] || [])[0];
      if (first && (!st.next || first < st.next)) st.next = first;
    }
  }
}

/* ---------- Zustände ---------- */

function showLoading() {
  clearTimeout(slowTimer);
  el("plate-error").hidden = true;
  el("plate-loading").hidden = false;
  el("loading-title").textContent = "Straßendaten werden geladen …";
  el("loading-note").textContent = "1.800 Straßenzüge, einen Moment.";
  slowTimer = setTimeout(() => {
    el("loading-title").textContent = "Das dauert länger als erwartet.";
    el("loading-note").textContent = "Die Verbindung ist langsam — der Abruf läuft weiter.";
  }, 15000);
}

function showError(cause) {
  clearTimeout(slowTimer);
  el("plate-loading").hidden = true;
  el("plate-error").hidden = false;
  el("error-cause").textContent = cause;
  el("error-hint").hidden = attempts < 3;

  const btn = el("retry");
  const wait = attempts <= 1 ? 0 : Math.min(8, 2 ** (attempts - 1));
  btn.disabled = wait > 0;
  let left = wait;
  const tick = () => {
    btn.textContent = left > 0 ? `Erneut laden (${left} s)` : "Erneut laden";
    if (left > 0) { left -= 1; setTimeout(tick, 1000); } else { btn.disabled = false; }
  };
  tick();
}

function hideStates() {
  clearTimeout(slowTimer);
  el("plate-loading").hidden = true;
  el("plate-error").hidden = true;
}

/* ---------- Laden ---------- */

async function load() {
  attempts += 1;
  showLoading();

  let fc;
  try {
    const res = await fetch(SRC, { cache: "no-cache" });
    if (!res.ok) throw new Error(`Der Server antwortete mit ${res.status} ${res.statusText || ""}`.trim() + ".");
    fc = await res.json();
  } catch (err) {
    showError(err instanceof SyntaxError
      ? "Die Datei streets.geojson ist beschädigt oder unvollständig."
      : `${err.message || "Die Datei konnte nicht abgerufen werden."} Prüfen Sie Ihre Verbindung.`);
    return;
  }

  features = (fc && fc.features) || [];
  for (const f of features) {
    if (f.geometry && f.geometry.type === "LineString") {
      const g = splitGeometry(f.geometry.coordinates);
      if (g) f.geometry = g;
    }
  }
  if (!features.length) {
    showError("Die Datei enthält keine Straßen. Vermutlich ist der Datenlauf leer geblieben.");
    return;
  }

  allDates = [];
  for (const f of features) {
    for (const [tour, dates] of Object.entries(f.properties.dates)) {
      const list = tourDates[tour] || (tourDates[tour] = []);
      for (const d of dates) {
        if (!allDates.includes(d)) allDates.push(d);
        if (!list.includes(d)) list.push(d);
      }
    }
  }
  allDates.sort();
  for (const t of Object.keys(tourDates)) tourDates[t].sort();

  buildStats();

  if (layer) layer.remove();
  layer = L.geoJSON(features, {
    style: styleFor,
    onEachFeature: (f, lyr) => {
      lyr.bindPopup(popupFor(f));
      lyr.bindTooltip(tooltipFor(f), { sticky: true });
      lyr.on({
        mouseover: () => setHover(tourOf(f)),
        mouseout: () => setHover(null),
        click: () => selectTour(tourOf(f)),
      });
    },
  }).addTo(map);
  map.fitBounds(layer.getBounds().pad(0.04));

  // gespeicherte Auswahl wiederherstellen, sonst der nächstgelegene Termin
  let start = allDates[0] ?? null;
  try {
    const stored = localStorage.getItem(STORE_KEY);
    if (stored === "") start = null;
    else if (stored && allDates.includes(stored)) start = stored;
  } catch (e) { /* privater Modus */ }

  selected = start;
  buildChips();

  const span = allDates.length
    ? `Termine ${fmtDate(allDates[0])}–${fmtFull(allDates[allDates.length - 1])}`
    : "keine veröffentlichten Termine";
  el("edition").textContent = `Fünf Sammeltouren · ${span}`;
  el("meta").textContent =
    `${num(features.length)} Straßen · ${Object.keys(tourStats).length} Touren · ${allDates.length} Termine`;

  hideStates();
  selectDate(start);
}

resolveColors();
initMap();
el("retry").addEventListener("click", load);
load();
