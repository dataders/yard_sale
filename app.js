/* Yard sale browser — all logic lives here (external file so in-app webviews
   that block inline <script> still run it). Data comes from data/sales.js. */

// --- on-screen diagnostics: surface any error where a phone user can read it ---
function showError(msg) {
  const bar = document.getElementById("errbar");
  if (bar) { bar.textContent = "⚠ " + msg; bar.hidden = false; }
}
window.addEventListener("error", e =>
  showError((e.message || "Script error") + (e.lineno ? "  (line " + e.lineno + ")" : "")));
window.addEventListener("unhandledrejection", e =>
  showError("Load failed: " + ((e.reason && (e.reason.message || e.reason)) || "unknown")));

const COLORS = { "Forest Hill": "#7b2d8e", "Westover Hills": "#1c6e8c", both: "#b85c00" };
const srcColor = s => s.length > 1 ? COLORS.both : (COLORS[s[0]] || "#555");
const srcLabel = s => s.length > 1 ? "Both neighborhoods" : s[0];

let SALES = [];
let byStreet = new Map();        // street -> sale record
let filter = "all";
const cats = new Set();   // selected categories; empty = show all
let query = "";
const markers = new Map();       // street -> leaflet marker
const route = [];                // ordered array of streets (selected stops)
let selected = null;             // highlighted (clicked) street
let userLoc = null;              // {lat, lon}
let meMarker = null, meCircle = null, routeLine = null;

let map = null;
if (typeof L === "undefined") {
  showError("Map library didn't load. Reload the page (pull down to refresh).");
} else {
  try {
    const el = document.getElementById("map");
    if (el._leaflet_id) { el._leaflet_id = null; }   // guard against double-init
    map = L.map(el, { scrollWheelZoom: true })
      .setView([37.5225, -77.479], 14);              // Richmond 23225
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);
  } catch (e) {
    showError("Map setup failed: " + e.message);   // list still works below
  }
}

