// Low-poly 3D trees (three.js). Units are real-world meters; y is up.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const TREE_HEIGHT_M = 22;
export const TREE_WIDTH_M = 16;

const cache = {};
const once = (k, f) => cache[k] || (cache[k] = f());

const trunkMat = () => once('trunk', () => new THREE.MeshPhongMaterial({ color: 0x5b3826, flatShading: true, shininess: 4 }));
const witherMat = () => once('wither', () => new THREE.MeshPhongMaterial({ color: 0x7d6446, flatShading: true, shininess: 2 }));
const shadowMat = () => once('shadow', () => new THREE.MeshBasicMaterial({ color: 0x1a1020, transparent: true, opacity: 0.28, depthWrite: false }));
const barBgMat = () => once('barbg', () => new THREE.MeshBasicMaterial({ color: 0x1d1622, transparent: true, opacity: 0.75, depthWrite: false }));
const BAR_COLORS = { bloom: 0xb6fff0, optimal: 0x4aa8ff, withered: 0xa0522d };

const SPECIES_LOOK = {
  ironwood: { color: 0xd9dee4, emissive: 0x2a2f36, emissiveIntensity: 1, specular: 0xffffff, shininess: 90, glow: 0xffffff },
  redwood:  { color: 0xff2d55, emissive: 0xff1744, emissiveIntensity: 0.55, specular: 0xff9aa8, shininess: 40, glow: 0xff1744 },
  willow:   { color: 0xffc23a, emissive: 0xffa000, emissiveIntensity: 0.6, specular: 0xfff0b0, shininess: 30, glow: 0xffb300 },
  cypress:  { color: 0x5ff5d5, emissive: 0x1de9b6, emissiveIntensity: 0.55, specular: 0xffffff, shininess: 120, glow: 0x1de9b6, transparent: true, opacity: 0.9 },
};
const canopyMat = (id) => once('canopy-' + id, () => {
  const { glow, ...look } = SPECIES_LOOK[id];
  return new THREE.MeshPhongMaterial({ flatShading: true, ...look });
});
const glowMat = (id, o) => once(`glow-${id}-${o}`, () => new THREE.MeshBasicMaterial({
  color: SPECIES_LOOK[id].glow, transparent: true, opacity: o, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.BackSide,
}));

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function mesh(geo, mat, x = 0, y = 0, z = 0) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); return m; }

function trunk(h, rTop, rBot, lean = 0) {
  const m = mesh(new THREE.CylinderGeometry(rTop, rBot, h, 6), trunkMat(), 0, h / 2, 0);
  m.rotation.z = lean;
  return m;
}

const builders = {
  ironwood(g, r) {
    g.add(trunk(9, 0.8, 1.4));
    const br = mesh(new THREE.CylinderGeometry(0.4, 0.7, 6, 5), trunkMat(), -2, 9, 0); br.rotation.z = 0.8; g.add(br);
    const br2 = mesh(new THREE.CylinderGeometry(0.4, 0.7, 5, 5), trunkMat(), 2, 9.5, 0.5); br2.rotation.z = -0.7; g.add(br2);
    const blobs = [[0, 15.5, 0, 6], [-5, 12.5, 1, 4.6], [5, 13, -1, 4.4], [1, 11.5, 4.5, 3.6], [-1, 12, -4.5, 3.4]];
    for (const [x, y, z, s] of blobs) {
      const m = mesh(new THREE.IcosahedronGeometry(s * (0.9 + r() * 0.2), 0), canopyMat('ironwood'), x, y, z);
      m.rotation.set(r() * 3, r() * 3, r() * 3);
      m.userData.canopy = true;
      g.add(m);
    }
    return 14;
  },
  redwood(g, r) {
    g.add(trunk(8, 0.7, 1.3));
    for (let k = 0; k < 4; k++) {
      const m = mesh(new THREE.ConeGeometry(6.2 - k * 1.3, 7.5, 7), canopyMat('redwood'), 0, 9 + k * 3.6, 0);
      m.rotation.y = r() * Math.PI; m.userData.canopy = true; g.add(m);
    }
    return 14;
  },
  willow(g, r) {
    const t = trunk(9, 0.9, 1.5, 0.08); g.add(t);
    const dome = mesh(new THREE.IcosahedronGeometry(6.5, 1), canopyMat('willow'), 0, 14, 0);
    dome.scale.set(1.25, 0.7, 1.25); dome.userData.canopy = true; g.add(dome);
    const strands = [];
    for (let k = 0; k < 44; k++) {
      const a = (k / 44) * Math.PI * 2 + r() * 0.2, rad = 4.5 + r() * 3.5, len = 6 + r() * 4;
      const geo = new THREE.ConeGeometry(0.9 + r() * 0.5, len, 4);
      geo.rotateX(Math.PI);
      geo.translate(Math.cos(a) * rad, 14 - len / 2 + 0.5 - (rad - 4.5) * 0.4, Math.sin(a) * rad);
      strands.push(geo);
    }
    const s = mesh(mergeGeometries(strands), canopyMat('willow')); s.userData.canopy = true; g.add(s);
    return 13;
  },
  cypress(g, r) {
    g.add(trunk(4, 0.7, 1.1));
    for (let k = 0; k < 6; k++) {
      const m = mesh(new THREE.ConeGeometry(5.6 - k * 0.8, 6.5, 6), canopyMat('cypress'), (r() - 0.5) * 0.6, 6 + k * 2.9, (r() - 0.5) * 0.6);
      m.rotation.set((r() - 0.5) * 0.25, r() * Math.PI, (r() - 0.5) * 0.25); m.userData.canopy = true; g.add(m);
    }
    return 13;
  },
};

