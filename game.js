import * as THREE from 'three';
import { buildTree, applyTreeState, animateTree, addLights, startPreview, TREE_HEIGHT_M, TREE_WIDTH_M } from './trees3d.js';

const E = window.Economy;
const C = E.CONFIG;
const SPECIES = E.SPECIES;

// ---- Config ----
const CELL = 40;                 // plot size in Web-Mercator meters (~28 m on the ground at 45° latitude)
const REACH = 1;
const TREE_SCALE = 1.3;       // trees fill most of their plot
const GRID_RADIUS = 45;          // plots drawn around the view centre
const SIM_STEP_M = 8;
// Phone browsers often report 20-50 m accuracy while walking; readings worse than 50 m are too noisy to count.
const GPS_MAX_ACCURACY_M = 50, GPS_MIN_STEP_M = 5, GPS_MAX_SPEED_MPS = 7;
const DEFAULT_POS = [-73.9665, 40.7812]; // [lng, lat]
const STORAGE_KEY = 'canopyclaims:v1';

// ---- Web-Mercator helpers ----
const R = 6378137, W = 2 * Math.PI * R;
const toMerc = ([lng, lat]) => [R * lng * Math.PI / 180, R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
const fromMerc = (x, y) => [x / R * 180 / Math.PI, (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI];
const cellOf = (ll) => { const [x, y] = toMerc(ll); return [Math.floor(x / CELL), Math.floor(y / CELL)]; };
const cellCenter = (i, j) => fromMerc((i + 0.5) * CELL, (j + 0.5) * CELL);
const cellRing = (i, j) => [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1], [i, j]].map(([a, b]) => fromMerc(a * CELL, b * CELL));
const key = (i, j) => i + ',' + j;
const parseKey = (k) => k.split(',').map(Number);
function haversine(a, b) {
  const rad = Math.PI / 180, dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const $ = (id) => document.getElementById(id);

// ---- State ----
const freshState = () => ({ he: 0, metersWalked: 0, sap: 0, lastTick: Date.now(), planted: 0, trees: {}, simPos: null, timeOffset: 0 });
let state = (() => {
  try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (s && s.trees) return Object.assign(freshState(), s); } catch (e) { /* ignore */ }
  return freshState();
})();
const isNewPlayer = !localStorage.getItem(STORAGE_KEY);
const now = () => Date.now() + (state.timeOffset || 0);
let saveTimer = null;
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)), 300); }
function settle() {
  const t = now();
  for (const k in state.trees) state.sap += E.sapBetween(state.trees[k], state.lastTick, t);
  state.lastTick = t;
}
const totalRate = (t) => Object.values(state.trees).reduce((r, tr) => r + E.sapRate(tr, t), 0);
function addMeters(m) { state.metersWalked += m; state.he += m * C.HE_PER_METER; save(); updateHud(); }

