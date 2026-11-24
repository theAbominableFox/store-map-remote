/* Mapa sklepów – front-end.
   Dane pochodzą z serwera (server.py), który czyta/zapisuje plik xlsx/csv.
   Sklep = wiersz arkusza (kolumny listy sklepów + Status/Lat/Lng/ID).
   Usterka = wiersz arkusza "Incydenty", zawsze przypisana do istniejącego sklepu (kolumna POS). */

const PRIORITIES = ["niski", "średni", "wysoki"];
const PRIO_COLOR = { niski: "#3b82f6", "średni": "#f59e0b", wysoki: "#dc2626" };
const STATUSES = ["nowa", "w trakcie", "naprawiona"];
const STATUS_LABEL = { nowa: "Nowa", "w trakcie": "W trakcie", naprawiona: "Naprawiona" };
const DONE = "naprawiona";
const APP_COLS = ["Status", "Lat", "Lng", "ID"];
const EXTRA_COLORS = ["#0891b2", "#db2777", "#65a30d", "#7c3aed", "#ea580c", "#0d9488"];
const NO_REGION = "#4a4a47"; // ciemnoszary (jak tło ciemnego motywu Claude)

let D = { columns: [], stores: [], incidents: [], regions: [] };
let COL = {};                       // name, address, region, type
let mtime = 0;
let EDITOR = false;                 // zalogowany do edycji (albo serwer bez hasła)
let LOGIN = false;                  // serwer wymaga hasła do edycji
const F ={ reg: new Set(), kind: "all", own: "all", q: "" };   // filtry

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const clsOf = (s) => s.replace(/\s+/g, "");

// ------------------------------------------------------------------ mapa
const map = L.map("map", { zoomControl: true }).setView([52.0, 19.4], 6);
// Style mapy (wybór w lewym dolnym rogu). "filter" przyciemnia kafelki OSM w CSS (klasy .ms-* w style.css).
const OSM_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTR = "&copy; OpenStreetMap contributors";
const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/";
const MAP_STYLES = {
  standard: { label: "Standardowa", layers: [[OSM_URL, OSM_ATTR]] },
  muted: { label: "Przygaszona", layers: [[OSM_URL, OSM_ATTR]] },
  dark: { label: "Ciemna", layers: [[OSM_URL, OSM_ATTR]] },
  darkgray: { label: "Ciemnoszara", layers: [
    [ESRI + "World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}", "Tiles &copy; Esri"],
    [ESRI + "World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}", ""],   // nazwy miast
  ] },
};
let baseLayers = [];
// W trakcie przelotu warstwa tylko skaluje kafelki, które już ma – bez pobierania poziomów pośrednich
// (inaczej zapychają kolejkę i cel długo jest pusty). Kafelki celu pobiera z góry preloadTiles().
let flying = false, flyTimer = 0;
const FlyTileLayer = L.TileLayer.extend({
  _setView(center, zoom, noPrune, noUpdate) {
    if (flying) return this._setZoomTransforms(center, zoom);
    L.TileLayer.prototype._setView.call(this, center, zoom, noPrune, noUpdate);
  },
  _update(center) { if (!flying) L.TileLayer.prototype._update.call(this, center); },
});
let preloaded = [];
function preloadTiles(center, zoom) {
  for (const img of preloaded) if (!img.complete) img.src = "";   // poprzedni cel już niepotrzebny
  preloaded = [];
  const half = map.getSize().divideBy(2), world = 2 ** zoom;
  const c = map.project(center, zoom);
  const a = c.subtract(half).divideBy(256).floor(), b = c.add(half).divideBy(256).floor();
  for (const l of baseLayers) {
    if (!(l instanceof FlyTileLayer) || zoom > l.options.maxNativeZoom) continue;
    for (let x = a.x; x <= b.x; x++) for (let y = Math.max(0, a.y); y <= Math.min(world - 1, b.y); y++) {
      const t = L.point(((x % world) + world) % world, y);
      const img = new Image();
      img.src = L.Util.template(l._url, { s: l._getSubdomain(t), x: t.x, y: t.y, z: zoom });
      preloaded.push(img);
    }
  }
}
function flyStart(center, zoom) {
  preloadTiles(center, zoom);
  flying = true;
  clearTimeout(flyTimer);
  flyTimer = setTimeout(flyEnd, FLY_S * 1000 + 300);   // przerwany przelot nie wysyła "moveend"
}
function flyEnd() {
  if (!flying) return;
  flying = false;
  clearTimeout(flyTimer);
  for (const l of baseLayers) if (l instanceof FlyTileLayer) l._setView(map.getCenter(), map.getZoom());
}
map.on("moveend", flyEnd);
let currentStyle = "standard";

// Granice kraju i województw (static/granice.geojson) – czerwone na jasnych mapach, białe na ciemnych.
const DARK_STYLES = ["dark", "darkgray"];
map.createPane("borders");
map.getPane("borders").style.zIndex = 350;          // nad kafelkami, pod pinezkami
map.getPane("borders").style.pointerEvents = "none";
let borders = null;
function borderStyle(f) {
  const color = DARK_STYLES.includes(currentStyle) ? "#ffffff" : "#d62828";
  return f.properties.kind === "kraj"
    ? { color, weight: 3.5, opacity: 0.9 }
    : { color, weight: 2, opacity: 0.75, dashArray: "7 5" };
}
fetch("granice.geojson").then((r) => r.json()).then((gj) => {
  borders = L.geoJSON(gj, { pane: "borders", style: borderStyle, interactive: false }).addTo(map);
}).catch(() => {});

