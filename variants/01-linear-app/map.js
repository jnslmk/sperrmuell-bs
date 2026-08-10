/* Sperrmüll Braunschweig — Variante A (Linear-App).
   Daten: ../../data/streets.geojson (Straßengeometrie + Tour + Termine je Tour).
   Termine liegen pro Tour vor: ein Termin-Chip hebt jede Tour hervor,
   die an diesem Tag sammelt. */

"use strict";

/* ── Tokens aus dem Stylesheet lesen — keine Farbwerte im JS ── */

const ROOT = document.documentElement;
const token = (name) => getComputedStyle(ROOT).getPropertyValue(name).trim();

const TOUR_TOKENS = ["--tour-a", "--tour-b", "--tour-c", "--tour-d", "--tour-e"];
const TOUR_COLORS = {}; // tour id -> css color, nach Sortierung vergeben
const FADED = token("--map-line-faded"); // einmal auflösen: styleFor läuft pro Straße

const FADED_WEIGHT = 1.2;
const LIVE_WEIGHT = 3.4;
const HOVER_WEIGHT = 4.6;
const STORE_KEY = "sperrmuell-bs.linear.date";

const WD_SHORT = ["So", "Mo", "Di", "Mi", "Do", "Fr", "Sa"];
const WD_LONG = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag"];

const el = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat("de-DE");

const fmtDate = (iso) => {
  const [, m, d] = iso.split("-");
  return `${d}.${m}.`;
};
const fmtFull = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
};
const weekday = (iso, long) => {
  const day = new Date(`${iso}T12:00:00`).getDay();
  return (long ? WD_LONG : WD_SHORT)[day];
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/* ── Zustand ── */

let map;
let layer = null;
let features = [];
let selected = null;   // ISO-Datum oder null (= alle Touren)
let hoverTour = null;  // Tour unter dem Zeiger, oder null
let tourStats = {};    // tour -> {count, next}
let allDates = [];
let tourDates = {};    // tour -> sortierte ISO-Daten
let dateTours = {};    // ISO-Datum -> sortierte Tour-Liste
let ready = false;
let slowTimer = null;
let openPopup = null;  // aktuell geöffnetes Popup, für Live-Aktualisierung

/* ── Karte ── */

function initMap() {
  map = L.map("map", { preferCanvas: true, zoomControl: false, attributionControl: true });
  L.control.zoom({ position: "topright" }).addTo(map);
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
      maxZoom: 19,
    }
  ).addTo(map);
  map.setView([52.2689, 10.5268], 12); // Braunschweig, bis die Geometrie da ist

  map.on("popupopen", (e) => { openPopup = e.popup; });
  map.on("popupclose", () => { openPopup = null; });
}

const tourOf = (feature) => Object.keys(feature.properties.tours)[0];
const colorOf = (tour) => TOUR_COLORS[tour] || FADED;

/* 15 Straßen werden von zwei Touren bedient. Ist ein Termin gewählt,
   zählt die Tour, die an genau diesem Tag sammelt — sonst die erste. */
function displayTour(feature) {
  const tours = Object.keys(feature.properties.tours);
  if (selected && tours.length > 1) {
    const hit = tours.find((t) => (feature.properties.dates[t] || []).includes(selected));
    if (hit) return hit;
  }
  return tours[0];
}

const servesTour = (feature, tour) => tour in feature.properties.tours;

function picksUpOn(feature, iso) {
  return Object.values(feature.properties.dates).some((list) => list.includes(iso));
}

function styleFor(feature) {
  if (hoverTour !== null) {
    return servesTour(feature, hoverTour)
      ? { color: colorOf(hoverTour), weight: HOVER_WEIGHT, opacity: 1 }
      : { color: FADED, weight: FADED_WEIGHT, opacity: 0.5 };
  }
  const active = !selected || picksUpOn(feature, selected);
  if (!active) {
    return { color: FADED, weight: FADED_WEIGHT, opacity: 0.5 };
  }
  return { color: colorOf(displayTour(feature)), weight: LIVE_WEIGHT, opacity: 0.92 };
}

