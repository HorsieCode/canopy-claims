// Low-poly 3D trees (three.js). Units are real-world meters; y is up.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

export const TREE_HEIGHT_M = 24;
export const TREE_WIDTH_M = 16;

const cache = {};
const once = (k, f) => cache[k] || (cache[k] = f());
const phong = (o) => new THREE.MeshPhongMaterial({ flatShading: true, ...o });

const LOOKS = {
  ironwood: {
    canopy: { color: 0xdfe4ea, emissive: 0x6a7480, specular: 0xffffff, shininess: 110 },
    dark: { color: 0x8a94a3, emissive: 0x1a1e24, specular: 0xcfd6e0, shininess: 70 },
    accent: { color: 0xf3e2a6, emissive: 0xb89a3a, specular: 0xffffff, shininess: 120 },
    glow: 0xe8f0ff, glowScale: 0.6,
  },
  redwood: {
    canopy: { color: 0xff2d55, emissive: 0xff1744, emissiveIntensity: 0.8, specular: 0xffa0b0, shininess: 40 },
    dark: { color: 0x9c0d30, emissive: 0x5a0018, emissiveIntensity: 0.96, shininess: 20 },
    accent: { color: 0xffb3c1, emissive: 0xff4d6d, emissiveIntensity: 1.92, shininess: 10 },
    glow: 0xff1744,
  },
  willow: {
    canopy: { color: 0xffc23a, emissive: 0xffa000, emissiveIntensity: 0.88, specular: 0xfff0b0, shininess: 35 },
    dark: { color: 0xd47a16, emissive: 0x8a4600, emissiveIntensity: 0.8, shininess: 15 },
    accent: { color: 0xfff6c8, emissive: 0xffe680, emissiveIntensity: 1.92, shininess: 10 },
    glow: 0xffb300,
  },
  cypress: {
    canopy: { color: 0x5ff5d5, emissive: 0x1de9b6, emissiveIntensity: 0.8, specular: 0xffffff, shininess: 140, transparent: true, opacity: 0.9 },
    dark: { color: 0x14967f, emissive: 0x0b5e52, emissiveIntensity: 0.96, shininess: 80 },
    accent: { color: 0xd8ffff, emissive: 0x7ffff0, emissiveIntensity: 1.44, specular: 0xffffff, shininess: 200, transparent: true, opacity: 0.85 },
    glow: 0x1de9b6,
  },
};
// Bloom trees use the same palette with stronger self-illumination.
const speciesMat = (id, part, bloom = false) => once(`${id}-${part}-${bloom}`, () => {
  const def = LOOKS[id][part];
  return phong(bloom ? { ...def, emissiveIntensity: (def.emissiveIntensity ?? 1) * 1.6 } : def);
});
const glowMat = (id, bloom) => once(`glow-${id}-${bloom}`, () => additive(LOOKS[id].glow, (bloom ? 0.42 : 0.26) * (LOOKS[id].glowScale ?? 1)));
const MATS = {
  trunk: () => once('trunk', () => phong({ color: 0x4e3022, shininess: 4 })),
  bark: () => once('bark', () => phong({ color: 0x75492f, shininess: 6 })),
  rock: () => once('rock', () => phong({ color: 0x8c7f92, shininess: 8 })),
  moss: () => once('moss', () => phong({ color: 0x55682c, shininess: 4 })),
  wither: () => once('wither', () => phong({ color: 0x7d6446, shininess: 2 })),
  witherDark: () => once('witherDark', () => phong({ color: 0x5a4532, shininess: 2 })),
  shadow: () => once('shadow', () => new THREE.MeshBasicMaterial({ color: 0x1a1020, transparent: true, opacity: 0.3, depthWrite: false })),
  barBg: () => once('barbg', () => new THREE.MeshBasicMaterial({ color: 0x1d1622, transparent: true, opacity: 0.75, depthWrite: false })),
};
const BAR_COLORS = { bloom: 0xb6fff0, optimal: 0x4aa8ff, withered: 0xa0522d };
const additive = (color, opacity, side = THREE.FrontSide) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side,
});

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Collects transformed geometries per material and merges them into one mesh each (few draw calls per tree).
class Parts {
  constructor(r) { this.r = r; this.lists = {}; }
  add(part, geo, { p = [0, 0, 0], rot = [0, 0, 0], s = [1, 1, 1], jitter = 0 } = {}) {
    geo = geo.index ? geo : geo.clone();
    geo.deleteAttribute('uv');
    geo.deleteAttribute('normal');
    if (jitter) {
      geo = mergeVertices(geo);
      const pos = geo.attributes.position;
      for (let i = 0; i < pos.count; i++)
        pos.setXYZ(i, pos.getX(i) + (this.r() - 0.5) * jitter, pos.getY(i) + (this.r() - 0.5) * jitter, pos.getZ(i) + (this.r() - 0.5) * jitter);
    }
    if (geo.index) geo = geo.toNonIndexed();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rot)), new THREE.Vector3(...s));
    geo.applyMatrix4(m);
    geo.computeVertexNormals();
    (this.lists[part] = this.lists[part] || []).push(geo);
  }
  build(part, material) {
    const l = this.lists[part];
    if (!l) return null;
    const mesh = new THREE.Mesh(mergeGeometries(l), material);
    mesh.userData.part = part;
    return mesh;
  }
}

