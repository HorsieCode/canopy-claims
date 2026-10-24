(() => {
  'use strict';

  const E = window.Economy;
  const C = E.CONFIG;
  const SPECIES = E.SPECIES;

  // ---- Map / movement config ----
  const CELL = 40;                 // plot size in Web-Mercator meters (~28 m on the ground at 45° latitude)
  const REACH = 1;                 // plots away from the player you can plant / water
  const MIN_GAME_ZOOM = 15;
  const SIM_STEP_M = 8;
  const GPS_MAX_ACCURACY_M = 30;   // ignore fixes worse than this for HE
  const GPS_MIN_STEP_M = 8;        // ignore jitter smaller than this
  const GPS_MAX_SPEED_MPS = 7;     // ~25 km/h; faster = vehicle, no HE
  const DEFAULT_POS = [40.7812, -73.9665];
  const STORAGE_KEY = 'geogrove:v1';

  const SM = L.Projection.SphericalMercator;
  const WORLD = 2 * Math.PI * SM.R;
  const key = (i, j) => i + ',' + j;
  function cellOf(latlng) {
    const p = SM.project(L.latLng(latlng));
    return [Math.floor(p.x / CELL), Math.floor(p.y / CELL)];
  }

  // ---- State ----
  const freshState = () => ({
    he: 0, metersWalked: 0, sap: 0, lastTick: Date.now(), boostUntil: 0,
    planted: 0, trees: {}, simPos: null, timeOffset: 0,
  });
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && s.trees) return Object.assign(freshState(), s);
    } catch (e) { /* ignore */ }
    return freshState();
  }
  const now = () => Date.now() + (state.timeOffset || 0);
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)), 300);
  }

  // Bank all Sap produced since the last tick. Call before anything that changes rates.
  function settle() {
    const t = now();
    for (const k in state.trees) state.sap += E.sapBetween(state.trees[k], state.boostUntil, state.lastTick, t);
    state.lastTick = t;
  }
  const totalRate = (t) => Object.values(state.trees).reduce((r, tr) => r + E.sapRate(tr, state.boostUntil, t), 0);

  function addMeters(m) {
    state.metersWalked += m;
    state.he += m * C.HE_PER_METER;
    save();
  }

  // ---- Map ----
  const params = new URLSearchParams(location.search);
  const urlPos = params.has('lat') && params.has('lng') ? [+params.get('lat'), +params.get('lng')] : null;

  const map = L.map('map', { zoomControl: false, minZoom: MIN_GAME_ZOOM, maxZoom: 20, doubleClickZoom: false })
    .setView(urlPos || state.simPos || DEFAULT_POS, 18);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 20, maxNativeZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  // ---- Player ----
  let gpsPos = null, gpsAccuracy = null;
  let simMode = false;
  let simPos = urlPos || state.simPos || null;
  let follow = true;
  let playerCell = null;

  const playerIcon = L.divIcon({ className: '', html: '<div class="player-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  const playerMarker = L.marker(DEFAULT_POS, { icon: playerIcon, interactive: false, zIndexOffset: 1000 });
  const accuracyCircle = L.circle(DEFAULT_POS, { radius: 0, color: '#2f8cff', weight: 1, fillOpacity: 0.08, interactive: false });
  const playerPos = () => (simMode ? simPos : gpsPos);

  function updatePlayer() {
    const pos = playerPos();
    if (!pos) return;
    if (!map.hasLayer(playerMarker)) { playerMarker.addTo(map); accuracyCircle.addTo(map); }
    playerMarker.setLatLng(pos);
    const dot = playerMarker.getElement() && playerMarker.getElement().firstChild;
    if (dot) dot.classList.toggle('sim', simMode);
    accuracyCircle.setLatLng(pos).setRadius(simMode ? 0 : (gpsAccuracy || 0));
    if (follow) map.panTo(pos, { animate: true });
    const c = cellOf(pos);
    if (!playerCell || c[0] !== playerCell[0] || c[1] !== playerCell[1]) {
      playerCell = c;
      redrawAll();
      updateSheet();
    }
  }
  const inReach = (i, j) => playerCell && Math.max(Math.abs(i - playerCell[0]), Math.abs(j - playerCell[1])) <= REACH;

  // ---- GPS -> HE ----
  const gpsEl = document.getElementById('gps');
  let anchor = null, anchorT = 0;
  function onGpsFix(lat, lng, acc, t) {
    if (acc > GPS_MAX_ACCURACY_M) return;
    if (!anchor) { anchor = [lat, lng]; anchorT = t; return; }
    const d = map.distance(anchor, [lat, lng]);
    if (d < Math.max(GPS_MIN_STEP_M, acc * 0.5)) return;
    const speed = d / Math.max(1, (t - anchorT) / 1000);
    if (speed <= GPS_MAX_SPEED_MPS) addMeters(d);
    else toast('Moving too fast, no HE in vehicles');
    anchor = [lat, lng];
    anchorT = t;
  }
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      (p) => {
        gpsPos = [p.coords.latitude, p.coords.longitude];
        gpsAccuracy = p.coords.accuracy;
        gpsEl.textContent = `GPS ±${Math.round(gpsAccuracy)} m`;
        gpsEl.classList.toggle('warn', gpsAccuracy > GPS_MAX_ACCURACY_M);
        onGpsFix(gpsPos[0], gpsPos[1], gpsAccuracy, p.timestamp || Date.now());
        if (!simMode) updatePlayer();
      },
      () => {
        gpsEl.textContent = 'GPS unavailable';
        gpsEl.classList.add('warn');
        if (!gpsPos && !simMode) { toast('No GPS, switching to Sim mode'); setSim(true); }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  } else {
    gpsEl.textContent = 'GPS unsupported';
    setTimeout(() => setSim(true), 0);
  }

  // ---- Rendering ----
  const liveTiles = new Set();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const GameLayer = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x * dpr;
      tile.height = size.y * dpr;
      tile._coords = coords;
      liveTiles.add(tile);
      drawTile(tile);
      return tile;
    },
  });
  const gameLayer = new GameLayer({ minZoom: MIN_GAME_ZOOM, maxZoom: 20, updateWhenZooming: false });
  gameLayer.on('tileunload', (e) => liveTiles.delete(e.tile));
  gameLayer.addTo(map);
  function redrawAll() { liveTiles.forEach(drawTile); }

  function drawTile(tile) {
    const { x, y, z } = tile._coords;
    const ctx = tile.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, 256, 256);

    const scale = 256 * Math.pow(2, z);
    const mPerPx = WORLD / scale;
    const mx0 = (x * 256 / scale - 0.5) * WORLD;
    const my0 = (0.5 - y * 256 / scale) * WORLD;
    const span = 256 * mPerPx;
    const i0 = Math.floor(mx0 / CELL), i1 = Math.floor((mx0 + span) / CELL);
    const j0 = Math.floor((my0 - span) / CELL), j1 = Math.floor(my0 / CELL);
    const w = CELL / mPerPx;
    const t = now();

    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const px = (i * CELL - mx0) / mPerPx;
        const py = (my0 - (j + 1) * CELL) / mPerPx;
        const tree = state.trees[key(i, j)];
        const reach = inReach(i, j);

        if (tree) {
          ctx.fillStyle = 'rgba(10,30,20,0.45)';
          ctx.fillRect(px, py, w, w);
        } else if (reach) {
          ctx.fillStyle = 'rgba(255,215,64,0.14)';
          ctx.fillRect(px, py, w, w);
        }
        ctx.strokeStyle = 'rgba(20,40,30,0.28)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, w, w);
        if (reach) {
          ctx.strokeStyle = 'rgba(255,215,64,0.95)';
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 1.5, py + 1.5, w - 3, w - 3);
        }
        if (tree) {
          const st = E.hydrationState(tree, t);
          if (w >= 10) {
            drawTree(ctx, px + w / 2, py + w * 0.46, w * 0.9, SPECIES[tree.s], st);
            drawHydrationBar(ctx, px, py, w, E.hydrationAt(tree, t), st);
          } else {
            ctx.fillStyle = st === 'withered' ? '#8a7a5a' : SPECIES[tree.s].color;
            ctx.beginPath(); ctx.arc(px + w / 2, py + w / 2, Math.max(2, w * 0.35), 0, Math.PI * 2); ctx.fill();
          }
        }
      }
    }
  }

  function drawHydrationBar(ctx, px, py, w, h, st) {
    const bx = px + w * 0.15, by = py + w * 0.86, bw = w * 0.7, bh = Math.max(2, w * 0.07);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = st === 'bloom' ? '#b6fff0' : st === 'withered' ? '#a0522d' : '#4aa8ff';
    ctx.fillRect(bx, by, st === 'withered' ? bw : bw * (h / 100), bh);
  }

  // Draws a tree centred on (cx, cy) inside a box of size w.
  function drawTree(ctx, cx, cy, w, sp, st) {
    const withered = st === 'withered';
    const color = withered ? '#8a7a5a' : sp.color;
    ctx.save();
    ctx.fillStyle = '#5a3d22';
    ctx.fillRect(cx - w * 0.05, cy + w * 0.08, w * 0.1, w * 0.3);
    if (!withered && sp.glow) {
      ctx.shadowColor = sp.glow;
      ctx.shadowBlur = w * (st === 'bloom' ? 0.7 : 0.35);
    } else if (!withered && st === 'bloom') {
      ctx.shadowColor = '#ffffff';
      ctx.shadowBlur = w * 0.4;
    }
    if (sp.id === 'ironwood' && !withered) {
      const g = ctx.createLinearGradient(cx - w * 0.3, cy - w * 0.4, cx + w * 0.3, cy + w * 0.2);
      g.addColorStop(0, '#ffffff'); g.addColorStop(0.45, '#c9d1d9'); g.addColorStop(1, '#6b7580');
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = color;
    }
    ctx.beginPath();
    switch (sp.shape) {
      case 'oak':
        ctx.arc(cx, cy - w * 0.1, w * 0.26, 0, Math.PI * 2);
        ctx.arc(cx - w * 0.17, cy, w * 0.17, 0, Math.PI * 2);
        ctx.arc(cx + w * 0.17, cy, w * 0.17, 0, Math.PI * 2);
        break;
      case 'conifer':
        for (let k = 0; k < 3; k++) {
          const top = cy - w * 0.42 + k * w * 0.14, base = top + w * 0.26, half = w * (0.14 + k * 0.06);
          ctx.moveTo(cx, top); ctx.lineTo(cx - half, base); ctx.lineTo(cx + half, base); ctx.closePath();
        }
        break;
      case 'willow':
        ctx.arc(cx, cy - w * 0.04, w * 0.28, Math.PI, 0);
        ctx.closePath();
        break;
      case 'cypress':
        ctx.ellipse(cx, cy - w * 0.12, w * 0.13, w * 0.32, 0, 0, Math.PI * 2);
        break;
    }
    ctx.fill();
    if (sp.shape === 'willow') {
      ctx.strokeStyle = ctx.fillStyle;
      ctx.lineWidth = Math.max(1, w * 0.035);
      for (let k = -3; k <= 3; k++) {
        ctx.beginPath();
        ctx.moveTo(cx + k * w * 0.08, cy - w * 0.04);
        ctx.quadraticCurveTo(cx + k * w * 0.09, cy + w * 0.12, cx + k * w * 0.075, cy + w * (0.2 - Math.abs(k) * 0.03));
        ctx.stroke();
      }
    }
    ctx.restore();
    if (st === 'bloom') {
      ctx.fillStyle = 'rgba(255,255,255,0.9)';
      for (const [dx, dy] of [[-0.3, -0.32], [0.32, -0.2], [-0.34, 0.08], [0.28, 0.12], [0.02, -0.46]]) {
        ctx.beginPath(); ctx.arc(cx + dx * w, cy + dy * w, Math.max(0.8, w * 0.025), 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  // ---- Bottom sheet ----
  const sheet = document.getElementById('sheet');
  const sheetBody = document.getElementById('sheetBody');
  let sheetCell = null;
  let sheetMode = null; // 'tree' | 'plant' | 'reveal'
  const $ = (id) => document.getElementById(id);

  function closeSheet() { sheet.classList.add('hidden'); sheetCell = null; sheetMode = null; }
  $('sheetClose').onclick = closeSheet;

  function openCell(i, j) {
    const k = key(i, j);
    if (state.trees[k]) return showTreeSheet(i, j);
    if (!playerPos()) return toast('Waiting for your location…');
    if (!inReach(i, j)) { closeSheet(); return toast('Walk closer to plant here'); }
    showPlantSheet(i, j);
  }

  function showPlantSheet(i, j) {
    sheetCell = [i, j]; sheetMode = 'plant';
    sheetBody.innerHTML = `
      <div class="rarity">Empty plot</div>
      <h3>Plant a seed?</h3>
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
    const roll = E.rollD100();
    const s = E.speciesForRoll(roll);
    const t = now();
    state.trees[k] = { s, h0: C.START_HYDRATION, tw: t, plantedAt: t, roll };
    state.planted++;
    save();
    redrawAll();
    updateHud();
    vibrate(s === 3 ? [100, 50, 100, 50, 300] : 30);
    showReveal(i, j, roll);
  }

  function showReveal(i, j, roll) {
    sheetCell = [i, j]; sheetMode = 'reveal';
    const sp = SPECIES[state.trees[key(i, j)].s];
    sheetBody.innerHTML = `
      <div class="reveal">
        <div class="rarity">You rolled ${roll}</div>
        <canvas id="revealCanvas" width="${120 * dpr}" height="${120 * dpr}" style="width:120px;height:120px"></canvas>
        <div class="big" style="color:${sp.color}">${sp.name}</div>
        <div class="rarity">${sp.rarity} · ${sp.aesthetic}</div>
        <div class="row" style="justify-content:center;gap:6px"><span>Base rate</span><b>${sp.rate} Sap/min</b></div>
      </div>
      <div class="actions"><button id="revealOk">Nice!</button></div>`;
    const cv = $('revealCanvas').getContext('2d');
    cv.scale(dpr, dpr);
    drawTree(cv, 60, 58, 100, sp, 'bloom');
    $('revealOk').onclick = () => showTreeSheet(i, j);
    sheet.classList.remove('hidden');
  }

  function showTreeSheet(i, j) {
    sheetCell = [i, j]; sheetMode = 'tree';
    const sp = SPECIES[state.trees[key(i, j)].s];
    sheetBody.innerHTML = `
      <div class="rarity" style="color:${sp.color}">${sp.rarity} · ${sp.aesthetic}</div>
      <h3>${sp.name}</h3>
      <div class="row"><span>Hydration</span><span id="shHyd"></span></div>
      <div class="bar" id="shBar"><div></div></div>
      <div class="row"><span>State</span><span id="shState"></span></div>
      <div class="row"><span>Production</span><span id="shRate"></span></div>
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
    save();
    redrawAll();
    updateHud();
    updateSheet();
    toast(E.hydrationState(res.tree, now()) === 'bloom' ? 'Canopy Bloom! 2.5x Sap' : `Watered +${Math.round(res.added)}%`);
  }

  const STATE_LABEL = { bloom: 'Canopy Bloom (2.5x)', optimal: 'Optimal (1.0x)', withered: 'Withered (0.1x)' };

  function updateSheet() {
    if (!sheetCell || sheet.classList.contains('hidden')) return;
    const [i, j] = sheetCell;
    const t = now();
    if (sheetMode === 'plant') {
      const cost = E.plantCost(state.planted);
      $('shCost').textContent = cost ? `${cost} HE` : 'Free (first tree)';
      $('shHE').textContent = fmt(state.he);
      const ok = inReach(i, j) && state.he >= cost && !state.trees[key(i, j)];
      $('plantBtn').disabled = !ok;
      $('plantBtn').textContent = !inReach(i, j) ? 'Walk closer to plant' : state.he < cost ? 'Not enough HE' : 'Plant seed';
    } else if (sheetMode === 'tree') {
      const tree = state.trees[key(i, j)];
      if (!tree) return closeSheet();
      const sp = SPECIES[tree.s];
      const st = E.hydrationState(tree, t);
      const hyd = E.displayHydration(tree, t);
      $('shHyd').textContent = hyd + '%';
      $('shBar').className = 'bar ' + st;
      $('shBar').firstChild.style.width = (st === 'withered' ? 100 : E.hydrationAt(tree, t)) + '%';
      $('shState').textContent = STATE_LABEL[st];
      $('shState').className = 'state-' + st;
      const hm = E.HYDRATION_MULTIPLIER[st], fb = E.fertilizerBoost(state.boostUntil, t);
      $('shRate').textContent = `${sp.rate} × ${hm} × ${fb} = ${fmt(sp.rate * hm * fb)} Sap/min`;
      if (st === 'bloom') { $('shNextLabel').textContent = 'Bloom ends in'; $('shNext').textContent = fmtDur(E.drainStart(tree) - t); }
      else if (st === 'optimal') { $('shNextLabel').textContent = 'Withers in'; $('shNext').textContent = fmtDur(E.dryAt(tree) - t); }
      else { $('shNextLabel').textContent = 'Withered for'; $('shNext').textContent = fmtDur(t - E.dryAt(tree)); }

      const btn = $('waterBtn'), hint = $('shHint');
      const full = E.waterCostToFull(tree, t);
      hint.textContent = '';
      if (st === 'bloom') { btn.disabled = true; btn.textContent = 'Fully watered'; }
      else if (!inReach(i, j)) { btn.disabled = true; btn.textContent = `Water to 100% (${Math.ceil(full)} HE)`; hint.textContent = 'Walk to this tree to water it.'; }
      else if (state.he < 1) { btn.disabled = true; btn.textContent = 'Not enough HE'; hint.textContent = 'Walk to earn Hydro-Kinetic Energy.'; }
      else if (state.he >= full) { btn.disabled = false; btn.textContent = `Water to 100% (−${Math.ceil(full)} HE)`; }
      else { btn.disabled = false; btn.textContent = `Water +${Math.floor(state.he / C.WATER_COST_HE_PER_PCT)}% (−${Math.floor(state.he)} HE)`; }
    }
  }

  map.on('click', (e) => {
    if (map.getZoom() < MIN_GAME_ZOOM) return;
    const [i, j] = cellOf(e.latlng);
    openCell(i, j);
  });

  // ---- HUD ----
  function fmt(n) {
    n = Math.floor(n);
    if (n < 10000) return n.toLocaleString();
    const units = [['B', 1e9], ['M', 1e6], ['K', 1e3]];
    for (const [u, v] of units) if (n >= v) return (n / v).toFixed(n / v < 100 ? 1 : 0) + u;
    return String(n);
  }
  function fmtDur(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
  }
  let lastRedraw = 0;
  function updateHud() {
    settle();
    const t = now();
    $('he').textContent = fmt(state.he);
    $('sap').textContent = fmt(state.sap);
    const rate = totalRate(t);
    $('sapRate').textContent = rate ? `+${fmt(rate)}/min` : '';
    $('trees').textContent = Object.keys(state.trees).length;
    const boostLeft = state.boostUntil - t;
    $('boostStat').classList.toggle('hidden', boostLeft <= 0);
    if (boostLeft > 0) $('boost').textContent = fmtDur(boostLeft);
    if (t - lastRedraw > 15000) { lastRedraw = t; redrawAll(); }
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

  // ---- Ad boost (mock) ----
  $('adBtn').onclick = () => {
    const overlay = $('adOverlay');
    let left = C.AD_LENGTH_S;
    $('adCountdown').textContent = left;
    overlay.classList.remove('hidden');
    const iv = setInterval(() => {
      left--;
      $('adCountdown').textContent = left;
      if (left > 0) return;
      clearInterval(iv);
      overlay.classList.add('hidden');
      settle();
      state.boostUntil = Math.max(now(), state.boostUntil) + C.AD_BOOST_MS;
      save();
      updateHud();
      updateSheet();
      toast(`Fertilizer boost! 20x Sap for ${Math.round(C.AD_BOOST_MS / 60000)} min`);
    }, 1000);
  };

  // ---- Controls ----
  $('centerBtn').onclick = () => {
    follow = true;
    const pos = playerPos();
    if (pos) map.setView(pos, Math.max(map.getZoom(), 17));
  };
  map.on('dragstart', () => { follow = false; });

  const simBtn = $('simBtn');
  const dpad = $('dpad');
  function setSim(on) {
    simMode = on;
    simBtn.classList.toggle('active', on);
    dpad.classList.toggle('hidden', !on);
    if (on && !simPos) simPos = gpsPos || [map.getCenter().lat, map.getCenter().lng];
    playerCell = null;
    follow = true;
    updatePlayer();
  }
  simBtn.onclick = () => setSim(!simMode);

  function simMove(dxM, dyM) {
    if (!simMode || !simPos) return;
    const k = 1 / Math.cos((simPos[0] * Math.PI) / 180); // ground meters -> mercator meters
    const p = SM.project(L.latLng(simPos));
    const ll = SM.unproject(L.point(p.x + dxM * k, p.y + dyM * k));
    simPos = [ll.lat, ll.lng];
    state.simPos = simPos;
    addMeters(Math.hypot(dxM, dyM)); // sim walking earns HE for testing
    follow = true;
    updatePlayer();
    updateHud();
  }
  const DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
  dpad.querySelectorAll('button').forEach((b) => {
    let rep = null;
    const go = () => { const [dx, dy] = DIRS[b.dataset.dir]; simMove(dx * SIM_STEP_M, dy * SIM_STEP_M); };
    const start = (e) => { e.preventDefault(); go(); rep = setInterval(go, 150); };
    const stop = () => clearInterval(rep);
    b.addEventListener('pointerdown', start);
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => b.addEventListener(ev, stop));
  });
  const KEYS = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  window.addEventListener('keydown', (e) => {
    const d = KEYS[e.code];
    if (d && simMode) { e.preventDefault(); simMove(DIRS[d][0] * SIM_STEP_M, DIRS[d][1] * SIM_STEP_M); }
    else if (e.code === 'Escape') closeSheet();
  });

  const menu = $('menu');
  $('menuBtn').onclick = () => menu.classList.toggle('hidden');
  $('closeMenuBtn').onclick = () => menu.classList.add('hidden');
  $('resetBtn').onclick = () => {
    if (!confirm('Erase all your progress?')) return;
    const keepPos = state.simPos;
    state = freshState();
    state.simPos = keepPos;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    closeSheet();
    redrawAll();
    updateHud();
    menu.classList.add('hidden');
  };

  // Dev helpers (browser console): geogrove.addHE(1000), geogrove.skip(3600e3)
  window.geogrove = {
    get state() { return state; },
    addHE(n) { state.he += n; updateHud(); updateSheet(); },
    skip(ms) { state.timeOffset = (state.timeOffset || 0) + ms; updateHud(); redrawAll(); updateSheet(); },
  };

  if (!localStorage.getItem(STORAGE_KEY)) menu.classList.remove('hidden');
  if (urlPos) setSim(true);
  updateHud();
})();