// ---- Map style (sunset low-poly palette) ----
const P = {
  ground: '#6f7a43', grass: '#77823f', wood: '#5d6a33', park: '#738040', water: '#6f7fa6', sand: '#8e9152',
  road: '#2b2131', roadEdge: '#d9c9a0', path: '#a59a6d', building: '#b8968f', rail: '#4a3a45',
};
function buildStyle() {
  const src = 'openmaptiles';
  const L = (id, type, layer, paint, extra = {}) => ({ id, type, source: src, 'source-layer': layer, paint, ...extra });
  const roadWidth = (base) => ['interpolate', ['exponential', 1.6], ['zoom'], 14, base * 0.6, 20, base * 18];
  return {
    version: 8,
    glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
    sources: {
      [src]: { type: 'vector', url: 'https://tiles.openfreemap.org/planet' },
      grid: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      plots: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    sky: {
      'sky-color': '#e9967a', 'horizon-color': '#ffd38a', 'fog-color': '#e8b48e',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.75, 'atmosphere-blend': 0.6,
    },
    light: { anchor: 'map', color: '#ffd2a0', intensity: 0.35, position: [1.4, 260, 35] },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': P.ground } },
      L('park', 'fill', 'park', { 'fill-color': P.park }),
      L('grass', 'fill', 'landcover', { 'fill-color': P.grass }, { filter: ['==', ['get', 'class'], 'grass'] }),
      L('wood', 'fill', 'landcover', { 'fill-color': P.wood }, { filter: ['==', ['get', 'class'], 'wood'] }),
      L('sand', 'fill', 'landcover', { 'fill-color': P.sand }, { filter: ['==', ['get', 'class'], 'sand'] }),
      L('water', 'fill', 'water', { 'fill-color': P.water }),
      L('waterway', 'line', 'waterway', { 'line-color': P.water, 'line-width': 3 }),
      L('paths', 'line', 'transportation', { 'line-color': P.path, 'line-width': roadWidth(0.25), 'line-opacity': 0.8 },
        { filter: ['in', ['get', 'class'], ['literal', ['path', 'track']]] }),
      L('road-edge', 'line', 'transportation', { 'line-color': P.roadEdge, 'line-opacity': 0.55, 'line-gap-width': roadWidth(0.75), 'line-width': 1.2 },
        { filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway']]], layout: { 'line-cap': 'round', 'line-join': 'round' } }),
      L('roads', 'line', 'transportation', { 'line-color': P.road, 'line-width': roadWidth(0.75) },
        { filter: ['in', ['get', 'class'], ['literal', ['minor', 'service', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway']]], layout: { 'line-cap': 'round', 'line-join': 'round' } }),
      L('rail', 'line', 'transportation', { 'line-color': P.rail, 'line-width': 2 }, { filter: ['in', ['get', 'class'], ['literal', ['rail', 'transit']]] }),
      { id: 'grid', type: 'line', source: 'grid', paint: {
        'line-color': '#f4e6c4', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0.15, 18, 0.5],
        'line-width': ['interpolate', ['linear'], ['zoom'], 15, 0.4, 19, 1.8] } },
      { id: 'plots', type: 'fill', source: 'plots', paint: {
        'fill-color': ['match', ['get', 'kind'], 'reach', '#ffd76a', 'bloom', '#b6fff0', 'withered', '#8a5a32', '#3d4a22'],
        'fill-opacity': ['match', ['get', 'kind'], 'reach', 0.18, 'bloom', 0.22, 0.35] } },
      { id: 'reach-outline', type: 'line', source: 'plots', filter: ['==', ['get', 'kind'], 'reach'],
        paint: { 'line-color': '#ffd76a', 'line-width': 2.5, 'line-opacity': 0.9 } },
      L('buildings', 'fill-extrusion', 'building', {
        'fill-extrusion-color': ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 8], 0, '#d1a58a', 30, '#b98f8c', 120, '#9a83a6'], 'fill-extrusion-opacity': 0.92,
        'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 8],
        'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] }, { minzoom: 15 }),
      L('road-names', 'symbol', 'transportation_name', { 'text-color': '#fbecd0', 'text-halo-color': '#2b2131', 'text-halo-width': 1.2 },
        { minzoom: 16, layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 12 } }),
    ],
  };
}

// ---- Map ----
const params = new URLSearchParams(location.search);
const urlPos = params.has('lat') && params.has('lng') ? [+params.get('lng'), +params.get('lat')] : null;
const map = new maplibregl.Map({
  container: 'map', style: buildStyle(), center: urlPos || state.simPos || DEFAULT_POS,
  zoom: 18, pitch: 68, bearing: -20, minZoom: 15, maxZoom: 20.5, maxPitch: 75,
  attributionControl: { compact: true, customAttribution: '© OpenStreetMap contributors · OpenFreeMap' },
});
map.doubleClickZoom.disable();

// ---- Player ----
let gpsPos = null, gpsAccuracy = null, simMode = false;
let simPos = urlPos || state.simPos || null;
let follow = true, playerCell = null;
const playerEl = document.createElement('div');
playerEl.className = 'player-dot';
const playerMarker = new maplibregl.Marker({ element: playerEl, pitchAlignment: 'map', rotationAlignment: 'map' });
const playerPos = () => (simMode ? simPos : gpsPos);
const inReach = (i, j) => playerCell && Math.max(Math.abs(i - playerCell[0]), Math.abs(j - playerCell[1])) <= REACH;

function updatePlayer() {
  const pos = playerPos();
  if (!pos) return;
  playerMarker.setLngLat(pos);
  if (!playerMarker._map) playerMarker.addTo(map);
  playerEl.classList.toggle('sim', simMode);
  if (follow) map.easeTo({ center: pos, duration: 300 });
  const c = cellOf(pos);
  if (!playerCell || c[0] !== playerCell[0] || c[1] !== playerCell[1]) { playerCell = c; updatePlots(); updateSheet(); }
}

// ---- GPS -> HE ----
let anchor = null, anchorT = 0;
function onGpsFix(pos, acc, t) {
  if (acc > GPS_MAX_ACCURACY_M) return;
  if (!anchor) { anchor = pos; anchorT = t; return; }
  const d = haversine(anchor, pos);
  if (d < Math.max(GPS_MIN_STEP_M, acc * 0.4)) return;
  if (d / Math.max(1, (t - anchorT) / 1000) <= GPS_MAX_SPEED_MPS) addMeters(d);
  else toast('Moving too fast, no HE in vehicles');
  anchor = pos; anchorT = t;
}
let gpsWatch = null, autoSim = false, lastGoodFixT = 0;

// ---- Step counter (motion sensor) -> HE whenever GPS is too weak to measure distance ----
const STEP_M = 0.762, GPS_GOOD_GRACE_MS = 15000;
let steps = 0, motionOn = false, motionAsked = false, accAvg = 9.8, stepArmed = true, lastStepT = 0;
const gpsGood = () => gpsAccuracy != null && gpsAccuracy <= GPS_MAX_ACCURACY_M && Date.now() - lastGoodFixT < GPS_GOOD_GRACE_MS;
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null) return;
  const mag = Math.hypot(a.x, a.y, a.z), t = performance.now();
  accAvg = accAvg * 0.9 + mag * 0.1;
  const dev = mag - accAvg;
  if (stepArmed && dev > 1.2 && t - lastStepT > 300) { stepArmed = false; lastStepT = t; onStep(); }
  else if (dev < 0.2) stepArmed = true;
}
function onStep() {
  steps++;
  if (gpsGood()) return; // GPS is measuring distance; don't double count
  anchor = null;         // re-anchor GPS so the step-counted stretch isn't added again
  addMeters(STEP_M);
  $('gps').textContent = `Steps ${steps}${gpsAccuracy != null ? ` · GPS ±${Math.round(gpsAccuracy)} m` : ''}`;
}
// iPhone needs a tap before it allows motion access; Android just starts.
function enableMotion() {
  if (motionOn || motionAsked || typeof DeviceMotionEvent === 'undefined') return;
  motionAsked = true;
  const start = () => { motionOn = true; window.addEventListener('devicemotion', onMotion); };
  if (typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission()
      .then((r) => (r === 'granted' ? start() : toast('Motion access denied: steps only count with good GPS')))
      .catch(() => { motionAsked = false; });
  } else start();
}
window.addEventListener('click', enableMotion);
window.addEventListener('touchend', enableMotion);

function handleFix(p) {
  gpsPos = [p.coords.longitude, p.coords.latitude];
  gpsAccuracy = p.coords.accuracy;
  if (gpsAccuracy <= GPS_MAX_ACCURACY_M) lastGoodFixT = Date.now();
  $('gps').textContent = `GPS ±${Math.round(gpsAccuracy)} m${gpsAccuracy > GPS_MAX_ACCURACY_M ? ' (too weak for HE)' : ''}`;
  $('gps').classList.toggle('warn', gpsAccuracy > GPS_MAX_ACCURACY_M);
  onGpsFix(gpsPos, gpsAccuracy, p.timestamp || Date.now());
  // Sim was only switched on because GPS wasn't ready yet: hand control back to the real position.
  if (simMode && autoSim) { setSim(false); toast('GPS found'); }
  else if (!simMode) updatePlayer();
}
// Real GPS needs a secure (https or localhost) page and the user's location permission.
function startGps(userAsked) {
  if (!('geolocation' in navigator) || !window.isSecureContext) {
    const why = !window.isSecureContext ? 'GPS needs an https page' : 'GPS unsupported on this device';
    $('gps').textContent = why; $('gps').classList.add('warn');
    if (userAsked) toast(why);
    if (!simMode) setTimeout(() => { setSim(true); autoSim = true; }, 0);
    return;
  }
  if (gpsWatch !== null) navigator.geolocation.clearWatch(gpsWatch);
  $('gps').textContent = 'GPS: locating…';
  gpsWatch = navigator.geolocation.watchPosition(handleFix, (err) => {
    const code = err ? err.code : 2;
    // Timeouts (code 3) are normal while the phone gets its first fix; the watch keeps running.
    if (code === 3) { if (!gpsPos) $('gps').textContent = 'GPS: searching…'; return; }
    $('gps').textContent = code === 1 ? 'Location blocked' : 'GPS unavailable';
    $('gps').classList.add('warn');
    if (code === 1) { navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
    if (userAsked) toast(code === 1 ? 'Location is blocked for this site: allow it in your browser/phone settings, then tap Use GPS' : 'No GPS signal yet, keep the page open outdoors');
    if (!gpsPos && !simMode) { if (!userAsked) toast(code === 1 ? 'Location blocked, using Sim mode' : 'No GPS yet, using Sim until it connects'); setSim(true); autoSim = true; }
  }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
}
startGps(false);

// ---- Grid + plots (GeoJSON) ----
let gridCentre = null;
function gridData(centreCell) {
  const [ci, cj] = centreCell, n = GRID_RADIUS, feats = [];
  for (let i = ci - n; i <= ci + n + 1; i++)
    feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [fromMerc(i * CELL, (cj - n) * CELL), fromMerc(i * CELL, (cj + n + 1) * CELL)] } });
  for (let j = cj - n; j <= cj + n + 1; j++)
    feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [fromMerc((ci - n) * CELL, j * CELL), fromMerc((ci + n + 1) * CELL, j * CELL)] } });
  return { type: 'FeatureCollection', features: feats };
}
function updateGrid(force) {
  const src = map.getSource('grid');
  if (!src) return;
  const c = cellOf(map.getCenter().toArray());
  if (!force && gridCentre && Math.max(Math.abs(c[0] - gridCentre[0]), Math.abs(c[1] - gridCentre[1])) < GRID_RADIUS / 3) return;
  gridCentre = c;
  src.setData(gridData(c));
}
function updatePlots() {
  const src = map.getSource('plots');
  if (!src) return;
  const t = now(), feats = [];
  const poly = (i, j, kind) => feats.push({ type: 'Feature', properties: { kind }, geometry: { type: 'Polygon', coordinates: [cellRing(i, j)] } });
  for (const k in state.trees) { const [i, j] = parseKey(k); poly(i, j, E.hydrationState(state.trees[k], t)); }
  if (playerCell) for (let di = -REACH; di <= REACH; di++) for (let dj = -REACH; dj <= REACH; dj++) poly(playerCell[0] + di, playerCell[1] + dj, 'reach');
  src.setData({ type: 'FeatureCollection', features: feats });
}