/* ── Popup & Tooltip ── */

function popupFor(feature) {
  const p = feature.properties;
  const rows = Object.entries(p.tours).map(([tour, hnrs]) => {
    const dates = p.dates[tour] || [];
    const shown = dates.slice(0, 6).map((d) => {
      const cls = d === selected ? "popup-date is-selected" : "popup-date";
      return `<span class="${cls}">${weekday(d)} ${fmtFull(d)}</span>`;
    }).join("");
    const more = dates.length > 6
      ? `<span class="popup-date is-more">+${dates.length - 6} weitere</span>`
      : "";
    const hnrLabel = hnrs.length === 1 ? "1 Hausnr." : `${nf.format(hnrs.length)} Hausnr.`;
    return `<div class="popup-row">
        <div class="popup-head">
          <span class="popup-dot" style="--c:${colorOf(tour)}"></span>
          <span class="popup-tour">Tour ${esc(tour)}</span>
          <span class="popup-hnr">${hnrLabel}</span>
        </div>
        <div class="popup-label">Abholtermine</div>
        <div class="popup-dates">${shown}${more}</div>
      </div>`;
  }).join("");

  const hnrs = Object.values(p.tours).flat();
  const range = hnrs.length > 1 ? `Hausnummern ${esc(hnrs[0])}–${esc(hnrs[hnrs.length - 1])}` : "";

  return `<p class="popup-name">${esc(p.name)}</p>
    ${range ? `<p class="popup-sub">${range}</p>` : ""}
    <div class="popup-rows">${rows}</div>`;
}

function tooltipFor(feature) {
  const tour = displayTour(feature);
  const dates = (tourDates[tour] || []).slice(0, 4)
    .map((d) => `${weekday(d)} ${fmtDate(d)}`).join(" · ");
  const rest = (tourDates[tour] || []).length - 4;
  return `<div class="tip-head">
      <span class="popup-dot" style="--c:${colorOf(tour)}"></span>
      <span class="tip-name">${esc(feature.properties.name)}</span>
      <span class="tip-tour">Tour ${esc(tour)}</span>
    </div>
    <div class="tip-dates">${dates}${rest > 0 ? ` · +${rest}` : ""}</div>`;
}

/* ── Terminliste ── */

function buildChips() {
  const chipsEl = el("chips");
  chipsEl.innerHTML = "";

  const all = document.createElement("button");
  all.type = "button";
  all.className = "chip chip-all";
  all.dataset.iso = "";
  all.setAttribute("aria-pressed", String(selected === null));
  all.innerHTML = `<span class="chip-date">Alle Termine</span>
    <span class="chip-tours">${Object.keys(tourStats).sort((a, b) => a - b)
      .map((t) => `<i style="--c:${colorOf(t)}"></i>`).join("")}</span>`;
  all.addEventListener("click", () => selectDate(null));
  chipsEl.appendChild(all);

  allDates.forEach((iso, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip";
    b.dataset.iso = iso;
    b.title = `${weekday(iso, true)}, ${fmtFull(iso)}`;
    b.setAttribute("aria-pressed", String(selected === iso));
    const dots = (dateTours[iso] || [])
      .map((t) => `<i style="--c:${colorOf(t)}"></i>`).join("");
    const [y, m, d] = iso.split("-");
    b.innerHTML = `<span class="chip-day">${weekday(iso)}</span>
      <span class="chip-date">${d}.${m}.<span class="chip-year">${y}</span>${i === 0 ? '<span class="chip-flag">nächster</span>' : ""}</span>
      <span class="chip-tours">${dots}</span>`;
    b.addEventListener("click", () => selectDate(iso));
    chipsEl.appendChild(b);
  });

  requestAnimationFrame(updateScrollHint);
  chipsEl.addEventListener("scroll", updateScrollHint, { passive: true });
}

