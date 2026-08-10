/* Sperrmüll Braunschweig — map logic.
   Data: data/streets.geojson (street geometry + tour + dates per tour).
   Dates are per tour: a date chip highlights every tour collecting that day. */

"use strict";

const TOUR_COLORS = {
  1: "#d64541",   // vermilion
  4: "#1f6fb2",   // steel blue
  7: "#178a74",   // teal
  10: "#c77e00",  // ochre
  60: "#80599e",  // plum
};
const FADED = "#d5cfbe";
const FADED_WEIGHT = 1.4;
const LIVE_WEIGHT = 4;

const fmtDate = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.`;
};
const fmtFull = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};

let map;
let layer = null;
let features = [];
let selected = null; // ISO date or null (= all tours)
let hoverTour = null; // tour id under the cursor, or null
let tourStats = {};  // tour -> {count, next}
const allDates = [];
const tourDates = {}; // tour -> sorted ISO dates

const el = (id) => document.getElementById(id);

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
      ? { color: TOUR_COLORS[hoverTour], weight: LIVE_WEIGHT, opacity: 0.95 }
      : { color: FADED, weight: FADED_WEIGHT, opacity: 0.85 };
  }
  const active = !selected || picksUpOn(feature, selected);
  if (!active) {
    return { color: FADED, weight: FADED_WEIGHT, opacity: 0.85 };
  }
  return { color: TOUR_COLORS[tourOf(feature)], weight: LIVE_WEIGHT, opacity: 0.95 };
}

function popupFor(feature) {
  const p = feature.properties;
  const rows = Object.entries(p.tours).map(([tour, hnrs]) => {
    const dates = p.dates[tour] || [];
    const dots = dates.slice(0, 5).map(fmtDate).join(" · ");
    const more = dates.length > 5 ? ` · +${dates.length - 5}` : "";
    return `<div class="popup-row">
      <span class="popup-dot" style="background:${TOUR_COLORS[tour]}"></span>
      <span class="popup-tour">Tour ${tour}</span>
      <span class="popup-dates">${hnrs.length} Hausnr. · ${dots}${more}</span>
    </div>`;
  }).join("");
  return `<p class="popup-name">${p.name}</p>${rows}`;
}

function tooltipFor(feature) {
  const tour = tourOf(feature);
  const dates = (tourDates[tour] || []).map(fmtDate).join(" &middot; ");
  return `<div class="tip-head">
      <span class="popup-dot" style="background:${TOUR_COLORS[tour]}"></span>
      <span class="popup-tour">Tour ${tour}</span>
    </div>
    <div class="popup-dates">${dates}</div>`;
}

function buildChips() {
  const chipsEl = el("chips");
  const mk = (iso, label, title, pressed) => {
    const b = document.createElement("button");
    b.className = "chip" + (iso === allDates[0] ? " chip-next" : "");
    b.type = "button";
    b.textContent = label;
    b.title = title;
    b.setAttribute("aria-pressed", String(pressed));
    b.addEventListener("click", () => selectDate(iso));
    return b;
  };

  chipsEl.appendChild(mk(null, "Alle", "Alle Touren anzeigen", selected === null));
  for (const d of allDates) {
    chipsEl.appendChild(mk(d, fmtDate(d), fmtFull(d), selected === d));
  }
}

function selectDate(iso) {
  selected = iso;
  for (const b of el("chips").children) {
    const pressed = iso === null ? b.title === "Alle Touren anzeigen" : b.title === fmtFull(iso);
    b.setAttribute("aria-pressed", String(pressed));
  }
  layer.setStyle(styleFor);
  renderLegend();
  updateCount();
}

// Clicking a tour selects its soonest date (dates are disjoint per tour,
// so the date filter then highlights exactly that tour).
function selectTour(tour) {
  const soonest = (tourDates[tour] || [])[0];
  if (soonest) selectDate(soonest);
}

function renderLegend() {
  const rows = Object.entries(tourStats)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([tour, st]) => {
      const active = !selected || (tour in (selectedDateTours() || {}));
      const detail = selected
        ? (active ? "holt ab" : "keine Abholung")
        : `n&auml;chster ${fmtDate(st.next)}`;
      return `<div class="legend-row${active ? "" : " off"}">
        <span class="legend-swatch" style="background:${TOUR_COLORS[tour]}"></span>
        <span class="legend-name">Tour ${tour}</span>
        <span class="legend-detail">${st.count} Str. · ${detail}</span>
      </div>`;
    }).join("");
  const title = selected
    ? `Abholung am ${fmtFull(selected)}`
    : "5 Touren · N&auml;chste Termine";
  el("legend").innerHTML = `<div class="legend-title">${title}</div>${rows}`;
}

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
    : `Tour${activeTours.length > 1 ? "en" : ""} ${activeTours.join(", ")} · ${n} Straßen`;
}

function buildStats() {
  for (const f of features) {
    for (const tour of Object.keys(f.properties.tours)) {
      const st = tourStats[tour] || (tourStats[tour] = { count: 0, next: null });
      st.count += 1;
      const first = (f.properties.dates[tour] || [])[0];
      if (first && (!st.next || first < st.next)) st.next = first;
    }
  }
}

async function load() {
  const res = await fetch("data/streets.geojson");
  const fc = await res.json();
  features = fc.features;

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
  el("meta").innerHTML =
    `Stand ${fmtFull(allDates[0])} &middot; ` +
    `${features.length} Stra&szlig;en &middot; 5 Touren &middot; Daten: alba-bs.de + OpenStreetMap`;
  selectDate(allDates[0]); // start on the soonest pickup date
}

initMap();
load();