// ---- 3D trees (three.js custom layer) ----
const treeGroups = new Map();
let origin = null; // mercator meters [x, y] the 3D scene is centred on
let originMatrix = null;
const treeLayer = {
  id: 'trees3d', type: 'custom', renderingMode: '3d',
  onAdd(m, gl) {
    this.camera = new THREE.Camera();
    this.scene = new THREE.Scene();
    addLights(this.scene);
    this.renderer = new THREE.WebGLRenderer({ canvas: m.getCanvas(), context: gl, antialias: true });
    this.renderer.autoClear = false;
  },
  render(gl, args) {
    if (!originMatrix) return;
    const mat = args && args.defaultProjectionData ? args.defaultProjectionData.mainMatrix : args;
    this.camera.projectionMatrix = new THREE.Matrix4().fromArray(mat).multiply(originMatrix);
    const t = performance.now();
    let animating = false;
    for (const g of treeGroups.values()) { animateTree(g, t); animating = true; }
    this.renderer.resetState();
    this.renderer.render(this.scene, this.camera);
    if (animating) map.triggerRepaint();
  },
};
function setOrigin(ll) {
  const [x, y] = toMerc(ll);
  origin = [x, y];
  const s = 1 / W;
  originMatrix = new THREE.Matrix4()
    .makeTranslation(x / W + 0.5, 0.5 - y / W, 0)
    .scale(new THREE.Vector3(s, -s, s))
    .multiply(new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(1, 0, 0), Math.PI / 2));
  for (const [k, g] of treeGroups) placeGroup(k, g);
}
function placeGroup(k, g) {
  const [i, j] = parseKey(k);
  const cx = (i + 0.5) * CELL, cy = (j + 0.5) * CELL;
  const lat = cellCenter(i, j)[1];
  g.position.set(cx - origin[0], 0, -(cy - origin[1]));
  g.scale.setScalar(TREE_SCALE / Math.cos(lat * Math.PI / 180)); // real meters -> mercator meters
}
function syncTrees() {
  if (!treeLayer.scene) return;
  const t = now();
  for (const [k, g] of treeGroups) if (!state.trees[k]) { treeLayer.scene.remove(g); treeGroups.delete(k); }
  for (const k in state.trees) {
    const tr = state.trees[k];
    let g = treeGroups.get(k);
    if (!g) {
      if (!origin) setOrigin(cellCenter(...parseKey(k)));
      const [i, j] = parseKey(k);
      g = buildTree(SPECIES[tr.s], Math.imul(i, 73856093) ^ Math.imul(j, 19349663));
      placeGroup(k, g);
      treeLayer.scene.add(g);
      treeGroups.set(k, g);
    }
    applyTreeState(g, E.hydrationState(tr, t), E.hydrationAt(tr, t));
  }
  if (origin) {
    const [cx, cy] = toMerc(map.getCenter().toArray());
    if (Math.hypot(cx - origin[0], cy - origin[1]) > 3000) setOrigin(map.getCenter().toArray());
  }
  map.triggerRepaint();
}