function updateScrollHint() {
  const c = el("chips");
  const wrap = c.parentElement;
  const vertical = c.scrollHeight > c.clientHeight + 2;
  const horizontal = c.scrollWidth > c.clientWidth + 2;
  wrap.classList.toggle("is-scrollable", vertical || horizontal);
}

/* Ausgewählten Chip sichtbar halten — ohne scrollIntoView. */
function revealChip(btn) {
  const c = el("chips");
  if (!btn) return;
  if (c.scrollHeight > c.clientHeight + 2) {
    const top = btn.offsetTop - c.offsetTop;
    if (top < c.scrollTop) c.scrollTop = top - 4;
    else if (top + btn.offsetHeight > c.scrollTop + c.clientHeight) {
      c.scrollTop = top + btn.offsetHeight - c.clientHeight + 8;
    }
  }
  if (c.scrollWidth > c.clientWidth + 2) {
    const left = btn.offsetLeft - c.offsetLeft;
    if (left < c.scrollLeft) c.scrollLeft = left - 6;
    else if (left + btn.offsetWidth > c.scrollLeft + c.clientWidth) {
      c.scrollLeft = left + btn.offsetWidth - c.clientWidth + 10;
    }
  }
}

function selectDate(iso) {
  selected = iso;
  let activeBtn = null;
  for (const b of el("chips").children) {
    const pressed = (b.dataset.iso || null) === iso;
    b.setAttribute("aria-pressed", String(pressed));
    if (pressed) activeBtn = b;
  }
  revealChip(activeBtn);

  layer.setStyle(styleFor);
  // Ein offenes Popup markiert den gewählten Termin — Inhalt neu auswerten.
  if (openPopup) openPopup.update();

  renderLegend();
  updateStatus();

  try {
    if (iso) localStorage.setItem(STORE_KEY, iso);
    else localStorage.removeItem(STORE_KEY);
  } catch (e) { /* privater Modus — Auswahl bleibt dann nur in dieser Sitzung */ }
}

/* Ein Klick auf eine Tour wählt ihren nächsten Termin. Da die Termine je
   Tour disjunkt sind, hebt der Datumsfilter danach genau diese Tour hervor. */
function selectTour(tour) {
  const soonest = (tourDates[tour] || [])[0];
  if (soonest) selectDate(soonest);
}

function setHoverTour(tour) {
  if (hoverTour === tour) return;
  hoverTour = tour;
  layer.setStyle(styleFor);
}

/* ── Legende ── */

function renderLegend() {
  const legendEl = el("legend");
  const activeTours = selectedDateTours();
  const tours = Object.keys(tourStats).sort((a, b) => Number(a) - Number(b));

  if (selected && activeTours.length === 0) {
    legendEl.innerHTML =
      `<p class="legend-empty">Für den ${weekday(selected, true)}, ${fmtFull(selected)} ist keine Sammeltour hinterlegt. Wähle einen anderen Termin oder <strong>Alle Termine</strong>.</p>`;
    el("legend-meta").textContent = "";
    return;
  }

  legendEl.innerHTML = tours.map((tour) => {
    const st = tourStats[tour];
    const on = !selected || activeTours.includes(tour);
    const detail = selected
      ? (on ? `holt ab · ${nf.format(st.count)} Str.` : "keine Abholung")
      : `${nf.format(st.count)} Str. · ab ${fmtDate(st.next)}`;
    return `<button type="button" class="legend-row ${on ? "on" : "off"}" data-tour="${esc(tour)}" aria-pressed="${on && !!selected}">
        <span class="legend-swatch" style="--c:${colorOf(tour)}"></span>
        <span class="legend-name">Tour ${esc(tour)}</span>
        <span class="legend-detail">${detail}</span>
      </button>`;
  }).join("");

  el("legend-meta").textContent = selected
    ? `${activeTours.length} von ${tours.length} aktiv`
    : `${tours.length} Touren`;

  for (const row of legendEl.children) {
    const tour = row.dataset.tour;
    row.addEventListener("click", () => selectTour(tour));
    row.addEventListener("mouseenter", () => setHoverTour(tour));
    row.addEventListener("mouseleave", () => setHoverTour(null));
    row.addEventListener("focus", () => setHoverTour(tour));
    row.addEventListener("blur", () => setHoverTour(null));
  }
}