// Branch from a to b as a tapered cylinder.
function limb(parts, part, a, b, r0, r1, seg = 5) {
  const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b), len = A.distanceTo(B);
  const geo = new THREE.CylinderGeometry(r1, r0, len, seg);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
  geo.applyQuaternion(q);
  const mid = A.add(B).multiplyScalar(0.5);
  parts.add(part, geo, { p: [mid.x, mid.y, mid.z] });
}

function roots(parts, n, r0, reach) {
  const r = parts.r;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + r() * 0.5;
    limb(parts, 'trunk', [Math.cos(a) * r0 * 0.3, 1.6, Math.sin(a) * r0 * 0.3], [Math.cos(a) * reach, 0.05, Math.sin(a) * reach], r0 * 0.55, 0.15, 4);
  }
}

function groundDressing(parts) {
  const r = parts.r;
  for (let k = 0; k < 4; k++) {
    const a = r() * Math.PI * 2, d = 6 + r() * 4, s = 0.6 + r() * 1.1;
    parts.add('rock', new THREE.DodecahedronGeometry(s, 0), { p: [Math.cos(a) * d, s * 0.3, Math.sin(a) * d], rot: [r() * 3, r() * 3, r() * 3], s: [1, 0.6, 1] });
  }
  for (let k = 0; k < 7; k++) {
    const a = r() * Math.PI * 2, d = 3 + r() * 7;
    parts.add('moss', new THREE.ConeGeometry(0.5, 1.3 + r(), 3), { p: [Math.cos(a) * d, 0.6, Math.sin(a) * d], rot: [(r() - 0.5) * 0.6, r() * 3, (r() - 0.5) * 0.6] });
  }
}