map.on('load', () => {
  map.addLayer(treeLayer);
  setOrigin(map.getCenter().toArray());
  updateGrid(true);
  updatePlots();
  syncTrees();
  if (urlPos) setSim(true); else updatePlayer();
});
map.on('moveend', () => { updateGrid(false); });

// Tilted view: a tap on a tall tree lands north of its plot, so test tree silhouettes first.
function treeAtPoint(pt) {
  const pitch = map.getPitch() * Math.PI / 180;
  let best = null;
  for (const k in state.trees) {
    const [i, j] = parseKey(k);
    const base = map.project(cellCenter(i, j));
    const side = map.project(fromMerc((i + 1) * CELL, (j + 0.5) * CELL));
    const side2 = map.project(fromMerc((i + 0.5) * CELL, (j + 1) * CELL));
    const ppm = Math.max(Math.hypot(side.x - base.x, side.y - base.y), Math.hypot(side2.x - base.x, side2.y - base.y)) / (CELL / 2);
    const k2 = TREE_SCALE / Math.cos(cellCenter(i, j)[1] * Math.PI / 180);
    const h = TREE_HEIGHT_M * k2 * ppm * Math.sin(pitch), w = TREE_WIDTH_M * k2 * ppm;
    if (pt.x > base.x - w / 2 && pt.x < base.x + w / 2 && pt.y > base.y - h && pt.y < base.y + w * 0.3)
      if (!best || base.y > best.y) best = { k, y: base.y };
  }
  return best && parseKey(best.k);
}
map.on('click', (e) => {
  const hit = treeAtPoint(e.point);
  const [i, j] = hit || cellOf(e.lngLat.toArray());
  openCell(i, j);
});