function selectedDateTours() {
  if (!selected) return [];
  return (dateTours[selected] || []).slice();
}

/* ── Statusleiste über der Karte ── */

function updateStatus() {
  const label = el("status-label");
  const count = el("count");

  if (!selected) {
    label.textContent = "Alle Termine";
    count.textContent = `${nf.format(allDates.length)} Termine · ${nf.format(features.length)} Straßen`;
    return;
  }

  const tours = selectedDateTours();
  const n = features.filter((f) => picksUpOn(f, selected)).length;
  label.textContent = `${weekday(selected, true)}, ${fmtFull(selected)}`;
  count.textContent = tours.length === 0
    ? "keine Abholung"
    : `Tour${tours.length > 1 ? "en" : ""} ${tours.join(", ")} · ${nf.format(n)} Straßen`;
}

/* ── Zustände: laden / Fehler ── */

function showLoading() {
  const state = el("state");
  document.querySelector(".kbd-hint").hidden = true; // Pfeiltasten wirken erst mit Daten
  state.className = "state is-visible";
  state.innerHTML = `<div class="skeleton-list" aria-hidden="true">
      <span class="sk sk-row"></span><span class="sk sk-row"></span><span class="sk sk-row"></span>
      <span class="sk sk-row"></span><span class="sk sk-row"></span>
    </div>
    <p class="state-text" id="state-text">Termine werden geladen …</p>`;
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => {
    const t = el("state-text");
    if (t) t.textContent = "Das dauert länger als erwartet — die Straßengeometrie ist rund 2 MB groß.";
  }, 15000);
}

function hideLoading() {
  clearTimeout(slowTimer);
  document.querySelector(".kbd-hint").hidden = false;
  el("state").className = "state";
  el("state").innerHTML = "";
}

let retries = 0;

function showError(err) {
  clearTimeout(slowTimer);
  const state = el("state");
  state.className = "state is-visible is-error";
  state.innerHTML = `<div class="state-error" role="alert">
      <h3>Termine konnten nicht geladen werden</h3>
      <p>Die Datei <code>data/streets.geojson</code> war nicht erreichbar. Prüfe die Internetverbindung oder lade die Seite neu.</p>
      <p class="cause">Ursache: ${esc(err && err.message ? err.message : String(err))}</p>
      <button class="btn-retry" type="button" id="retry">Erneut versuchen</button>
    </div>`;
  el("status-label").textContent = "Daten nicht verfügbar";
  el("count").textContent = "";
  el("legend").innerHTML = '<p class="legend-empty">Ohne geladene Daten lassen sich die Touren nicht anzeigen.</p>';
  el("legend-meta").textContent = "";

  el("retry").addEventListener("click", (ev) => {
    const btn = ev.currentTarget;
    retries += 1;
    if (retries >= 3) {
      btn.disabled = true;
      btn.textContent = "Weiter fehlgeschlagen";
      state.querySelector(".cause").textContent =
        "Nach drei Versuchen weiterhin kein Zugriff. Bitte später erneut öffnen oder die Termine direkt bei alba-bs.de abrufen.";
      return;
    }
    const wait = retries === 1 ? 0 : 2000 * (retries - 1);
    btn.disabled = true;
    btn.textContent = wait ? `Neuer Versuch in ${wait / 1000} s …` : "Lädt …";
    setTimeout(() => { showLoading(); load(); }, wait);
  });
}

/* ── Daten ── */