function setMapStyle(key) {
  if (!MAP_STYLES[key]) key = "standard";
  currentStyle = key;
  if (borders) borders.setStyle(borderStyle);
  baseLayers.forEach((l) => map.removeLayer(l));
  // pod spodem zgrubna mapa kraju (zawsze poziom 7) – widać ją zamiast pustego tła, zanim wczytają się szczegóły
  baseLayers = [L.tileLayer(MAP_STYLES[key].layers[0][0], { minZoom: 6, maxZoom: 19, minNativeZoom: 7, maxNativeZoom: 7, keepBuffer: 4, zIndex: 1 })];
  MAP_STYLES[key].layers.forEach(([url, attribution], i) => baseLayers.push(
    new FlyTileLayer(url, { maxZoom: 19, maxNativeZoom: url.includes("arcgis") ? 16 : 19, keepBuffer: 4, zIndex: 2 + i, attribution })));
  baseLayers.forEach((l) => l.addTo(map));
  const el = document.getElementById("map");
  Object.keys(MAP_STYLES).forEach((k) => el.classList.toggle("ms-" + k, k === key));
  try { localStorage.setItem("styl-mapy", key); } catch {}
  document.querySelectorAll(".style-pick [data-style]").forEach((b) => b.classList.toggle("on", b.dataset.style === key));
  const cur = document.querySelector(".style-pick .cur");
  if (cur) cur.textContent = MAP_STYLES[key].label;
}
let savedStyle = "standard";
try { savedStyle = localStorage.getItem("styl-mapy") || "standard"; } catch {}
const stylePicker = L.control({ position: "bottomleft" });
stylePicker.onAdd = () => {
  const d = L.DomUtil.create("div", "style-pick");
  d.innerHTML = `<div class="menu hidden">${Object.entries(MAP_STYLES).map(([k, s]) =>
      `<button type="button" data-style="${k}"><span class="sw sw-${k}"></span>${s.label}</button>`).join("")}</div>
    <button type="button" class="toggle" title="Styl mapy">🗺 Mapa: <b class="cur"></b></button>`;
  L.DomEvent.disableClickPropagation(d);
  L.DomEvent.disableScrollPropagation(d);
  const menu = d.querySelector(".menu");
  d.querySelector(".toggle").onclick = () => menu.classList.toggle("hidden");
  d.querySelectorAll("[data-style]").forEach((b) => (b.onclick = () => { setMapStyle(b.dataset.style); menu.classList.add("hidden"); }));
  return d;
};
stylePicker.addTo(map);
setMapStyle(savedStyle);
map.on("click", () => document.querySelector(".style-pick .menu")?.classList.add("hidden"));
const layer = L.layerGroup().addTo(map);
const markers = {}; // id sklepu -> marker
map.on("zoomend", () => $("#map").classList.toggle("z", map.getZoom() >= 9));

// ------------------------------------------------------------------ API
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { "Content-Type": "application/json; charset=utf-8" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && j.login && EDITOR) { setEditor(false); render(); }
  if (!r.ok) throw new Error(j.error || r.statusText);
  if (j.mtime) mtime = j.mtime;
  return j;
}
function setEditor(on) {
  EDITOR = !!on;
  document.body.classList.toggle("editor", EDITOR);
  document.body.classList.toggle("has-login", LOGIN);
  document.body.classList.toggle("xlsx", D.kind === "xlsx");
}
function toast(msg, err) {
  const t = $("#toast");
  t.textContent = msg; t.className = "toast" + (err ? " err" : "");
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add("hidden"), err ? 6000 : 2500);
}

async function load(keepView) {
  D = await api("GET", "/api/data");
  mtime = D.mtime;
  const c = D.columns;
  const find = (re) => c.find((x) => re.test(x));
  COL = { name: c[0], address: find(/adres/i), region: find(/region/i), type: find(/rodzaj|typ/i) };
  $("#fileName").textContent = "Dane: " + D.file;
  // nazwa firmy z pliku marka/nazwa.txt na serwerze (opcjonalna)
  document.title = "Mapa sklepów" + (D.brand ? " | " + D.brand : "");
  $("#brandLogo").alt = D.brand || "";
  LOGIN = !!D.login;
  setEditor(D.editor);
  for (const r of [...F.reg]) if (r !== "∅" && !regionNames().includes(r)) F.reg.delete(r);
  render();
  renderLegend();
  if (!keepView) fitAll();
}

// ------------------------------------------------------------------ sklepy / usterki – pomocnicze
const nameOf = (s) => s[COL.name] || "";
const regionOf = (s) => { const r = (s[COL.region] || "").trim(); return r === "-" ? "" : r; };
const isPending = (s) => (s.Status || "").toLowerCase() === "pending";
const isFranchise = (s) => (s[COL.type] || "").trim().toLowerCase() === "franczyza";
// lokalizacja, która nie jest sklepem (region typu "inne") – nie liczy się do statystyk sklepów
const isOther = (s) => { const r = regionOf(s); return !!r && D.regions.some((x) => x.Region === r && x.Typ === "inne"); };
const isStore = (s) => !isOther(s);
const hasGeo = (s) => s.Lat !== "" && s.Lng !== "" && !isNaN(+s.Lat) && !isNaN(+s.Lng);
const isOpen = (i) => i.Status !== DONE;
const incFor = (s) => D.incidents.filter((i) => i.POS === nameOf(s));
const openIncFor = (s) => incFor(s).filter(isOpen);
const prioRank = (p) => Math.max(0, PRIORITIES.indexOf(p));
const topPriority = (incs) => incs.reduce((b, i) => (prioRank(i.Priorytet) > prioRank(b) ? i.Priorytet : b), PRIORITIES[0]);
const storeById = (id) => D.stores.find((s) => s.ID === id);

function regionColor(r) {
  if (!r) return NO_REGION;
  const conf = D.regions.find((x) => x.Region === r);
  if (conf && conf.Kolor) return conf.Kolor;
  let h = 0; for (const ch of r) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return EXTRA_COLORS[h % EXTRA_COLORS.length];
}
// regiony z konfiguracji + te, które występują w danych
function regionNames() {
  const names = D.regions.map((r) => r.Region);
  for (const s of D.stores) { const r = regionOf(s); if (r && !names.includes(r)) names.push(r); }
  return names;
}

// ------------------------------------------------------------------ pinezki
function pinHtml(s, incs, mini) {
  const cls = ["pin", isFranchise(s) ? "fr" : "", isPending(s) ? "op" : "", mini ? "mini" : ""].join(" ");
  const badge = incs && incs.length
    ? `<div class="inc-badge" style="background:${PRIO_COLOR[topPriority(incs)]}"><span>!</span>${incs.length > 1 ? `<b>${incs.length}</b>` : ""}</div>` : "";
  return `<div class="${cls}" style="--c:${regionColor(regionOf(s))}"><i></i>${badge}${mini ? "" : `<em>${esc(nameOf(s))}</em>`}</div>`;
}
const storeIcon = (s, incs) => L.divIcon({ className: "", html: pinHtml(s, incs), iconSize: [22.5, 22.5], iconAnchor: [11.25, 11.25], popupAnchor: [0, -10] });

// ------------------------------------------------------------------ filtry
function visible(s) {
  if (F.reg.size && !F.reg.has(regionOf(s) || "∅")) return false;
  if (F.kind === "iss" && !openIncFor(s).length) return false;
  if (F.kind === "open" && !isPending(s)) return false;
  if (F.own === "own" && isFranchise(s)) return false;
  if (F.own === "fr" && !isFranchise(s)) return false;
  if (F.q) {
    const hay = (Object.values(s).join(" ") + " " + incFor(s).map((i) => i.Komentarz).join(" ")).toLowerCase();
    if (!hay.includes(F.q)) return false;
  }
  return true;
}