// ---- Bottom sheet ----
const sheet = $('sheet'), sheetBody = $('sheetBody');
let sheetCell = null, sheetMode = null, stopPreview = null;
function clearPreview() { if (stopPreview) { stopPreview(); stopPreview = null; } }
function closeSheet() { clearPreview(); sheet.classList.add('hidden'); sheetCell = null; sheetMode = null; }
$('sheetClose').onclick = closeSheet;

function openCell(i, j) {
  if (state.trees[key(i, j)]) return showTreeSheet(i, j);
  if (!playerPos()) return toast('Waiting for your location…');
  if (!inReach(i, j)) { closeSheet(); return toast('Walk closer to claim this plot'); }
  showPlantSheet(i, j);
}

function showPlantSheet(i, j) {
  clearPreview();
  sheetCell = [i, j]; sheetMode = 'plant';
  sheetBody.innerHTML = `
    <div class="rarity">Unclaimed plot</div>
    <h3>Claim &amp; plant a seed?</h3>
    <div class="row"><span>Cost</span><span id="shCost"></span></div>
    <div class="row"><span>Your HE</span><span id="shHE"></span></div>
    <div class="hint">${SPECIES.map((s) => `<span style="color:${s.color}">${s.name}</span> ${s.max - s.min + 1}%`).join(' · ')}</div>
    <div class="actions"><button class="primary" id="plantBtn">Plant seed</button></div>`;
  $('plantBtn').onclick = () => plant(i, j);
  sheet.classList.remove('hidden');
  updateSheet();
}

