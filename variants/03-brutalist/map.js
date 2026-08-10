/* Sperrmüll Braunschweig — Variante C (Brutalismus), Kartenlogik.
   Daten: ../../data/streets.geojson (Geometrie + Tour + Termine je Tour).
   Termine gelten je Tour: ein Termin-Chip hebt alle Touren hervor, die an
   diesem Tag sammeln. */

"use strict";

const css = getComputedStyle(document.documentElement);
const token = (name, fallback) => (css.getPropertyValue(name).trim() || fallback);

const TOUR_COLORS = {
  1: token("--tour-1", "#ff2b2b"),
  4: token("--tour-4", "#1436c8"),
  7: token("--tour-7", "#007a3d"),
  10: token("--tour-10", "#d97400"),
  60: token("--tour-60", "#6a2bd9"),
};
const FALLBACK_COLOR = token("--fg-2", "#222222");
const FADED = token("--tour-off", "#b7b1a4");
const FADED_WEIGHT = 1.6;
const LIVE_WEIGHT = 5;

const WEEKDAYS = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
  "August", "September", "Oktober", "November", "Dezember"];

const fmtDate = (iso) => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
};
const fmtFull = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};
const fmtDow = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
};
const fmtMonth = (iso) => {
  const [y, m] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${y}`;
};
const fmtNum = (n) => n.toLocaleString("de-DE");

const escapeHtml = (s) => String(s).replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const colorOf = (tour) => TOUR_COLORS[tour] || FALLBACK_COLOR;

let map;
let layer = null;
let features = [];
let selected = null;   // ISO-Datum oder null (= alle Touren)
let hoverTour = null;  // Tour unter dem Cursor oder null
let tourStats = {};    // Tour -> {count, next}
let attempts = 0;      // Ladeversuche (für Backoff)
let slowTimer = null;
const allDates = [];
const tourDates = {};  // Tour -> sortierte ISO-Termine

const el = (id) => document.getElementById(id);

/* ---------- Zustände: laden / Fehler / leer ---------- */

function setStatus(state, opts = {}) {
  const box = el("status");
  const action = el("status-action");
  const skeleton = el("status-skeleton");

  if (state === "ready") {
    box.hidden = true;
    return;
  }

  box.hidden = false;
  el("status-kicker").textContent = opts.kicker || "";
  el("status-head").textContent = opts.head || "";
  el("status-body").textContent = opts.body || "";
  skeleton.hidden = state !== "loading";

  if (opts.action) {
    action.hidden = false;
    action.disabled = false;
    action.textContent = opts.action;
    action.onclick = opts.onAction || null;
  } else if (opts.actionDisabled) {
    action.hidden = false;
    action.disabled = true;
    action.textContent = opts.actionDisabled;
    action.onclick = null;
  } else {
    action.hidden = true;
    action.onclick = null;
  }
}

function showLoading() {
  setStatus("loading", {
    kicker: "Lädt",
    head: "Karte wird geladen",
    body: "Straßenzüge und Abholtermine werden gezeichnet.",
  });
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => {
    const body = el("status-body");
    if (!el("status").hidden) {
      body.textContent = "Das dauert länger als erwartet. Die Straßendaten sind rund 1,8 MB groß.";
    }
  }, 15000);
}

function showError(err) {
  clearTimeout(slowTimer);
  const reason = err && err.message
    ? err.message
    : "Die Datei data/streets.geojson ist nicht erreichbar.";
  if (attempts >= 3) {
    setStatus("error", {
      kicker: "Fehler",
      head: "Daten bleiben nicht erreichbar",
      body: `${reason} Nach 3 Versuchen aufgegeben. Bitte die Seite später neu laden oder die Datenquelle prüfen.`,
      actionDisabled: `3 Versuche fehlgeschlagen`,
    });
    return;
  }
  const wait = attempts === 1 ? 0 : (attempts === 2 ? 2 : 4);
  setStatus("error", {
    kicker: "Fehler",
    head: "Daten nicht geladen",
    body: `${reason} Die Karte bleibt leer, bis die Termine geladen sind.`,
    action: wait ? `Erneut laden (${wait} s)` : "Erneut laden",
    onAction: () => {
      el("status-action").disabled = true;
      showLoading();
      setTimeout(load, wait * 1000);
    },
  });
}

function showEmpty() {
  clearTimeout(slowTimer);
  setStatus("empty", {
    kicker: "Keine Daten",
    head: "Keine Straßen hinterlegt",
    body: "Die Datenquelle enthält aktuell keine Straßen mit Abholterminen. Der nächste Scrape-Lauf füllt die Karte wieder.",
    action: "Neu laden",
    onAction: () => { attempts = 0; showLoading(); load(); },
  });
}

/* ---------- Karte ---------- */

function initMap() {
  map = L.map("map", { preferCanvas: true, zoomControl: true });
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    { attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19 }
  ).addTo(map);
}

function tourOf(feature) {
  return Object.keys(feature.properties.tours)[0];
}

function picksUpOn(feature, iso) {
  return Object.values(feature.properties.dates).some((list) => list.includes(iso));
}

function styleFor(feature) {
  if (hoverTour !== null) {
    const live = tourOf(feature) === hoverTour;
    return live
      ? { color: colorOf(hoverTour), weight: LIVE_WEIGHT, opacity: 1 }
      : { color: FADED, weight: FADED_WEIGHT, opacity: 0.9 };
  }
  const active = !selected || picksUpOn(feature, selected);
  if (!active) {
    return { color: FADED, weight: FADED_WEIGHT, opacity: 0.9 };
  }
  return { color: colorOf(tourOf(feature)), weight: LIVE_WEIGHT, opacity: 1 };
}

/* Hausnummernbereich: "Nr. 1–47" wenn auswertbar, sonst reine Anzahl. */
function hnrLabel(hnrs) {
  const nums = hnrs.map((h) => parseInt(h, 10)).filter((n) => !Number.isNaN(n));
  if (nums.length < 2) {
    return `${hnrs.length} Hausnr.`;
  }
  const lo = Math.min(...nums);
  const hi = Math.max(...nums);
  const range = lo === hi ? `Nr. ${lo}` : `Nr. ${lo}–${hi}`;
  return `${range} · ${hnrs.length} Hausnr.`;
}

function popupFor(feature) {
  const p = feature.properties;
  const rows = Object.entries(p.tours).map(([tour, hnrs]) => {
    const dates = p.dates[tour] || [];
    const shown = dates.slice(0, 5).map((d) => `${fmtDow(d)} ${fmtDate(d)}`).join(" · ");
    const more = dates.length > 5 ? ` · +${dates.length - 5} weitere` : "";
    const list = dates.length ? `${shown}${more}` : "keine Termine hinterlegt";
    return `<div class="popup-row">
      <div class="popup-head">
        <span class="popup-dot" style="background:${colorOf(tour)}"></span>
        <span class="popup-tour">Tour ${escapeHtml(tour)}</span>
        <span class="popup-hnr">${escapeHtml(hnrLabel(hnrs))}</span>
      </div>
      <div class="popup-dates">${list}</div>
    </div>`;
  }).join("");
  return `<p class="popup-name">${escapeHtml(p.name)}</p>${rows}`;
}

function tooltipFor(feature) {
  const tour = tourOf(feature);
  const dates = (tourDates[tour] || []).map(fmtDate).join(" &middot; ");
  return `<div class="tip-head">
      <span class="popup-dot" style="background:${colorOf(tour)}"></span>
      <span class="popup-tour">Tour ${escapeHtml(tour)}</span>
    </div>
    <div class="popup-dates">${dates || "keine Termine"}</div>`;
}

/* ---------- Terminraster ---------- */

function buildChips() {
  const chipsEl = el("chips");
  chipsEl.innerHTML = "";

  const mk = (iso, pressed) => {
    const b = document.createElement("button");
    b.className = "chip" + (iso === null ? " chip-all" : "")
      + (iso === allDates[0] ? " chip-next" : "");
    b.type = "button";
    b.dataset.iso = iso === null ? "" : iso;
    if (iso === null) {
      b.textContent = "Alle Termine";
      b.title = "Alle Touren anzeigen";
    } else {
      b.innerHTML = `<span class="dow">${fmtDow(iso)}</span><span>${fmtDate(iso)}</span>`;
      b.title = iso === allDates[0]
        ? `${fmtFull(iso)} — nächster Termin`
        : fmtFull(iso);
      b.setAttribute("aria-label", `Abholung am ${fmtFull(iso)}`);
    }
    b.setAttribute("aria-pressed", String(pressed));
    b.addEventListener("click", () => selectDate(iso));
    return b;
  };

  chipsEl.appendChild(mk(null, selected === null));

  let month = "";
  for (const d of allDates) {
    const label = fmtMonth(d);
    if (label !== month) {
      month = label;
      const head = document.createElement("div");
      head.className = "chip-month";
      head.textContent = label;
      chipsEl.appendChild(head);
    }
    chipsEl.appendChild(mk(d, selected === d));
  }
}

function selectDate(iso) {
  selected = iso;
  for (const b of el("chips").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String((b.dataset.iso || null) === iso));
  }
  layer.setStyle(styleFor);
  renderLegend();
  updateCount();
}

/* Klick auf eine Straße wählt den nächsten Termin ihrer Tour. Die Termine sind
   je Tour disjunkt, der Datumsfilter hebt danach genau diese Tour hervor. */
function selectTour(tour) {
  const soonest = (tourDates[tour] || [])[0];
  if (soonest) selectDate(soonest);
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
  const live = selectedDateTours();
  const rows = Object.entries(tourStats)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([tour, st]) => {
      const active = !selected || (tour in (live || {}));
      const detail = selected
        ? (active ? "holt ab" : "keine Abholung")
        : (st.next ? `nächster ${fmtDate(st.next)}` : "kein Termin");
      return `<div class="legend-row${active ? "" : " off"}">
        <span class="legend-swatch" style="background:${colorOf(tour)}"></span>
        <span class="legend-name">Tour ${escapeHtml(tour)}</span>
        <span class="legend-detail">${fmtNum(st.count)} Straßen · ${detail}</span>
      </div>`;
    }).join("");
  el("legend-title").textContent = selected
    ? `Abholung am ${fmtFull(selected)}`
    : "5 Touren · nächste Termine";
  el("legend").innerHTML = rows;
}

function updateCount() {
  const countEl = el("count");
  if (!selected) {
    countEl.textContent = `${allDates.length} Termine`;
    return;
  }
  const activeTours = Object.keys(selectedDateTours()).sort((a, b) => a - b);
  const n = features.filter((f) => picksUpOn(f, selected)).length;
  countEl.textContent = activeTours.length === 0
    ? "keine Abholung"
    : `Tour${activeTours.length > 1 ? "en" : ""} ${activeTours.join(", ")} · ${fmtNum(n)} Straßen`;
}

/* ---------- Daten ---------- */

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

function renderMastStat() {
  el("mast-stat").innerHTML = [
    [allDates.length, "Termine"],
    [features.length, "Straßen"],
    [Object.keys(tourStats).length, "Touren"],
  ].map(([n, label]) =>
    `<span class="stat-line"><b>${fmtNum(n)}</b> ${label}</span>`
  ).join("");
}

async function load() {
  attempts += 1;
  try {
    const res = await fetch("../../data/streets.geojson");
    if (!res.ok) {
      throw new Error(`Server antwortete mit ${res.status} ${res.statusText}.`);
    }
    const fc = await res.json();
    features = fc.features || [];
  } catch (err) {
    showError(err);
    return;
  }

  if (features.length === 0) {
    showEmpty();
    return;
  }

  allDates.length = 0;
  for (const key of Object.keys(tourDates)) delete tourDates[key];

  for (const f of features) {
    for (const dates of Object.values(f.properties.dates)) {
      for (const d of dates) {
        if (!allDates.includes(d)) allDates.push(d);
      }
    }
  }
  allDates.sort();

  for (const f of features) {
    for (const [tour, dates] of Object.entries(f.properties.dates)) {
      const list = tourDates[tour] || (tourDates[tour] = []);
      for (const d of dates) if (!list.includes(d)) list.push(d);
    }
  }
  for (const t of Object.keys(tourDates)) tourDates[t].sort();

  buildStats();

  if (layer) layer.remove();
  layer = L.geoJSON(features, {
    style: styleFor,
    onEachFeature: (f, lyr) => {
      lyr.bindPopup(popupFor(f));
      lyr.bindTooltip(tooltipFor(f), { sticky: true });
      lyr.on({
        mouseover: () => { hoverTour = tourOf(f); layer.setStyle(styleFor); },
        mouseout: () => { hoverTour = null; layer.setStyle(styleFor); },
        click: () => selectTour(tourOf(f)),
      });
    },
  }).addTo(map);
  map.fitBounds(layer.getBounds().pad(0.06));

  buildChips();
  renderMastStat();
  el("meta").innerHTML =
    `Datenstand ${fmtFull(allDates[0])} &middot; ${fmtNum(features.length)} Straßen &middot; ` +
    `${allDates.length} Termine &middot; ${Object.keys(tourStats).length} Sammeltouren`;

  clearTimeout(slowTimer);
  attempts = 0;
  setStatus("ready");
  selectDate(allDates[0]); // Start auf dem nächsten Abholtermin
}

initMap();
showLoading();
load();