function renderChips() {
  const names = regionNames();
  const count = (r) => D.stores.filter((s) => (regionOf(s) || "∅") === r).length;
  const noReg = count("∅");
  $("#chipsReg").innerHTML = `<span class="chip ${F.reg.size ? "" : "on"}" data-r="">Wszystkie</span>` +
    names.map((r) => `<span class="chip ${F.reg.has(r) ? "on" : ""}" data-r="${esc(r)}"><i style="background:${regionColor(r)}"></i>${esc(r)} <b>${count(r)}</b></span>`).join("") +
    (noReg ? `<span class="chip ${F.reg.has("∅") ? "on" : ""}" data-r="∅"><i style="background:${NO_REGION}"></i>Bez regionu <b>${noReg}</b></span>` : "");
  $("#chipsKind").innerHTML = [["all", "Wszystkie"], ["iss", "Z usterkami"], ["open", "Nowe otwarcia"]]
    .map(([k, l]) => `<span class="chip ${F.kind === k ? "on" : ""}" data-k="${k}">${l}</span>`).join("");
  $("#chipsOwn").innerHTML = [["all", "Wszystkie typy"], ["own", "Własne"], ["fr", "Franczyzy"]]
    .map(([k, l]) => `<span class="chip ${F.own === k ? "on" : ""}" data-o="${k}">${l}</span>`).join("");
  document.querySelectorAll("#chipsReg .chip").forEach((c) => (c.onclick = () => {
    const r = c.dataset.r;
    if (!r) F.reg.clear(); else F.reg.has(r) ? F.reg.delete(r) : F.reg.add(r);
    render();
  }));
  document.querySelectorAll("#chipsKind .chip").forEach((c) => (c.onclick = () => { F.kind = c.dataset.k; render(); }));
  document.querySelectorAll("#chipsOwn .chip").forEach((c) => (c.onclick = () => { F.own = c.dataset.o; render(); }));
}

// ------------------------------------------------------------------ rysowanie
// W trybie trasy kliknięcie pinezki dodaje przystanek zamiast otwierać dymek
const StoreMarker = L.Marker.extend({
  _openPopup(e) {
    if (routeRec) { L.DomEvent.stop(e); addStop(this.options.storeId); return; }
    L.Marker.prototype._openPopup.call(this, e);
  },
});
function render() {
  const openPopupId = Object.keys(markers).find((id) => markers[id].isPopupOpen());
  layer.clearLayers();
  for (const k in markers) delete markers[k];
  const vs = D.stores.filter(visible);
  for (const s of vs) if (hasGeo(s)) {
    const incs = openIncFor(s);
    const m = new StoreMarker([+s.Lat, +s.Lng], { icon: storeIcon(s, incs), zIndexOffset: incs.length ? 500 + prioRank(topPriority(incs)) * 100 : 0,
      riseOnHover: true, riseOffset: 10000, storeId: s.ID })   // pinezka pod kursorem wychodzi na wierzch
      .bindPopup(() => storePopup(s), { maxWidth: 380, autoPan: false }).addTo(layer);   // zamiast autoPan mapa płynnie dojeżdża (flyToStore)
    m.on("popupopen", () => { if (!quietPopup) flyToStore(m); });
    const tip = incs.length ? ` – usterki: ${incs.length} (${topPriority(incs)})` : "";
    m.bindTooltip(esc(nameOf(s) + tip), { direction: "top", offset: [0, -10] });
    markers[s.ID] = m;
  }
  if (openPopupId && markers[openPopupId]) openQuietly(markers[openPopupId]);
  // statystyki
  $("#sStores").textContent = D.stores.filter(isStore).length;
  $("#sIssues").textContent = D.incidents.filter(isOpen).length;
  $("#sNew").textContent = D.stores.filter((s) => isStore(s) && isPending(s)).length;
  $("#sFr").textContent = D.stores.filter((s) => isStore(s) && isFranchise(s)).length;
  renderChips();
  renderList(vs);
  drawRoute();
}

function renderList(vs) {
  const miss = D.stores.filter((s) => !hasGeo(s));
  const mb = $("#missing");
  mb.classList.toggle("hidden", !miss.length);
  mb.innerHTML = `<span>Bez lokalizacji: ${miss.length}</span><button class="btn sec sm ed" id="btnGeoAll">Geokoduj brakujące</button>`;
  $("#btnGeoAll").onclick = geocodeMissing;
  vs = [...vs].sort((a, b) => nameOf(a).localeCompare(nameOf(b), "pl"));
  $("#list").innerHTML = vs.map((s) => {
    const incs = openIncFor(s);
    return `<div class="item ${hasGeo(s) ? "" : "nogeo"}" data-id="${s.ID}">${pinHtml(s, null, true)}
      <div class="t"><b>${esc(nameOf(s))}</b><span>${esc(s[COL.address] || "")}</span></div>
      ${isOther(s) ? '<span class="tag">nie sklep</span>' : ""}${isPending(s) ? '<span class="tag">nowe</span>' : ""}${isFranchise(s) ? '<span class="tag">fr.</span>' : ""}
      ${incs.length ? `<span class="badge" style="background:${PRIO_COLOR[topPriority(incs)]}">${incs.length}</span>` : ""}</div>`;
  }).join("") || `<p class="mut" style="padding:12px">Brak wyników.</p>`;
  document.querySelectorAll("#list .item").forEach((el) => (el.onclick = () => (routeRec ? addStop(el.dataset.id) : focusOn(el.dataset.id))));
}

// Płynne przejścia; przy włączonym w systemie ograniczeniu animacji mapa przeskakuje od razu.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const FLY_S = 1.2;
let quietPopup = false;   // true = otwarcie dymka bez ruszania mapy (np. po odświeżeniu danych)
function openQuietly(m) {
  quietPopup = true;
  try { m.openPopup(); } finally { quietPopup = false; }
}
// Pinezka na środek, a przy wysokim dymku niżej – tak, żeby dymek zmieścił się nad nią
function flyToStore(m, zoom = map.getZoom()) {
  if ($("#map").classList.contains("picking")) return;
  const el = m.getPopup().getElement();
  const half = map.getSize().y / 2;
  const down = Math.max(0, (el ? el.offsetHeight : 0) + 35 - half);
  const to = map.unproject(map.project(m.getLatLng(), zoom).subtract([0, down]), zoom);
  const animate = !reducedMotion.matches;
  if (zoom === map.getZoom() && map.getBounds().contains(m.getLatLng())) map.panTo(to, { animate, duration: 0.6 });
  else {
    if (animate) flyStart(to, zoom);
    map.flyTo(to, zoom, { animate, duration: FLY_S });
  }
}