function indexData(fc) {
  features = fc.features;
  allDates = [];
  tourDates = {};
  dateTours = {};
  tourStats = {};

  for (const f of features) {
    for (const [tour, dates] of Object.entries(f.properties.dates)) {
      const list = tourDates[tour] || (tourDates[tour] = []);
      for (const d of dates) {
        if (!list.includes(d)) list.push(d);
        if (!allDates.includes(d)) allDates.push(d);
        const set = dateTours[d] || (dateTours[d] = []);
        if (!set.includes(tour)) set.push(tour);
      }
    }
    for (const tour of Object.keys(f.properties.tours)) {
      const st = tourStats[tour] || (tourStats[tour] = { count: 0, next: null });
      st.count += 1;
      const first = (f.properties.dates[tour] || [])[0];
      if (first && (!st.next || first < st.next)) st.next = first;
    }
  }

  allDates.sort();
  for (const t of Object.keys(tourDates)) tourDates[t].sort();
  for (const d of Object.keys(dateTours)) dateTours[d].sort((a, b) => Number(a) - Number(b));

  Object.keys(tourStats).sort((a, b) => Number(a) - Number(b)).forEach((tour, i) => {
    TOUR_COLORS[tour] = token(TOUR_TOKENS[i % TOUR_TOKENS.length]);
  });
}

async function load() {
  try {
    const res = await fetch("../../data/streets.geojson");
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const fc = await res.json();
    if (!fc.features || !fc.features.length) throw new Error("Datensatz enthält keine Straßen");

    indexData(fc);

    if (layer) { layer.remove(); layer = null; }
    layer = L.geoJSON(features, {
      style: styleFor,
      onEachFeature: (f, lyr) => {
        // Inhalt erst beim Öffnen bauen — 1802 Straßen sollen nicht bei
        // jedem Terminwechsel neu gerendert werden.
        lyr.bindPopup((l) => popupFor(l.feature), { maxWidth: 300, closeButton: true });
        lyr.bindTooltip((l) => tooltipFor(l.feature), {
          sticky: true, direction: "top", offset: [0, -6], opacity: 1,
        });
        lyr.on({
          mouseover: () => setHoverTour(displayTour(f)),
          mouseout: () => setHoverTour(null),
          click: () => selectTour(displayTour(f)),
        });
      },
    }).addTo(map);
    map.fitBounds(layer.getBounds().pad(0.04));

    el("stat-dates").textContent = nf.format(allDates.length);
    el("stat-streets").textContent = nf.format(features.length);
    el("stat-tours").textContent = nf.format(Object.keys(tourStats).length);

    hideLoading();
    buildChips();

    let start = allDates[0];
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved && allDates.includes(saved)) start = saved;
    } catch (e) { /* Speicher nicht verfügbar — Standard bleibt der nächste Termin */ }

    ready = true;
    selectDate(start);
  } catch (err) {
    showError(err);
  }
}

/* ── Tastatur: ← / → durch die Termine, Esc zeigt alle ── */

document.addEventListener("keydown", (ev) => {
  if (!ready) return;
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const tag = (ev.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || ev.target.isContentEditable) return;

  if (ev.key === "Escape") { selectDate(null); return; }
  if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;

  const order = [null].concat(allDates);
  const i = order.indexOf(selected);
  const next = ev.key === "ArrowRight"
    ? Math.min(i + 1, order.length - 1)
    : Math.max(i - 1, 0);
  if (next !== i) { ev.preventDefault(); selectDate(order[next]); }
});

/* ── Mobiles Blatt ein-/ausklappen ── */

el("sheet-toggle").addEventListener("click", (ev) => {
  const sidebar = document.querySelector(".sidebar");
  const open = sidebar.classList.toggle("is-collapsed") === false;
  ev.currentTarget.setAttribute("aria-expanded", String(open));
  setTimeout(() => { map.invalidateSize(); updateScrollHint(); }, 220);
});

window.addEventListener("resize", updateScrollHint);

showLoading();
initMap();
load();