const builders = {
  ironwood(P, r) {
    roots(P, 5, 1.6, 4.5);
    limb(P, 'trunk', [0, 0, 0], [0.4, 6, 0.2], 1.6, 1.1, 7);
    limb(P, 'trunk', [0.4, 6, 0.2], [-0.2, 10, 0], 1.1, 0.8, 6);
    const blobs = [];
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + r() * 0.4, d = 4.5 + r() * 1.5, y = 12 + r() * 2.5;
      limb(P, 'bark', [0, 8 + r() * 2, 0], [Math.cos(a) * d * 0.8, y - 1, Math.sin(a) * d * 0.8], 0.55, 0.25);
      blobs.push([Math.cos(a) * d, y, Math.sin(a) * d, 3.4 + r() * 1.4]);
    }
    blobs.push([0, 17, 0, 5], [0, 13.5, 0, 5.5]);
    P.add('dark', new THREE.IcosahedronGeometry(6, 1), { p: [0, 13, 0], s: [1.2, 0.8, 1.2], jitter: 0.9 });
    for (const [x, y, z, s] of blobs) {
      P.add('canopy', new THREE.IcosahedronGeometry(s, 1), { p: [x, y, z], rot: [r() * 3, r() * 3, r() * 3], s: [1, 0.85, 1], jitter: s * 0.22 });
      for (let n = 0; n < 2; n++) {
        const a = r() * Math.PI * 2;
        P.add('accent', new THREE.OctahedronGeometry(0.45, 0), { p: [x + Math.cos(a) * s * 0.9, y - s * 0.5, z + Math.sin(a) * s * 0.9], s: [1, 1.4, 1] });
      }
    }
    return { glowY: 14, top: 22, crownY: 9 };
  },
  redwood(P, r) {
    roots(P, 6, 1.5, 4);
    limb(P, 'trunk', [0, 0, 0], [0, 16, 0], 1.5, 0.5, 7);
    for (let k = 0; k < 6; k++) {
      const y = 6 + k * 3.3, rad = 6.6 - k * 0.95, h = 6.5 - k * 0.3;
      P.add('dark', new THREE.ConeGeometry(rad * 1.05, h * 0.5, 8), { p: [0, y - h * 0.3, 0], rot: [0, r() * 3, 0], jitter: 0.5 });
      P.add('canopy', new THREE.ConeGeometry(rad, h, 8), { p: [0, y, 0], rot: [(r() - 0.5) * 0.12, r() * 3, (r() - 0.5) * 0.12], jitter: 0.8 });
      for (let n = 0; n < 3; n++) {
        const a = r() * Math.PI * 2;
        P.add('accent', new THREE.IcosahedronGeometry(0.42, 0), { p: [Math.cos(a) * rad * 0.85, y - h * 0.45, Math.sin(a) * rad * 0.85], s: [1, 1.5, 1] });
      }
    }
    P.add('canopy', new THREE.ConeGeometry(1.4, 5, 6), { p: [0, 27, 0], jitter: 0.3 });
    return { glowY: 15, top: 30, crownY: 5 };
  },
  willow(P, r) {
    roots(P, 5, 1.6, 4);
    limb(P, 'trunk', [0, 0, 0], [0.8, 5, 0.3], 1.6, 1.2, 7);
    limb(P, 'trunk', [0.8, 5, 0.3], [0, 10, 0], 1.2, 0.8, 6);
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + 0.4;
      limb(P, 'bark', [0, 9, 0], [Math.cos(a) * 4.5, 13, Math.sin(a) * 4.5], 0.6, 0.3);
    }
    P.add('dark', new THREE.IcosahedronGeometry(7, 1), { p: [0, 13, 0], s: [1.3, 0.55, 1.3], jitter: 1 });
    P.add('canopy', new THREE.IcosahedronGeometry(6, 1), { p: [0, 15, 0], s: [1.15, 0.6, 1.15], jitter: 1 });
    const rings = [[3.5, 18, 'dark', 5], [6, 26, 'canopy', 7], [8.2, 30, 'canopy', 8]];
    for (const [rad, n, part, len0] of rings) {
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + r() * 0.25, len = len0 + r() * 4, rr = rad + (r() - 0.5);
        const geo = new THREE.ConeGeometry(0.75 + r() * 0.5, len, 4);
        geo.rotateX(Math.PI);
        P.add(part, geo, { p: [Math.cos(a) * rr, 15.5 - len / 2 - (rad - 3.5) * 0.35, Math.sin(a) * rr], rot: [0, r() * 3, (r() - 0.5) * 0.12] });
      }
    }
    for (let k = 0; k < 12; k++) {
      const a = r() * Math.PI * 2, d = 4 + r() * 4;
      P.add('accent', new THREE.IcosahedronGeometry(0.35, 0), { p: [Math.cos(a) * d, 5 + r() * 8, Math.sin(a) * d] });
    }
    return { glowY: 12, top: 19, crownY: 9 };
  },
  cypress(P, r) {
    roots(P, 4, 1.1, 3);
    limb(P, 'trunk', [0, 0, 0], [0, 6, 0], 1.1, 0.6, 6);
    for (let k = 0; k < 7; k++) {
      const y = 5 + k * 2.8, rad = 5.4 - k * 0.65;
      P.add(k % 2 ? 'dark' : 'canopy', new THREE.ConeGeometry(rad, 6.2, 6), { p: [(r() - 0.5) * 0.5, y, (r() - 0.5) * 0.5], rot: [(r() - 0.5) * 0.2, r() * 3, (r() - 0.5) * 0.2], jitter: 0.7 });
    }
    for (let k = 0; k < 14; k++) {
      const a = r() * Math.PI * 2, y = 5 + r() * 16, d = (5.6 - (y - 5) * 0.23) * 0.9, len = 2 + r() * 2.5;
      P.add('accent', new THREE.OctahedronGeometry(0.7, 0), { p: [Math.cos(a) * d, y, Math.sin(a) * d], rot: [Math.sin(a) * 0.9, 0, -Math.cos(a) * 0.9], s: [0.8, len, 0.8] });
    }
    P.add('accent', new THREE.OctahedronGeometry(1.4, 0), { p: [0, 26, 0], s: [1, 3.2, 1] });
    for (let k = 0; k < 3; k++) {
      const a = r() * Math.PI * 2;
      P.add('accent', new THREE.OctahedronGeometry(0.9, 0), { p: [Math.cos(a) * 5, 0.9, Math.sin(a) * 5], s: [0.9, 2, 0.9], rot: [0.3, a, 0.2] });
    }
    return { glowY: 13, top: 30, crownY: 4 };
  },
};