function plant(i, j) {
  const k = key(i, j);
  if (state.trees[k] || !inReach(i, j)) return;
  const cost = E.plantCost(state.planted);
  if (state.he < cost) return toast('Not enough HE, keep walking');
  settle();
  state.he -= cost;
  const roll = E.rollD100(), s = E.speciesForRoll(roll), t = now();
  state.trees[k] = { s, h0: C.START_HYDRATION, tw: t, plantedAt: t, roll };
  state.planted++;
  save(); syncTrees(); updatePlots(); updateHud();
  vibrate(s === 3 ? [100, 50, 100, 50, 300] : 30);
  showReveal(i, j, roll);
}

function showReveal(i, j, roll) {
  clearPreview();
  sheetCell = [i, j]; sheetMode = 'reveal';
  const sp = SPECIES[state.trees[key(i, j)].s];
  sheetBody.innerHTML = `
    <div class="reveal">
      <div class="rarity">You rolled ${roll}</div>
      <canvas id="revealCanvas" style="width:170px;height:170px"></canvas>
      <div class="big" style="color:${sp.color}">${sp.name}</div>
      <div class="rarity">${sp.rarity} · ${sp.aesthetic}</div>
      <div class="row" style="justify-content:center;gap:6px"><span>Base rate</span><b>${sp.rate} Sap/min</b></div>
    </div>
    <div class="actions"><button id="revealOk">Nice!</button></div>`;
  sheet.classList.remove('hidden');
  stopPreview = startPreview($('revealCanvas'), sp, Math.imul(i, 73856093) ^ Math.imul(j, 19349663));
  $('revealOk').onclick = () => showTreeSheet(i, j);
}

function showTreeSheet(i, j) {
  clearPreview();
  sheetCell = [i, j]; sheetMode = 'tree';
  const sp = SPECIES[state.trees[key(i, j)].s];
  sheetBody.innerHTML = `
    <div class="rarity" style="color:${sp.color}">${sp.rarity} · ${sp.aesthetic}</div>
    <h3>${sp.name}</h3>
    <div class="row"><span>Hydration</span><span id="shHyd"></span></div>
    <div class="bar" id="shBar"><div></div></div>
    <div class="row"><span>State</span><span id="shState"></span></div>
    <div class="row"><span>Production</span><span id="shRate"></span></div>
    <div class="row"><span>Value</span><span id="shUsd" class="usd-text"></span></div>
    <div class="row"><span id="shNextLabel"></span><span id="shNext"></span></div>
    <div class="actions"><button class="water" id="waterBtn"></button></div>
    <div class="hint" id="shHint"></div>`;
  $('waterBtn').onclick = () => waterTree(i, j);
  sheet.classList.remove('hidden');
  updateSheet();
}

function waterTree(i, j) {
  const k = key(i, j);
  if (!state.trees[k] || !inReach(i, j)) return;
  settle();
  const res = E.water(state.trees[k], now(), state.he);
  if (!res.cost) return;
  state.trees[k] = res.tree;
  state.he = Math.max(0, state.he - res.cost);
  save(); syncTrees(); updatePlots(); updateHud(); updateSheet();
  toast(E.hydrationState(res.tree, now()) === 'bloom' ? 'Canopy Bloom! 2.5x Sap' : `Watered +${Math.round(res.added)}%`);
}