function focusOn(id) {
  const m = markers[id];
  if (m) { openQuietly(m); flyToStore(m, Math.max(map.getZoom(), 12)); return; }
  const s = storeById(id);
  if (s && !hasGeo(s)) EDITOR ? editStore(s) : toast("Ten sklep nie ma jeszcze lokalizacji na mapie.");
}
function fitAll(animated) {
  fitPoints(D.stores.filter((s) => hasGeo(s)).map((s) => [+s.Lat, +s.Lng]), animated);
}
function fitPoints(pts, animated, top = 30) {
  map.invalidateSize();
  if (!pts.length) return;
  const opt = { paddingTopLeft: [30, top], paddingBottomRight: [30, 30], maxZoom: 15 };
  if (!animated || reducedMotion.matches) { map.fitBounds(pts, { ...opt, animate: false }); return; }
  const t = map._getBoundsCenterZoom(L.latLngBounds(pts), opt);
  flyStart(t.center, t.zoom);
  map.flyTo(t.center, t.zoom, { duration: FLY_S });
}

// Przycisk w prawym górnym rogu: ten sam widok, co po otwarciu strony
const homeView = L.control({ position: "topright" });
homeView.onAdd = () => {
  const b = L.DomUtil.create("button", "home-view");
  b.type = "button";
  b.title = "Widok domyślny";
  b.setAttribute("aria-label", "Widok domyślny");
  b.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/></svg>`;
  L.DomEvent.disableClickPropagation(b);
  b.onclick = () => { map.closePopup(); fitAll(true); };
  return b;
};
homeView.addTo(map);
$(".home-view").insertAdjacentHTML("beforebegin", `<button type="button" class="home-view route-btn" id="btnRoute" title="Zaznacz trasę" aria-label="Zaznacz trasę" aria-pressed="false">
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="6" cy="19" r="2.5"/><circle cx="18" cy="5" r="2.5"/><path d="M8.5 19H16a3.5 3.5 0 0 0 0-7H8a3.5 3.5 0 0 1 0-7h7.5"/></svg></button>`);
L.DomEvent.disableClickPropagation($("#btnRoute"));

// ------------------------------------------------------------------ legenda
// Legenda da się zwinąć do przycisku „Legenda” (na telefonie domyślnie zwinięta). Wybór pamięta przeglądarka.
const legend = L.control({ position: "bottomright" });
legend.onAdd = () => {
  const d = L.DomUtil.create("div", "legend");
  d.innerHTML = `<button type="button" class="lg-toggle" aria-expanded="true"><span>Legenda</span><b class="lg-arrow">▾</b></button><div class="lg-body"></div>`;
  L.DomEvent.disableClickPropagation(d);
  L.DomEvent.disableScrollPropagation(d);
  d.querySelector(".lg-toggle").onclick = () => setLegendCollapsed(!d.classList.contains("collapsed"), true);
  return d;
};
legend.addTo(map);
function setLegendCollapsed(on, remember) {
  const d = legend.getContainer();
  d.classList.toggle("collapsed", on);
  d.querySelector(".lg-toggle").setAttribute("aria-expanded", String(!on));
  d.querySelector(".lg-toggle").title = on ? "Pokaż legendę" : "Ukryj legendę";
  if (remember) { try { localStorage.setItem("legenda-ukryta", on ? "1" : "0"); } catch {} }
}
{
  let saved = null;
  try { saved = localStorage.getItem("legenda-ukryta"); } catch {}
  setLegendCollapsed(saved === null ? window.matchMedia("(max-width: 760px)").matches : saved === "1", false);
}
function renderLegend() {
  const demo = (type, status) => pinHtml({ [COL.type]: type, Status: status, [COL.region]: "" }, null, false).replace(/<em>.*<\/em>/, "");
  const row = (sym, label) => `<div class="row"><span class="sym">${sym}</span>${label}</div>`;
  legend.getContainer().querySelector(".lg-body").innerHTML =
    regionNames().map((r) => row(`<i style="display:inline-block;width:11px;height:11px;border-radius:50%;background:${regionColor(r)}"></i>`, esc(r))).join("") +
    "<hr>" + row(demo("własny", "aktywny"), "własny") + row(demo("franczyza", "aktywny"), "franczyza") + row(demo("własny", "pending"), "nowe otwarcie") +
    "<hr>" + PRIORITIES.map((p) => row(`<div class="inc-badge" style="background:${PRIO_COLOR[p]}"><span>!</span></div>`, "usterka – " + p)).join("") +
    `<div class="mut ed" style="margin-top:4px">Prawy klik na mapie: dodaj sklep</div>`;
}

// ------------------------------------------------------------------ popup sklepu
function issueHtml(i) {
  return `<div class="iss ${isOpen(i) ? "" : "done"}" data-inc="${i.ID}" style="--pc:${isOpen(i) ? PRIO_COLOR[i.Priorytet] : "var(--bd)"}">
    <div class="t"><span>${esc(i.Komentarz) || "<i>bez opisu</i>"}</span></div>
    <button class="st ${clsOf(i.Status)}" data-a="cycle" ${EDITOR ? 'title="Kliknij, aby zmienić status"' : "disabled"}>${STATUS_LABEL[i.Status] || esc(i.Status)}</button>
    <button class="st ed" data-a="iedit" title="Edytuj">✎</button>
    <button class="st x ed" data-a="idel" title="Usuń">×</button>
    <div class="m"><div>priorytet: ${esc(i.Priorytet)} · ${esc(i["Data zgłoszenia"])}${i["Data zamknięcia"] ? " → " + esc(i["Data zamknięcia"]) : ""}</div>
      ${i["Data przewidywana"] ? `<div>przewidywane rozwiązanie: ${esc(i["Data przewidywana"].slice(0, 10))}</div>` : ""}</div></div>`;
}
function storePopup(s) {
  const el = document.createElement("div");
  el.className = "pop";
  const rows = D.columns.filter((c) => c !== COL.name && c !== COL.region && c !== COL.type && !APP_COLS.includes(c) && s[c] && s[c] !== "-")
    .map((c) => `<tr><td>${esc(c)}</td><td>${esc(s[c])}</td></tr>`).join("");
  const incs = incFor(s).sort((a, b) => isOpen(b) - isOpen(a) || prioRank(b.Priorytet) - prioRank(a.Priorytet));
  const r = regionOf(s);
  el.innerHTML = `<h3>${esc(nameOf(s))}</h3>
    <div class="tags"><span class="tag"><i style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${regionColor(r)}"></i> ${esc(r || "bez regionu")}</span>
    ${isPending(s) ? '<span class="tag">nowe otwarcie</span>' : ""}${isOther(s) ? '<span class="tag">lokalizacja (nie sklep)</span>' : `<span class="tag">${isFranchise(s) ? "franczyza" : esc(s[COL.type] || "własny")}</span>`}</div>
    <table>${rows}</table>
    <h4>Usterki</h4>${incs.map(issueHtml).join("") || '<div class="mut">Brak usterek.</div>'}
    <div class="btns ed">
      <button class="btn danger sm" data-a="inc">+ Usterka</button>
      <button class="btn sec sm" data-a="edit">Edytuj</button>
      <button class="btn sec sm" data-a="del" style="color:var(--danger)">Usuń</button>
    </div>`;
  el.querySelectorAll("[data-inc]").forEach((box) => {
    const i = D.incidents.find((x) => x.ID === box.dataset.inc);
    box.querySelector('[data-a="cycle"]').onclick = () =>
      saveIncident(i.ID, { Status: STATUSES[(STATUSES.indexOf(i.Status) + 1) % STATUSES.length] }, true);
    box.querySelector('[data-a="iedit"]').onclick = () => { map.closePopup(); editIncident(i); };
    box.querySelector('[data-a="idel"]').onclick = () => {
      if (confirm("Usunąć tę usterkę na stałe?\n(Aby zachować historię, ustaw status „Naprawiona”.)"))
        run(() => api("DELETE", "/api/incidents/" + i.ID), "Usterka usunięta", true);
    };
  });
  el.querySelector('[data-a="inc"]').onclick = () => { map.closePopup(); editIncident(null, s); };
  el.querySelector('[data-a="edit"]').onclick = () => { map.closePopup(); editStore(s); };
  el.querySelector('[data-a="del"]').onclick = () => {
    const n = incFor(s).length;
    if (confirm(`Usunąć sklep „${nameOf(s)}” z pliku ${D.file}?` + (n ? `\nZostanie też usuniętych ${n} usterek tego sklepu.` : "")))
      run(() => api("DELETE", "/api/stores/" + s.ID), "Sklep usunięty");
  };
  return el;
}

// ------------------------------------------------------------------ zapis
async function run(fn, msg, keepPopup) {
  try {
    await fn();
    if (!keepPopup) map.closePopup();
    await load(true);
    if (msg) toast(msg);
  } catch (e) { toast(e.message, true); }
}
const saveIncident = (id, data, keepPopup) => run(() => api(id ? "PUT" : "POST", "/api/incidents" + (id ? "/" + id : ""), data), "Zapisano w " + D.file, keepPopup);

// ------------------------------------------------------------------ wskazywanie na mapie
let pickCb = null;
function pick(cb) { if (routeRec) finishRoute(); pickCb = cb; $("#pickHint").classList.remove("hidden"); $("#map").classList.add("picking"); }
function endPick() { pickCb = null; $("#pickHint").classList.add("hidden"); $("#map").classList.remove("picking"); }
map.on("click", (e) => { if (pickCb) { const cb = pickCb; endPick(); cb(e.latlng); } });
$("#pickCancel").onclick = (e) => { e.preventDefault(); const cb = pickCb; endPick(); cb && cb(null); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pickCb) $("#pickCancel").click(); });

// ------------------------------------------------------------------ okna dialogowe
function dialog(title, html, onOk, okLabel = "Zapisz") {
  $("#dlgTitle").textContent = title;
  $("#dlgBody").innerHTML = html;
  $("#dlgOk").textContent = okLabel;
  const dlg = $("#dlg");
  $("#dlgCancel").onclick = () => dlg.close();
  $("#dlgForm").onsubmit = async (e) => {
    e.preventDefault();
    const ok = await onOk(new FormData($("#dlgForm")));
    if (ok !== false) dlg.close();
  };
  dlg.showModal();
  return dlg;
}
const options = (vals, cur, labels = {}) => vals.map((v) => `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc(labels[v] ?? v)}</option>`).join("");

function pickInto(dlg) {
  dlg.close();
  pick((ll) => {
    dlg.showModal();
    if (ll) { dlg.querySelector('[name="Lat"]').value = ll.lat.toFixed(7); dlg.querySelector('[name="Lng"]').value = ll.lng.toFixed(7); }
  });
}

function editStore(s, latlng) {
  const isNew = !s;
  s = s || { Status: "aktywny", Lat: latlng ? latlng.lat.toFixed(7) : "", Lng: latlng ? latlng.lng.toFixed(7) : "" };
  const types = [...new Set(["własny", "franczyza", ...D.stores.map((x) => (x[COL.type] || "").trim().toLowerCase()).filter(Boolean)])];
  const fields = D.columns.filter((c) => !APP_COLS.includes(c)).map((c) => {
    const v = s[c] || "";
    if (c === COL.address)
      return `<div class="frow full"><label>${esc(c)}<input name="${esc(c)}" value="${esc(v)}"></label><button type="button" class="btn sec" id="btnGeo">Znajdź na mapie</button></div>`;
    if (c === COL.region)
      return `<label>${esc(c)}<select name="${esc(c)}"><option value="">— bez regionu —</option>${options([...new Set([...regionNames(), regionOf(s)].filter(Boolean))], regionOf(s))}</select></label>`;
    if (c === COL.type)
      return `<label>${esc(c)}<select name="${esc(c)}"><option value=""></option>${options(types, (v || "").toLowerCase())}</select></label>`;
    const full = c === COL.name ? " full" : "";
    return `<label class="${full}">${esc(c)}<input type="${/^data/i.test(c) ? "date" : "text"}" name="${esc(c)}" value="${esc(v)}" ${c === COL.name ? "required" : ""}></label>`;
  }).join("");
  const html = `${fields}
    <label>Status<select name="Status">${options(["aktywny", "pending"], isPending(s) ? "pending" : "aktywny", { aktywny: "aktywny", pending: "nowe otwarcie" })}</select></label><div></div>
    <div class="frow full"><label>Szerokość (lat)<input name="Lat" value="${esc(s.Lat)}"></label><label>Długość (lng)<input name="Lng" value="${esc(s.Lng)}"></label>
      <button type="button" class="btn sec" id="btnPick">Wskaż na mapie</button></div>
    <div class="geo-info full" id="geoInfo"></div>`;
  const dlg = dialog(isNew ? "Nowy sklep" : "Edytuj: " + nameOf(s), html, async (fd) => {
    const data = Object.fromEntries(fd.entries());
    let res;
    try { res = await api(isNew ? "POST" : "PUT", "/api/stores" + (isNew ? "" : "/" + s.ID), data); }
    catch (e) { toast(e.message, true); return false; }
    await load(true); toast("Zapisano w " + D.file);
    setTimeout(() => focusOn(res.record.ID), 50);
  });
  dlg.querySelector("#btnGeo").onclick = async () => {
    const q = dlg.querySelector(`[name="${CSS.escape(COL.address)}"]`).value;
    if (!q) return;
    $("#geoInfo").textContent = "Szukam…";
    try {
      const r = await api("GET", "/api/geocode?q=" + encodeURIComponent(q));
      dlg.querySelector('[name="Lat"]').value = r.lat.toFixed(7);
      dlg.querySelector('[name="Lng"]').value = r.lng.toFixed(7);
      $("#geoInfo").textContent = "Znaleziono: " + r.label;
    } catch (e) { $("#geoInfo").textContent = e.message + " – użyj „Wskaż na mapie”."; }
  };
  dlg.querySelector("#btnPick").onclick = () => pickInto(dlg);
}

function editIncident(i, store) {
  const isNew = !i;
  i = i || { POS: store ? nameOf(store) : "", Priorytet: "średni", Status: "nowa", Komentarz: "" };
  const names = D.stores.map(nameOf).filter(Boolean).sort((a, b) => a.localeCompare(b, "pl"));
  const html = `
    <label class="full">Sklep<select name="POS" required><option value="">— wybierz sklep —</option>${options(names, i.POS)}</select></label>
    <div class="full"><label>Priorytet</label><div class="prio">${PRIORITIES.map((p) =>
      `<label style="--pc:${PRIO_COLOR[p]}"><input type="radio" name="Priorytet" value="${p}" ${i.Priorytet === p ? "checked" : ""}>${p}</label>`).join("")}</div></div>
    <label class="full">Opis usterki<textarea name="Komentarz" placeholder="Co nie działa, co trzeba zrobić…">${esc(i.Komentarz)}</textarea></label>
    <label class="full">Przewidywana data rozwiązania<input type="date" name="Data przewidywana" value="${esc((i["Data przewidywana"] || "").slice(0, 10))}"></label>
    <label class="full">Status<select name="Status">${options(STATUSES, i.Status, STATUS_LABEL)}</select></label>`;
  dialog(isNew ? "Nowa usterka" : "Edytuj usterkę", html, async (fd) => {
    const data = Object.fromEntries(fd.entries());
    try { await api(isNew ? "POST" : "PUT", "/api/incidents" + (isNew ? "" : "/" + i.ID), data); }
    catch (e) { toast(e.message, true); return false; }
    await load(true); toast("Usterka zapisana w " + D.file);
    const s = D.stores.find((x) => nameOf(x) === data.POS);
    if (s) setTimeout(() => focusOn(s.ID), 50);
  });
}

function editRegions() {
  const counts = (r) => D.stores.filter((s) => regionOf(s) === r).length;
  const typeOf = (r) => (D.regions.find((x) => x.Region === r) || {}).Typ || "sklepy";
  const otherBox = (on) => `<label class="oth" title="Lokalizacje, które nie są sklepami – nie liczą się do statystyk"><input type="checkbox" class="ro" ${on ? "checked" : ""}> nie sklepy</label>`;
  const rows = (list) => list.map((r) => `<div class="reg-row full" data-old="${esc(r)}">
      <input type="color" value="${regionColor(r)}"><input class="rn" value="${esc(r)}">${otherBox(typeOf(r) === "inne")}<span class="cnt">${counts(r)} lok.</span></div>`).join("");
  const dlg = dialog("Regiony – nazwy i kolory",
    `<p class="mut full" style="margin:0;font-size:12px">Zmiana nazwy zmienia też kolumnę „${esc(COL.region || "Region")}” we wszystkich sklepach tego regionu. „Nie sklepy” = lokalizacje (np. magazyny), które nie liczą się do statystyk sklepów.</p>
     <div class="full" id="regRows" style="display:flex;flex-direction:column;gap:8px">${rows(regionNames())}</div>
     <div class="full"><button type="button" class="btn sec sm" id="regAdd">+ Dodaj region</button></div>`,
    async () => {
      const items = [...dlg.querySelectorAll(".reg-row")].map((row) => ({
        old: row.dataset.old, name: row.querySelector(".rn").value.trim(), color: row.querySelector("input[type=color]").value,
        type: row.querySelector(".ro").checked ? "inne" : "sklepy",
      })).filter((x) => x.name);
      const names = items.map((x) => x.name);
      if (new Set(names).size !== names.length) { toast("Nazwy regionów muszą być unikalne", true); return false; }
      try { await api("PUT", "/api/regions", { regions: items }); } catch (e) { toast(e.message, true); return false; }
      await load(true); toast("Regiony zapisane");
    });
  dlg.querySelector("#regAdd").onclick = () => {
    dlg.querySelector("#regRows").insertAdjacentHTML("beforeend",
      `<div class="reg-row full" data-old=""><input type="color" value="${EXTRA_COLORS[0]}"><input class="rn" placeholder="Nazwa regionu">${otherBox(false)}<span class="cnt">nowy</span></div>`);
  };
}

// ------------------------------------------------------------------ geokodowanie brakujących
async function geocodeMissing() {
  const miss = D.stores.filter((s) => !hasGeo(s) && s[COL.address]);
  const noAddr = D.stores.filter((s) => !hasGeo(s) && !s[COL.address]).length;
  if (!miss.length) return toast(`Brak adresów do sprawdzenia${noAddr ? ` (${noAddr} bez adresu – edytuj i użyj „Wskaż na mapie”)` : ""}`, true);
  if (!confirm(`Wyszukać ${miss.length} adres(ów) w OpenStreetMap? (~1 s każdy)`)) return;
  let ok = 0;
  for (const [n, s] of miss.entries()) {
    toast(`Geokodowanie ${n + 1}/${miss.length}: ${nameOf(s)}`);
    try {
      const r = await api("GET", "/api/geocode?q=" + encodeURIComponent(s[COL.address]));
      await api("PUT", "/api/stores/" + s.ID, { Lat: r.lat.toFixed(7), Lng: r.lng.toFixed(7) });
      ok++;
    } catch (e) { if (/Excel/.test(e.message)) { toast(e.message, true); break; } }
  }
  await load(true);
  toast(`Znaleziono ${ok}/${miss.length}.` + (noAddr ? ` ${noAddr} bez adresu – ustaw ręcznie.` : ""));
}

// ------------------------------------------------------------------ Excel: pobieranie / wgrywanie
$("#btnXlsxDown").onclick = () => { const a = document.createElement("a"); a.href = "/api/xlsx"; a.click(); };
$("#btnXlsxUp").onclick = () => $("#fileXlsx").click();
$("#fileXlsx").onchange = async (e) => {
  const f = e.target.files[0];
  e.target.value = "";
  if (!f) return;
  if (!/\.xlsx$/i.test(f.name)) return toast("Wybierz plik .xlsx", true);
  if (!confirm(`Zastąpić WSZYSTKIE dane na serwerze plikiem ${f.name}?\n\n` +
      `Wskazówka: najpierw pobierz aktualny plik („Pobierz Excel”), zmień go i wgraj – inaczej zmiany zrobione w międzyczasie na mapie przepadną.\n\n` +
      `Kopia obecnych danych zostanie zapisana na serwerze w folderze „kopie”.`)) return;
  try {
    toast("Wgrywanie…");
    const r = await fetch("/api/xlsx", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: f });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && j.login) { setEditor(false); render(); }
    if (!r.ok) throw new Error(j.error || r.statusText);
    await load();
    toast(`Wgrano: ${j.stores} sklepów, ${j.incidents} usterek` + (j.orphans ? ` (${j.orphans} usterek wskazuje na nieistniejący sklep)` : ""));
  } catch (err) { toast(err.message, true); }
};

// ------------------------------------------------------------------ logowanie do edycji
function loginDialog() {
  dialog("Logowanie do edycji",
    `<p class="mut full" style="margin:0;font-size:12px">Oglądanie mapy nie wymaga logowania. Hasło jest potrzebne, aby dodawać i zmieniać sklepy, usterki i regiony.</p>
     <label class="full">Hasło<input type="password" name="password" autocomplete="current-password" required autofocus></label>`,
    async (fd) => {
      try { await api("POST", "/api/login", { password: fd.get("password") }); }
      catch (e) { toast(e.message, true); return false; }
      await load(true);
      toast("Zalogowano – możesz edytować");
    }, "Zaloguj");
}
$("#btnLogin").onclick = loginDialog;
$("#btnLogout").onclick = async () => {
  try { await api("POST", "/api/logout"); } catch {}
  map.closePopup();
  await load(true);
  toast("Wylogowano");
};

// ------------------------------------------------------------------ motyw i ukrywanie menu
const ls = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
function setTheme(v) { const r = document.documentElement; if (v === "light" || v === "dark") r.setAttribute("data-theme", v); else r.removeAttribute("data-theme"); }
const th = ls.get("motyw-menu") || "auto";
setTheme(th); $("#theme").value = th;
$("#theme").onchange = (e) => { setTheme(e.target.value); ls.set("motyw-menu", e.target.value); };
if (ls.get("menu-ukryte") === "1") $("#app").classList.add("collapsed");
$("#toggleMenu").onclick = () => {
  const c = $("#app").classList.toggle("collapsed");
  ls.set("menu-ukryte", c ? "1" : "0");
  setTimeout(() => map.invalidateSize(), 50);
};

// ------------------------------------------------------------------ trasa (same proste linie między lokalizacjami)
// Przycisk włącza zaznaczanie, kolejne kliknięcia pinezek (albo pozycji listy) dodają przystanki, drugie kliknięcie
// przycisku zapisuje listę w tej przeglądarce i otwiera panel. Trasę po drogach liczy dopiero Google po kliknięciu linku.
let routeRec = false, routeBackup = [];
let routeIds = [];
try { const a = JSON.parse(ls.get("trasa") || "[]"); if (Array.isArray(a)) routeIds = a.filter((x) => typeof x === "string"); } catch {}
let routeOpen = ls.get("trasa-zwinieta") !== "1";
map.createPane("route");
map.getPane("route").style.zIndex = 450;           // nad granicami, pod pinezkami
map.getPane("route").style.pointerEvents = "none";
map.createPane("routeNum");
map.getPane("routeNum").style.zIndex = 640;        // numery nad pinezkami, pod dymkami
map.getPane("routeNum").style.pointerEvents = "none";
const routeLayer = L.layerGroup().addTo(map);

const routeStops = () => routeIds.map(storeById).filter((s) => s && hasGeo(s));
const stopLatLng = (s) => L.latLng(+s.Lat, +s.Lng);
// w trakcie zaznaczania lista jest tylko w pamięci; zapisuje ją zakończenie (finishRoute)
function setRoute(ids) { routeIds = ids; if (!routeRec) saveRoute(); drawRoute(); }
function saveRoute() { ls.set("trasa", JSON.stringify(routeIds)); }

function addStop(id) {
  const s = storeById(id);
  if (!s || !hasGeo(s)) return toast("Ten sklep nie ma jeszcze lokalizacji na mapie.");
  const stops = routeStops();
  if (stops.length && stops[stops.length - 1].ID === id) return;   // drugi klik w tę samą pinezkę
  setRoute([...stops.map((x) => x.ID), id]);
}
function startRoute() {
  if (pickCb) $("#pickCancel").click();
  map.closePopup();
  routeBackup = routeIds;
  routeRec = true;
  drawRoute();
}
function finishRoute() {
  routeRec = false;
  saveRoute();
  if (routeStops().length) setPanelOpen(true); else { drawRoute(); toast("Nie wybrano żadnego przystanku"); }
}
function setPanelOpen(open) {
  routeOpen = open;
  ls.set("trasa-zwinieta", open ? "0" : "1");
  drawRoute();
}
// Google przyjmuje start + 9 przystanków + cel (przeglądarki w telefonach: 3 przystanki) – dłuższa trasa = kilka linków
function googleLinks(stops) {
  const max = matchMedia("(pointer: coarse)").matches ? 5 : 11;
  const pt = (s) => `${+s.Lat},${+s.Lng}`;
  const out = [];
  for (let i = 0; i < stops.length - 1; i += max - 1) {
    const part = stops.slice(i, i + max);
    const q = new URLSearchParams({ api: "1", origin: pt(part[0]), destination: pt(part[part.length - 1]), travelmode: "driving" });
    if (part.length > 2) q.set("waypoints", part.slice(1, -1).map(pt).join("|"));
    out.push({ url: "https://www.google.com/maps/dir/?" + q, from: i + 1, to: i + part.length });
  }
  return out;
}

function drawRoute() {
  const stops = routeStops();
  const pts = stops.map(stopLatLng);
  routeLayer.clearLayers();
  if (pts.length > 1) {
    L.polyline(pts, { pane: "route", color: "#fff", weight: 7, opacity: 0.9, interactive: false }).addTo(routeLayer);
    L.polyline(pts, { pane: "route", color: "#7c3aed", weight: 4, interactive: false }).addTo(routeLayer);
  }
  const nums = new Map();   // ta sama lokalizacja może być na trasie kilka razy
  stops.forEach((s, i) => nums.set(s.ID, [...(nums.get(s.ID) || []), i + 1]));
  for (const [id, n] of nums)
    L.marker(stopLatLng(storeById(id)), { pane: "routeNum", interactive: false, keyboard: false,
      icon: L.divIcon({ className: "route-num", html: `<span>${n.join(", ")}</span>`, iconSize: [0, 0] }) }).addTo(routeLayer);

  const b = $("#btnRoute");
  b.classList.toggle("on", routeRec);
  b.setAttribute("aria-pressed", routeRec);
  b.title = routeRec ? "Zakończ i pokaż listę" : stops.length ? "Dodaj kolejne przystanki" : "Zaznacz trasę";
  b.setAttribute("aria-label", b.title);
  $("#map").classList.toggle("routing", routeRec);
  $("#routeHint").classList.toggle("hidden", !routeRec);
  $("#routeCount").textContent = stops.length;

  const p = $("#routePanel");
  p.classList.toggle("hidden", routeRec || !stops.length);
  p.classList.toggle("min", !routeOpen);
  if (routeRec || !stops.length) return;
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += pts[i - 1].distanceTo(pts[i]);
  const km = (m / 1000).toLocaleString("pl", { maximumFractionDigits: m < 100000 ? 1 : 0 });
  const links = googleLinks(stops);
  const scroll = p.querySelector(".rp-list")?.scrollTop || 0;
  p.innerHTML = `<div class="rp-head"><b>Trasa</b><span class="mut">przystanki: ${stops.length}</span>
      <button type="button" class="rp-min" aria-expanded="${routeOpen}">${routeOpen ? "Zwiń ▴" : "Rozwiń ▾"}</button></div>
    <div class="rp-body">
      <ol class="rp-list">${stops.map((s, i) => `<li data-i="${i}"><span class="rp-n">${i + 1}</span>
        <button type="button" class="rp-name" data-a="go"><b>${esc(nameOf(s))}</b><span>${esc(s[COL.address] || "")}</span></button>
        <button type="button" class="st" data-a="up" title="Wyżej" aria-label="Wyżej" ${i ? "" : "disabled"}>▲</button>
        <button type="button" class="st" data-a="down" title="Niżej" aria-label="Niżej" ${i < stops.length - 1 ? "" : "disabled"}>▼</button>
        <button type="button" class="st x" data-a="del" title="Usuń z trasy" aria-label="Usuń z trasy">✕</button></li>`).join("")}</ol>
      <div class="rp-foot">
        <span class="mut">${stops.length > 1 ? `W linii prostej: ${km} km` : "Dodaj co najmniej dwa przystanki, aby otworzyć trasę w Google Maps."}</span>
        ${links.map((l) => `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">Otwórz w Google Maps${links.length > 1 ? ` (${l.from}–${l.to})` : ""}</a>`).join("")}
        <div class="rp-btns"><button type="button" class="btn sec sm" data-a="add">+ Dodaj przystanki</button>
        <button type="button" class="btn sec sm" data-a="clear">Wyczyść trasę</button></div>
      </div></div>`;
  p.querySelector(".rp-list").scrollTop = scroll;
}
$("#btnRoute").onclick = () => (routeRec ? finishRoute() : startRoute());
$("#routeUndo").onclick = (e) => { e.preventDefault(); setRoute(routeStops().slice(0, -1).map((s) => s.ID)); };
$("#routeCancel").onclick = (e) => { e.preventDefault(); routeRec = false; setRoute(routeBackup); };
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && routeRec && !$("#dlg").open) $("#routeCancel").click(); });
$("#routePanel").onclick = (e) => {
  if (e.target.closest(".rp-min")) {
    setPanelOpen(!routeOpen);
    if (!routeOpen) { map.closePopup(); fitPoints(routeStops().map(stopLatLng), true, 110); }   // zwinięcie = pokaż całą trasę
    return;
  }
  const a = e.target.closest("[data-a]")?.dataset.a;
  if (!a) return;
  const ids = routeStops().map((s) => s.ID);
  const i = +(e.target.closest("li")?.dataset.i ?? -1);
  const swap = (j) => { [ids[i], ids[j]] = [ids[j], ids[i]]; setRoute(ids); };
  if (a === "go") {
    if (markers[ids[i]]) focusOn(ids[i]);
    else toast("Ta lokalizacja jest ukryta przez filtry listy.");
  } else if (a === "up") swap(i - 1);
  else if (a === "down") swap(i + 1);
  else if (a === "del") { ids.splice(i, 1); setRoute(ids); }
  else if (a === "add") startRoute();
  else if (a === "clear" && confirm("Wyczyścić trasę?")) setRoute([]);
};

// ------------------------------------------------------------------ przyciski i zdarzenia
$("#btnAddStore").onclick = () => editStore(null);
$("#btnAddIncident").onclick = () => editIncident(null);
$("#btnRegions").onclick = editRegions;
$("#btnReload").onclick = () => load(true).then(() => toast("Wczytano ponownie " + D.file));
$("#search").oninput = (e) => { F.q = e.target.value.trim().toLowerCase(); render(); };
map.on("contextmenu", (e) => {
  if (!EDITOR) return;
  L.popup().setLatLng(e.latlng).setContent(() => {
    const d = document.createElement("div");
    d.innerHTML = `<button class="btn sm">+ Dodaj sklep tutaj</button>`;
    d.querySelector("button").onclick = () => { map.closePopup(); editStore(null, e.latlng); };
    return d;
  }).openOn(map);
});
// zmiany zrobione bezpośrednio w pliku (Excel) wczytują się same
setInterval(async () => {
  if ($("#dlg").open || pickCb) return;
  try {
    const v = await (await fetch("/api/version")).json();
    if (v.mtime && v.mtime !== mtime) { await load(true); toast("Plik się zmienił – wczytano ponownie"); }
  } catch {}
}, 5000);

load().catch((e) => toast("Nie można wczytać danych: " + e.message, true));