export function buildTree(species, seed) {
  const id = species.id, r = rng(seed), P = new Parts(r);
  const info = builders[id](P, r);
  groundDressing(P);

  const g = new THREE.Group();
  const crown = new THREE.Group(); // sways around the crown base
  crown.position.y = info.crownY;
  g.add(crown);

  const canopy = [];
  for (const part of ['trunk', 'bark', 'rock', 'moss']) {
    const m = P.build(part, MATS[part]());
    if (m) g.add(m);
  }
  for (const part of ['canopy', 'dark', 'accent']) {
    const m = P.build(part, speciesMat(id, part));
    if (!m) continue;
    m.position.y = -info.crownY;
    crown.add(m);
    canopy.push(m);
  }

  const shadow = new THREE.Mesh(new THREE.CircleGeometry(9, 12), MATS.shadow());
  shadow.rotation.x = -Math.PI / 2; shadow.position.set(3, 0.05, 1.5); shadow.scale.set(1.35, 1, 1);
  g.add(shadow);

  // Glow shells hug each canopy mesh (pushed out along normals) so the tree itself glows, with no halo disc.
  const look = LOOKS[id], shells = [];
  for (const m of canopy) {
    if (m.userData.part === 'dark') continue;
    const geo = m.geometry.clone(), pos = geo.attributes.position, nrm = geo.attributes.normal;
    for (let k = 0; k < pos.count; k++)
      pos.setXYZ(k, pos.getX(k) + nrm.getX(k) * 0.35, pos.getY(k) + nrm.getY(k) * 0.35, pos.getZ(k) + nrm.getZ(k) * 0.35);
    const sh = new THREE.Mesh(geo, glowMat(id, false));
    sh.position.y = m.position.y;
    crown.add(sh);
    shells.push(sh);
  }

  const bar = new THREE.Group();
  bar.position.set(0, 0.2, 12); bar.rotation.x = -Math.PI / 2;
  bar.add(new THREE.Mesh(new THREE.PlaneGeometry(16, 1.8), MATS.barBg()));
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(16, 1.8), new THREE.MeshBasicMaterial({ color: BAR_COLORS.optimal, depthWrite: false }));
  fill.position.z = 0.05;
  bar.add(fill);
  g.add(bar);

  g.userData = { species, crown, canopy, shells, fill, bar, state: null, phase: r() * 10, lastT: 0 };
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
  const withered = state === 'withered', id = u.species.id;
  for (const m of u.canopy) {
    const part = m.userData.part;
    if (part === 'accent') m.visible = !withered;
    else m.material = withered ? (part === 'dark' ? MATS.witherDark() : MATS.wither()) : speciesMat(id, part, state === 'bloom');
  }
  g.rotation.z = withered ? 0.06 : 0;
  for (const sh of u.shells) { sh.visible = !withered; sh.material = glowMat(id, state === 'bloom'); }
}

export function animateTree(g, t) {
  const u = g.userData;
  const dt = Math.min(0.1, u.lastT ? (t - u.lastT) / 1000 : 0);
  u.lastT = t;
  const amp = u.state === 'withered' ? 0.005 : 0.025;
  u.crown.rotation.z = Math.sin(t * 0.0011 + u.phase) * amp;
  u.crown.rotation.x = Math.cos(t * 0.0008 + u.phase) * amp * 0.6;
}

export function addLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffd9b0, 0x5a6232, 1.5));
  const sun = new THREE.DirectionalLight(0xffb070, 2.4);
  sun.position.set(-60, 40, -30);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xa890ff, 0.6);
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
  tree.userData.bar.visible = false;
  scene.add(tree);
  const cam = new THREE.PerspectiveCamera(35, canvas.clientWidth / canvas.clientHeight, 1, 500);
  cam.position.set(0, 24, 62);
  cam.lookAt(0, 13, 0);
  let raf = 0;
  const loop = (t) => { tree.rotation.y = t * 0.0005; animateTree(tree, t); renderer.render(scene, cam); raf = requestAnimationFrame(loop); };
  raf = requestAnimationFrame(loop);
  return () => { cancelAnimationFrame(raf); renderer.dispose(); };
}