export function buildTree(species, seed) {
  const g = new THREE.Group();
  const r = rng(seed);
  const glowY = builders[species.id](g, r);

  const shadow = mesh(new THREE.CircleGeometry(8.5, 10), shadowMat(), 3, 0.05, 1.5);
  shadow.rotation.x = -Math.PI / 2; shadow.scale.set(1.3, 1, 1);
  g.add(shadow);

  const glow = new THREE.Group();
  glow.position.y = glowY;
  glow.add(mesh(new THREE.IcosahedronGeometry(11, 2), glowMat(species.id, 0.09)));
  glow.add(mesh(new THREE.IcosahedronGeometry(14, 2), glowMat(species.id, 0.04)));
  g.add(glow);

  const pts = new Float32Array(16 * 3);
  for (let k = 0; k < 16; k++) {
    const a = r() * Math.PI * 2, rad = 6 + r() * 5;
    pts.set([Math.cos(a) * rad, glowY - 6 + r() * 14, Math.sin(a) * rad], k * 3);
  }
  const sparkGeo = new THREE.BufferGeometry(); sparkGeo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const sparkles = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 3, sizeAttenuation: false, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  g.add(sparkles);

  const bar = new THREE.Group();
  bar.position.set(0, 0.15, 11);
  bar.rotation.x = -Math.PI / 2;
  bar.add(mesh(new THREE.PlaneGeometry(16, 1.8), barBgMat()));
  const fill = mesh(new THREE.PlaneGeometry(16, 1.8), new THREE.MeshBasicMaterial({ color: BAR_COLORS.optimal, depthWrite: false }), 0, 0, 0.05);
  bar.add(fill);
  g.add(bar);

  g.userData = { species, glow, sparkles, fill, canopy: g.children.filter((c) => c.userData.canopy), state: null };
  return g;
}

// state: 'bloom' | 'optimal' | 'withered'; hydration 0..100
export function applyTreeState(g, state, hydration) {
  const u = g.userData;
  const frac = state === 'withered' ? 1 : Math.max(0.02, hydration / 100);
  u.fill.scale.x = frac;
  u.fill.position.x = -8 * (1 - frac);
  if (u.state === state) return;
  u.state = state;
  u.fill.material.color.setHex(BAR_COLORS[state]);
  const withered = state === 'withered';
  for (const c of u.canopy) c.material = withered ? witherMat() : canopyMat(u.species.id);
  g.rotation.z = withered ? 0.06 : 0;
  u.glow.visible = !withered && (u.species.id !== 'ironwood' || state === 'bloom');
  u.glow.scale.setScalar(state === 'bloom' ? 1.25 : 1);
  u.sparkles.visible = state === 'bloom';
}

export function animateTree(g, t) {
  const u = g.userData;
  if (u.sparkles.visible) u.sparkles.rotation.y = t * 0.0004;
  if (u.glow.visible) u.glow.scale.setScalar((u.state === 'bloom' ? 1.25 : 1) * (1 + Math.sin(t * 0.002) * 0.04));
}

export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffd9b0, 0x5a6232, 1.6));
  const sun = new THREE.DirectionalLight(0xffb070, 2.2);
  sun.position.set(-60, 40, -30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa890ff, 0.5);
  fill.position.set(50, 30, 40);
  scene.add(fill);
}

// Spinning preview of a tree on a standalone canvas. Returns a stop() function.
export function startPreview(canvas, species, seed) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  const scene = new THREE.Scene();
  addLights(scene);
  const tree = buildTree(species, seed);
  applyTreeState(tree, 'bloom', 100);
  tree.userData.fill.parent.visible = false;
  scene.add(tree);
  const cam = new THREE.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 1, 500);
  cam.position.set(0, 22, 52);
  cam.lookAt(0, 11, 0);
  let raf = 0;
  const loop = (t) => { tree.rotation.y = t * 0.0006; animateTree(tree, t); renderer.render(scene, cam); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  return () => { cancelAnimationFrame(raf); renderer.dispose(); };
}