const STATE_LABEL = { bloom: 'Canopy Bloom (2.5x)', optimal: 'Optimal (1.0x)', withered: 'Withered (0.1x)' };
function updateSheet() {
  if (!sheetCell || sheet.classList.contains('hidden')) return;
  const [i, j] = sheetCell, t = now();
  if (sheetMode === 'plant') {
    const cost = E.plantCost(state.planted);
    $('shCost').textContent = cost ? `${cost} HE` : 'Free (first tree)';
    $('shHE').textContent = fmt(state.he);
    $('plantBtn').disabled = !(inReach(i, j) && state.he >= cost && !state.trees[key(i, j)]);
    $('plantBtn').textContent = !inReach(i, j) ? 'Walk closer to plant' : state.he < cost ? 'Not enough HE' : 'Plant seed';
  } else if (sheetMode === 'tree') {
    const tree = state.trees[key(i, j)];
    if (!tree) return closeSheet();
    const sp = SPECIES[tree.s], st = E.hydrationState(tree, t);
    $('shHyd').textContent = E.displayHydration(tree, t) + '%';
    $('shBar').className = 'bar ' + st;
    $('shBar').firstChild.style.width = (st === 'withered' ? 100 : E.hydrationAt(tree, t)) + '%';
    $('shState').textContent = STATE_LABEL[st];
    $('shState').className = 'state-' + st;
    const hm = E.HYDRATION_MULTIPLIER[st], em = E.engineMultiplier(), r = sp.rate * hm * em;
    $('shRate').textContent = `${sp.rate} × ${hm} × ${em} = ${fmt(r)} Sap/min`;
    $('shUsd').textContent = `${fmtUSD(E.sapToUSD(r))}/min`;
    if (st === 'bloom') { $('shNextLabel').textContent = 'Bloom ends in'; $('shNext').textContent = fmtDur(E.drainStart(tree) - t); }
    else if (st === 'optimal') { $('shNextLabel').textContent = 'Withers in'; $('shNext').textContent = fmtDur(E.dryAt(tree) - t); }
    else { $('shNextLabel').textContent = 'Withered for'; $('shNext').textContent = fmtDur(t - E.dryAt(tree)); }
    const btn = $('waterBtn'), hint = $('shHint'), full = E.waterCostToFull(tree, t);
    hint.textContent = '';
    if (st === 'bloom') { btn.disabled = true; btn.textContent = 'Fully watered'; }
    else if (!inReach(i, j)) { btn.disabled = true; btn.textContent = `Water to 100% (${Math.ceil(full)} HE)`; hint.textContent = 'Walk to this tree to water it.'; }
    else if (state.he < 1) { btn.disabled = true; btn.textContent = 'Not enough HE'; hint.textContent = 'Walk to earn Hydro-Kinetic Energy.'; }
    else if (state.he >= full) { btn.disabled = false; btn.textContent = `Water to 100% (−${Math.ceil(full)} HE)`; }
    else { btn.disabled = false; btn.textContent = `Water +${Math.floor(state.he / C.WATER_COST_HE_PER_PCT)}% (−${Math.floor(state.he)} HE)`; }
  }
}

// ---- HUD ----
function fmt(n) {
  n = Math.floor(n);
  if (n < 10000) return n.toLocaleString();
  for (const [u, v] of [['B', 1e9], ['M', 1e6], ['K', 1e3]]) if (n >= v) return (n / v).toFixed(n / v < 100 ? 1 : 0) + u;
  return String(n);
}
function fmtUSD(v) { return '$' + (v < 1000 ? v.toFixed(8) : v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}
let lastStateSync = 0;
function updateHud() {
  settle();
  const t = now();
  $('he').textContent = fmt(state.he);
  $('sap').textContent = fmt(state.sap);
  const rate = totalRate(t);
  $('sapRate').textContent = rate ? `+${fmt(rate)}/min` : '';
  $('usd').textContent = fmtUSD(E.sapToUSD(state.sap));
  $('usdRate').textContent = rate ? `+${fmtUSD(E.sapToUSD(rate))}/min` : '';
  $('trees').textContent = Object.keys(state.trees).length;
  if (t - lastStateSync > 10000) { lastStateSync = t; syncTrees(); updatePlots(); }
  save();
}
setInterval(() => { updateHud(); updateSheet(); }, 1000);

let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2000);
}
function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }


