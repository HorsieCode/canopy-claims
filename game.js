(() => {
  'use strict';

  // ---- Config ----
  const CELL = 40;               // tile size in Web-Mercator meters (~28 m on the ground at 45° latitude)
  const DENSITY = 0.14;          // chance a tile is a mine
  const SEED = 0x5eed1234;       // same seed = same minefield for every player
  const REACH = 1;               // tiles away from the player that can be dug
  const MAX_LIVES = 3;
  const LIFE_REGEN_MS = 2 * 60 * 1000;
  const MINE_PENALTY = 50;
  const FLOOD_LIMIT = 3000;
  const SIM_STEP_M = 8;
  const MIN_GAME_ZOOM = 15;
  const DEFAULT_POS = [40.7812, -73.9665]; // Central Park, used when GPS is unavailable
  const STORAGE_KEY = 'geosweeper:v1';

  const SM = L.Projection.SphericalMercator;
  const WORLD = 2 * Math.PI * SM.R;
  const NUM_COLORS = ['', '#1976d2', '#388e3c', '#d32f2f', '#7b1fa2', '#ff8f00', '#0097a7', '#424242', '#9e9e9e'];

  // ---- Deterministic minefield ----
  function hash(i, j) {
    let h = Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ SEED;
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const isMine = (i, j) => hash(i, j) < DENSITY;
  function neighbors(i, j) {
    const out = [];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++)
        if (di || dj) out.push([i + di, j + dj]);
    return out;
  }
  const mineCount = (i, j) => neighbors(i, j).reduce((n, [a, b]) => n + (isMine(a, b) ? 1 : 0), 0);
  const key = (i, j) => i + ',' + j;

  function cellOf(latlng) {
    const p = SM.project(L.latLng(latlng));
    return [Math.floor(p.x / CELL), Math.floor(p.y / CELL)];
  }

  // ---- Persistent state ----
  // cells: key -> 'r' (revealed), 'f' (flagged), 'x' (exploded mine)
  let state = load();
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (s && s.cells) return s;
    } catch (e) { /* ignore */ }
    return { cells: {}, score: 0, lives: MAX_LIVES, livesAt: Date.now(), simPos: null };
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => localStorage.setItem(STORAGE_KEY, JSON.stringify(state)), 300);
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
    }
  }

  function inReach(i, j) {
    return playerCell && Math.max(Math.abs(i - playerCell[0]), Math.abs(j - playerCell[1])) <= REACH;
  }

  // ---- GPS ----
  const gpsEl = document.getElementById('gps');
  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(
      (p) => {
        gpsPos = [p.coords.latitude, p.coords.longitude];
        gpsAccuracy = p.coords.accuracy;
        gpsEl.textContent = `GPS ±${Math.round(gpsAccuracy)} m`;
        gpsEl.classList.toggle('warn', gpsAccuracy > 25);
        if (!simMode) updatePlayer();
      },
      (err) => {
        gpsEl.textContent = 'GPS unavailable';
        gpsEl.classList.add('warn');
        if (!gpsPos && !simMode) {
          toast('No GPS, switching to Sim mode');
          setSim(true);
        }
      },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 15000 }
    );
  } else {
    gpsEl.textContent = 'GPS unsupported';
    setTimeout(() => setSim(true), 0);
  }

  // ---- Rendering (canvas grid layer) ----
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
    const mx0 = (x * 256 / scale - 0.5) * WORLD;   // left edge (mercator x)
    const my0 = (0.5 - y * 256 / scale) * WORLD;   // top edge  (mercator y)
    const span = 256 * mPerPx;
    const i0 = Math.floor(mx0 / CELL), i1 = Math.floor((mx0 + span) / CELL);
    const j0 = Math.floor((my0 - span) / CELL), j1 = Math.floor(my0 / CELL);
    const w = CELL / mPerPx;
    const showText = w >= 12;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `bold ${Math.round(w * 0.6)}px system-ui, sans-serif`;

    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const px = (i * CELL - mx0) / mPerPx;
        const py = (my0 - (j + 1) * CELL) / mPerPx;
        const s = state.cells[key(i, j)];
        const reach = inReach(i, j);
        const cx = px + w / 2, cy = py + w / 2;

        if (s === 'r') {
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.fillRect(px, py, w, w);
          const n = mineCount(i, j);
          if (n && showText) {
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.beginPath(); ctx.arc(cx, cy, w * 0.36, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = NUM_COLORS[n];
            ctx.fillText(String(n), cx, cy + 1);
          }
        } else if (s === 'x') {
          ctx.fillStyle = 'rgba(220,30,20,0.75)';
          ctx.fillRect(px, py, w, w);
          if (showText) drawMine(ctx, cx, cy, w);
        } else {
          ctx.fillStyle = reach ? 'rgba(95,150,70,0.62)' : 'rgba(45,85,45,0.62)';
          ctx.fillRect(px, py, w, w);
          if (w >= 8) {
            ctx.fillStyle = 'rgba(255,255,255,0.12)';
            ctx.fillRect(px, py, w, Math.max(1, w * 0.08));
            ctx.fillStyle = 'rgba(0,0,0,0.18)';
            ctx.fillRect(px, py + w - Math.max(1, w * 0.08), w, Math.max(1, w * 0.08));
          }
          if (s === 'f' && showText) drawFlag(ctx, cx, cy, w);
        }

        ctx.strokeStyle = 'rgba(0,0,0,0.30)';
        ctx.lineWidth = 1;
        ctx.strokeRect(px + 0.5, py + 0.5, w, w);
        if (reach) {
          ctx.strokeStyle = 'rgba(255,215,64,0.95)';
          ctx.lineWidth = 2;
          ctx.strokeRect(px + 1.5, py + 1.5, w - 3, w - 3);
        }
      }
    }
  }

  function drawFlag(ctx, cx, cy, w) {
    const h = w * 0.55;
    ctx.fillStyle = '#222';
    ctx.fillRect(cx - w * 0.12, cy - h / 2, Math.max(1.5, w * 0.06), h);
    ctx.fillStyle = '#e53935';
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.08, cy - h / 2);
    ctx.lineTo(cx + w * 0.25, cy - h / 4);
    ctx.lineTo(cx - w * 0.08, cy);
    ctx.fill();
  }

  function drawMine(ctx, cx, cy, w) {
    const r = w * 0.22;
    ctx.strokeStyle = '#111';
    ctx.lineWidth = Math.max(1.5, w * 0.06);
    for (let a = 0; a < 4; a++) {
      const t = (a * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(cx - Math.cos(t) * r * 1.5, cy - Math.sin(t) * r * 1.5);
      ctx.lineTo(cx + Math.cos(t) * r * 1.5, cy + Math.sin(t) * r * 1.5);
      ctx.stroke();
    }
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(cx - r * 0.35, cy - r * 0.35, r * 0.25, 0, Math.PI * 2); ctx.fill();
  }

  // ---- Game logic ----
  let flagMode = false;

  function regenLives() {
    if (state.lives >= MAX_LIVES) { state.livesAt = Date.now(); return; }
    const gained = Math.floor((Date.now() - state.livesAt) / LIFE_REGEN_MS);
    if (gained > 0) {
      state.lives = Math.min(MAX_LIVES, state.lives + gained);
      state.livesAt += gained * LIFE_REGEN_MS;
      save();
    }
  }

  function dig(i, j) {
    const k = key(i, j);
    if (state.cells[k]) return;
    if (isMine(i, j)) {
      if (state.lives >= MAX_LIVES) state.livesAt = Date.now();
      state.cells[k] = 'x';
      state.lives -= 1;
      state.score -= MINE_PENALTY;
      boom();
      return;
    }
    // Flood-fill open area
    const queue = [[i, j]];
    let opened = 0;
    while (queue.length && opened < FLOOD_LIMIT) {
      const [a, b] = queue.pop();
      const kk = key(a, b);
      if (state.cells[kk] || isMine(a, b)) continue;
      state.cells[kk] = 'r';
      opened++;
      const n = mineCount(a, b);
      state.score += 1 + n;
      if (n === 0) for (const nb of neighbors(a, b)) if (!state.cells[key(nb[0], nb[1])]) queue.push(nb);
    }
  }

  function onTap(latlng, forceFlag) {
    if (map.getZoom() < MIN_GAME_ZOOM) return;
    const [i, j] = cellOf(latlng);
    const s = state.cells[key(i, j)];
    if (!playerPos()) return toast('Waiting for your location…');
    if (!inReach(i, j)) return toast('Too far, walk closer');

    if (forceFlag || flagMode) {
      if (s === 'f') delete state.cells[key(i, j)];
      else if (!s) state.cells[key(i, j)] = 'f';
      else return;
      vibrate(15);
    } else {
      regenLives();
      if (state.lives <= 0) return toast('Out of lives, recharging…');
      if (s === 'f') return toast('Flagged. Switch to 🚩 to remove');
      if (s === 'r') {
        // Chord: number tile with all its mines flagged digs the rest
        const n = mineCount(i, j);
        const nbs = neighbors(i, j);
        const flags = nbs.filter(([a, b]) => ['f', 'x'].includes(state.cells[key(a, b)])).length;
        if (!n || flags !== n) return;
        for (const [a, b] of nbs) if (!state.cells[key(a, b)] && state.lives > 0) dig(a, b);
      } else {
        dig(i, j);
      }
    }
    save();
    redrawAll();
    updateHud();
  }

  map.on('click', (e) => onTap(e.latlng, false));
  map.on('contextmenu', (e) => onTap(e.latlng, true)); // right-click / long-press

  function boom() {
    vibrate([80, 40, 160]);
    document.body.classList.remove('boom');
    void document.body.offsetWidth;
    document.body.classList.add('boom');
    setTimeout(() => document.body.classList.remove('boom'), 450);
    toast(`💥 Mine! −${MINE_PENALTY} points`);
  }

  function vibrate(p) { if (navigator.vibrate) navigator.vibrate(p); }

  // ---- HUD ----
  const scoreEl = document.getElementById('score');
  const clearedEl = document.getElementById('cleared');
  const livesEl = document.getElementById('lives');
  function updateHud() {
    regenLives();
    scoreEl.textContent = state.score;
    let cleared = 0;
    for (const k in state.cells) if (state.cells[k] === 'r') cleared++;
    clearedEl.textContent = cleared;
    let txt = '❤'.repeat(Math.max(0, state.lives)) + '♡'.repeat(MAX_LIVES - Math.max(0, state.lives));
    if (state.lives < MAX_LIVES) {
      const left = Math.max(0, LIFE_REGEN_MS - (Date.now() - state.livesAt));
      txt += ` ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`;
    }
    livesEl.textContent = txt;
  }
  setInterval(updateHud, 1000);

  let toastTimer = null;
  const toastEl = document.getElementById('toast');
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // ---- Controls ----
  const modeBtn = document.getElementById('modeBtn');
  modeBtn.onclick = () => {
    flagMode = !flagMode;
    modeBtn.textContent = flagMode ? '🚩 Flag' : '⛏ Reveal';
    modeBtn.className = flagMode ? 'mode-flag' : 'mode-reveal';
  };

  document.getElementById('centerBtn').onclick = () => {
    follow = true;
    const pos = playerPos();
    if (pos) map.setView(pos, Math.max(map.getZoom(), 17));
  };
  map.on('dragstart', () => { follow = false; });

  const simBtn = document.getElementById('simBtn');
  const dpad = document.getElementById('dpad');
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
    save();
    follow = true;
    updatePlayer();
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
    if (d && simMode) {
      e.preventDefault();
      simMove(DIRS[d][0] * SIM_STEP_M, DIRS[d][1] * SIM_STEP_M);
    } else if (e.code === 'KeyF') modeBtn.click();
  });

  const menu = document.getElementById('menu');
  document.getElementById('menuBtn').onclick = () => menu.classList.toggle('hidden');
  document.getElementById('closeMenuBtn').onclick = () => menu.classList.add('hidden');
  document.getElementById('resetBtn').onclick = () => {
    if (!confirm('Erase all your progress?')) return;
    state = { cells: {}, score: 0, lives: MAX_LIVES, livesAt: Date.now(), simPos: state.simPos };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    redrawAll();
    updateHud();
    menu.classList.add('hidden');
  };

  if (!localStorage.getItem(STORAGE_KEY)) menu.classList.remove('hidden');
  if (urlPos) setSim(true);
  updateHud();
})();