/* ---------- geometry helpers ---------- */
function haversine(a, b) {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toR, dLon = (b.lon - a.lon) * toR;
  const la1 = a.lat * toR, la2 = b.lat * toR;
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += haversine(pts[i-1], pts[i]);
  return d;
}
// Nearest-neighbor ordering of `stops` beginning nearest to `start`,
// then 2-opt improvement. `start` is fixed at the front if provided.
function optimize(stops, start) {
  if (stops.length <= 2) return stops.slice();
  const remaining = stops.slice();
  const order = [];
  let cur = start || remaining.shift();
  if (!start) order.push(cur);
  while (remaining.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversine(cur, remaining[i]);
      if (d < bd) { bd = d; bi = i; }
    }
    cur = remaining.splice(bi, 1)[0];
    order.push(cur);
  }
  // 2-opt over `order` (keeping an optional fixed start point out front)
  const seq = start ? [start, ...order] : order;
  const fixed = start ? 1 : 0;
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = fixed; i < seq.length - 1; i++) {
      for (let k = i + 1; k < seq.length; k++) {
        const a = seq[i-1] || seq[i], b = seq[i];
        const c = seq[k], d = seq[k+1];
        if (!d && i === fixed) continue;
        const before = haversine(a, b) + (d ? haversine(c, d) : 0);
        const after = haversine(a, c) + (d ? haversine(b, d) : 0);
        if (after + 1e-6 < before) {
          let lo = i, hi = k;
          while (lo < hi) { const t = seq[lo]; seq[lo] = seq[hi]; seq[hi] = t; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return start ? seq.slice(1) : seq;
}

/* ---------- markers ---------- */
function makeIcon(sale, big) {
  const idx = route.indexOf(sale.street);
  if (idx >= 0) {
    const d = 24;
    return L.divIcon({ className: "",
      html: `<div class="numpin" style="width:${d}px;height:${d}px">${idx+1}</div>`,
      iconSize: [d, d], iconAnchor: [d/2, d/2] });
  }
  const c = srcColor(sale.sources);
  const d = big ? 19 : 13;
  return L.divIcon({ className: "",
    html: `<div class="dot" style="width:${d}px;height:${d}px;background:${c}"></div>`,
    iconSize: [d, d], iconAnchor: [d/2, d/2] });
}
function refreshIcon(street) {
  const m = markers.get(street), s = byStreet.get(street);
  if (m && s) m.setIcon(makeIcon(s, street === selected));
}
const mapsLink = addr =>
  "https://www.google.com/maps/search/?api=1&query=" + encodeURIComponent(addr);

function popupHtml(s) {
  const inRoute = route.includes(s.street);
  let h = `<div class="pa">${s.street}</div>`;
  h += `<div style="font-size:.72rem;color:${srcColor(s.sources)};text-transform:uppercase">${srcLabel(s.sources)}</div>`;
  if (s.items) h += `<div style="margin-top:5px">${s.items}</div>`;
  if (s.categories && s.categories.length)
    h += `<div class="cats">` + s.categories.map(c => `<span class="cat">${c}</span>`).join("") + `</div>`;
  h += `<div style="margin-top:6px"><a target="_blank" rel="noopener" href="${mapsLink(s.address)}">Directions ↗</a></div>`;
  h += `<button class="addbtn ${inRoute ? "added" : ""}" onclick="toggleRoute('${s.street.replace(/'/g, "\\'")}')">`
     + `${inRoute ? "✓ In route" : "+ Add to route"}</button>`;
  return h;
}

/* ---------- route ---------- */
function toggleRoute(street) {
  const i = route.indexOf(street);
  if (i >= 0) route.splice(i, 1);
  else route.push(street);
  reorderRoute();
}
function reorderRoute() {
  // Re-optimize the current route set and redraw everything.
  const stops = route.map(st => byStreet.get(st)).filter(Boolean);
  const start = (document.getElementById("startHere").checked && userLoc) ? userLoc : null;
  const ordered = optimize(stops, start);
  route.length = 0;
  ordered.forEach(s => route.push(s.street));
  renderRoute(start, ordered);
  render();                       // refresh list checkboxes
  markers.forEach((_, st) => refreshIcon(st));
}
function renderRoute(start, ordered) {
  const panel = document.getElementById("route");
  panel.classList.toggle("empty", route.length === 0);
  if (route.length) { panel.classList.remove("collapsed"); document.getElementById("rtoggle").textContent = "▾"; }

  const ol = document.getElementById("rlist");
  ol.innerHTML = "";
  ordered.forEach((s, i) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="num">${i+1}</span><span>${s.street}</span><span class="x" title="remove">✕</span>`;
    li.querySelector(".x").onclick = () => toggleRoute(s.street);
    li.querySelector("span:nth-child(2)").style.cursor = "pointer";
    li.querySelector("span:nth-child(2)").onclick = () => select(s.street, false);
    ol.appendChild(li);
  });
  document.getElementById("rtitle").textContent = `Route · ${route.length} stop${route.length===1?"":"s"}`;

  // draw line through (optional start +) ordered stops
  if (routeLine && map) { map.removeLayer(routeLine); routeLine = null; }
  const pts = [...(start ? [start] : []), ...ordered];
  if (pts.length >= 2) {
    if (map) routeLine = L.polyline(pts.map(p => [p.lat, p.lon]),
      { color: "#d62828", weight: 4, opacity: .75, dashArray: "1 8", lineCap: "round" }).addTo(map);
    const meters = pathLength(pts);
    document.getElementById("rstats").textContent =
      `≈ ${(meters/1609.34).toFixed(2)} mi door-to-door` + (start ? " from your location" : "");
  } else {
    document.getElementById("rstats").textContent =
      route.length === 1 ? "Add another stop to build a route." : "";
  }

  // Google Maps directions handoff, stops in optimized order
  const g = document.getElementById("gmaps");
  if (ordered.length >= 1) {
    const wp = [...(start ? [start] : []), ...ordered].map(p => `${p.lat},${p.lon}`);
    const origin = wp.shift();
    const dest = wp.pop() || origin;
    let url = `https://www.google.com/maps/dir/?api=1&travelmode=driving&origin=${origin}&destination=${dest}`;
    if (wp.length) url += `&waypoints=${wp.join("|")}`;
    g.href = url;
    g.style.display = "";
  } else {
    g.style.display = "none";
  }
}

/* ---------- list + selection ---------- */
function visible(s) {
  if (filter !== "all" && !s.sources.includes(filter)) return false;
  if (cats.size && !(s.categories || []).some(c => cats.has(c))) return false;
  if (query) {
    const hay = (s.street + " " + (s.items || "")).toLowerCase();
    if (!hay.includes(query)) return false;
  }
  return true;
}
function select(street, fromMap) {
  selected = street;
  document.querySelectorAll(".item").forEach(el =>
    el.classList.toggle("sel", el.dataset.street === street));
  markers.forEach((_, st) => refreshIcon(st));
  const m = markers.get(street);
  if (m && map) {
    if (!fromMap) map.setView(m.getLatLng(), Math.max(map.getZoom(), 16), { animate: true });
    m.setPopupContent(popupHtml(byStreet.get(street)));
    m.openPopup();
    if (fromMap) {
      const el = document.querySelector(`.item[data-street="${CSS.escape(street)}"]`);
      if (el) el.scrollIntoView({ block: "nearest" });
    }
  }
}
function render() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  let shown = 0;
  for (const s of SALES) {
    const m = markers.get(s.street), show = visible(s);
    if (m && map) { if (show) m.addTo(map); else map.removeLayer(m); }
    if (!show) continue;
    shown++;
    const div = document.createElement("div");
    div.className = "item" + (s.street === selected ? " sel" : "");
    div.dataset.street = s.street;
    const checked = route.includes(s.street) ? "checked" : "";
    div.innerHTML =
      `<label class="pick"><input type="checkbox" ${checked}></label>` +
      `<div class="body">` +
        `<div class="addr">${s.street}</div>` +
        `<div class="src" style="color:${srcColor(s.sources)}">${srcLabel(s.sources)}</div>` +
        (s.items ? `<div class="items">${s.items}</div>` : "") +
      `</div>`;
    div.querySelector(".pick input").onclick = e => { e.stopPropagation(); toggleRoute(s.street); };
    div.querySelector(".pick").onclick = e => e.stopPropagation();
    div.querySelector(".body").onclick = () => select(s.street, false);
    list.appendChild(div);
  }
  document.getElementById("count").textContent = `${shown} of ${SALES.length} sales shown`;
}

/* ---------- geolocation ---------- */
function locateMe(silent = false) {
  if (!navigator.geolocation) { if (!silent) alert("Geolocation isn't available in this browser."); return; }
  const btn = document.getElementById("locate");
  btn.textContent = "…";
  navigator.geolocation.getCurrentPosition(pos => {
    btn.textContent = "◎"; btn.classList.add("on");
    userLoc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    const acc = pos.coords.accuracy || 30;
    if (map) {
      if (meMarker) map.removeLayer(meMarker);
      if (meCircle) map.removeLayer(meCircle);
      meMarker = L.marker([userLoc.lat, userLoc.lon], {
        icon: L.divIcon({ className: "", html: `<div class="mepin" style="width:16px;height:16px"></div>`,
          iconSize: [16,16], iconAnchor: [8,8] }), zIndexOffset: 1000
      }).addTo(map).bindPopup("You are here");
      meCircle = L.circle([userLoc.lat, userLoc.lon], { radius: acc, color: "#1a73e8", weight: 1, fillOpacity: .1 }).addTo(map);
      map.setView([userLoc.lat, userLoc.lon], Math.max(map.getZoom(), 15));
    }
    if (route.length) reorderRoute();    // fold location into an existing route
  }, err => {
    btn.textContent = "◎";
    if (!silent) alert("Couldn't get your location: " + err.message);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

/* ---------- boot ---------- */
function boot(data) {
  if (!data || !data.sales) { showError("Sale data didn't load. Reload the page."); return; }
  SALES = data.sales.filter(s => typeof s.lat === "number");
  SALES.sort((a, b) => a.street.localeCompare(b.street, undefined, { numeric: true }));
  SALES.forEach(s => byStreet.set(s.street, s));
  document.getElementById("subtitle").textContent =
    `${data.date} · ${data.time} · ${SALES.length} sales`;

  const pts = [];
  if (map) {
    for (const s of SALES) {
      const m = L.marker([s.lat, s.lon], { icon: makeIcon(s, false) });
      m.bindPopup(popupHtml(s));
      m.on("click", () => select(s.street, true));
      markers.set(s.street, m);
      pts.push([s.lat, s.lon]);
    }
    if (pts.length) map.fitBounds(pts, { padding: [30, 30] });
  }
  populateCategories();
  render();                                  // list renders with or without a map
}

// Build the category filter as toggleable chips (multi-select; empty = all).
// Selecting several shows sales matching ANY of the chosen categories.
function populateCategories() {
  const counts = new Map();
  for (const s of SALES)
    for (const c of (s.categories || [])) counts.set(c, (counts.get(c) || 0) + 1);
  const box = document.getElementById("catChips");
  if (!box) return;
  box.innerHTML = "";

  const clear = document.createElement("span");
  clear.id = "catClear";
  clear.textContent = "clear";
  clear.style.display = "none";
  clear.onclick = () => {
    cats.clear();
    box.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
    clear.style.display = "none";
    render();
  };

  [...counts.keys()].sort().forEach(cat => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = `${cat} (${counts.get(cat)})`;
    chip.onclick = () => {
      if (cats.has(cat)) cats.delete(cat); else cats.add(cat);
      chip.classList.toggle("active", cats.has(cat));
      clear.style.display = cats.size ? "" : "none";
      render();
    };
    box.appendChild(chip);
  });
  box.appendChild(clear);
}
boot(window.SALES_DATA);

document.getElementById("search").addEventListener("input", e => {
  query = e.target.value.trim().toLowerCase(); render();
});
document.querySelectorAll(".chip[data-f]").forEach(chip => {
  chip.onclick = () => {
    filter = chip.dataset.f;
    document.querySelectorAll(".chip[data-f]").forEach(c => c.classList.toggle("active", c === chip));
    render();
  };
});
document.getElementById("locate").onclick = locateMe;
document.getElementById("clearRoute").onclick = () => {
  route.length = 0;
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  reorderRoute();
};
document.getElementById("startHere").onchange = () => {
  if (document.getElementById("startHere").checked && !userLoc) locateMe();
  else reorderRoute();
};
document.getElementById("rhead").onclick = () => {
  const collapsed = document.getElementById("route").classList.toggle("collapsed");
  document.getElementById("rtoggle").textContent = collapsed ? "▸" : "▾";
};

window.toggleRoute = toggleRoute;   // used by popup buttons

locateMe(true);