// ---- Controls ----
$('centerBtn').onclick = () => {
  follow = true;
  const pos = playerPos();
  if (pos) map.easeTo({ center: pos, zoom: Math.max(map.getZoom(), 17.5), pitch: 68 });
};
map.on('dragstart', () => { follow = false; });

function setSim(on) {
  simMode = on;
  autoSim = false;
  $('simBtn').classList.toggle('active', on);
  $('simBtn').textContent = on ? '📡 Use GPS' : '🚶 Sim';
  if (!on && (!gpsPos || gpsWatch === null)) startGps(true);
  $('dpad').classList.toggle('hidden', !on);
  if (on && !simPos) simPos = gpsPos || map.getCenter().toArray();
  playerCell = null;
  follow = true;
  updatePlayer();
}
$('simBtn').onclick = () => setSim(!simMode);

// Movement is relative to the camera bearing so "up" always walks into the screen.
function simMove(fwd, right) {
  if (!simMode || !simPos) return;
  const b = map.getBearing() * Math.PI / 180;
  const east = right * Math.cos(b) + fwd * Math.sin(b);
  const north = fwd * Math.cos(b) - right * Math.sin(b);
  const k = 1 / Math.cos(simPos[1] * Math.PI / 180);
  const [x, y] = toMerc(simPos);
  simPos = fromMerc(x + east * k, y + north * k);
  state.simPos = simPos;
  addMeters(Math.hypot(fwd, right)); // sim walking earns HE for testing
  follow = true;
  updatePlayer();
  updateHud();
}
const DIRS = { up: [1, 0], down: [-1, 0], left: [0, -1], right: [0, 1] };
// Only one d-pad repeat may run at a time; any release, extra button, or focus loss stops it.
let padRepeat = null;
const stopPad = () => { clearInterval(padRepeat); padRepeat = null; };
document.querySelectorAll('#dpad button').forEach((b) => {
  const go = () => { const [f, r] = DIRS[b.dataset.dir]; simMove(f * SIM_STEP_M, r * SIM_STEP_M); };
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    stopPad();
    if (e.button !== 0) return;
    go();
    padRepeat = setInterval(go, 150);
  });
  b.addEventListener('pointerleave', stopPad);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
});
['pointerup', 'pointercancel', 'contextmenu', 'blur'].forEach((ev) => window.addEventListener(ev, stopPad));
document.addEventListener('visibilitychange', stopPad);
const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
map.keyboard.disable();
window.addEventListener('keydown', (e) => {
  const d = KEYS[e.code];
  if (d && simMode) { e.preventDefault(); const [f, r] = DIRS[d]; simMove(f * SIM_STEP_M, r * SIM_STEP_M); }
  else if (e.code === 'Escape') closeSheet();
});

$('menuBtn').onclick = () => $('menu').classList.toggle('hidden');
$('closeMenuBtn').onclick = () => $('menu').classList.add('hidden');
$('resetBtn').onclick = () => {
  if (!confirm('Erase all your progress?')) return;
  const keepPos = state.simPos;
  state = freshState();
  state.simPos = keepPos;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  closeSheet(); syncTrees(); updatePlots(); updateHud();
  $('menu').classList.add('hidden');
};

// Dev helpers (browser console): canopy.addHE(1000), canopy.skip(3600e3)
window.canopy = {
  get state() { return state; },
  map,
  steps: () => steps,
  gps(lng, lat, acc = 10, t = Date.now()) { handleFix({ coords: { longitude: lng, latitude: lat, accuracy: acc }, timestamp: t }); },
  addHE(n) { state.he += n; updateHud(); updateSheet(); },
  skip(ms) { state.timeOffset = (state.timeOffset || 0) + ms; updateHud(); syncTrees(); updatePlots(); updateSheet(); },
};

if (isNewPlayer) $('menu').classList.remove('hidden');
updateHud();
