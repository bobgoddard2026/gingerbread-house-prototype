// The Gingerbread House walk-through. Static files, no build step.
// All light is baked into the textures; nothing here computes lighting.
import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/jsm/libs/meshopt_decoder.module.js';

const $ = (id) => document.getElementById(id);
const canvas = $('view');
const stage = $('stage');
const fade = $('fade');
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = matchMedia('(pointer: coarse)').matches;
const small = Math.min(screen.width, screen.height) < 900;
if (coarse) document.body.classList.add('touch');
if (coarse) $('hint').textContent = 'Drag to look around. Tap the floor to walk there, or hold Forward and Back.';

function showFallback() {
  document.body.classList.add('no-webgl');
  document.querySelectorAll('.rooms button').forEach((b) => {
    b.addEventListener('click', () => {
      const f = document.getElementById('f-' + b.dataset.room);
      if (f) f.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
    });
  });
}

function webglOK() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch (e) { return false; }
}
if (!webglOK()) { showFallback(); throw new Error('no webgl'); }

// ---- progress --------------------------------------------------------------
let bytesDone = 0, bytesTotal = 1;
function bump(n) {
  bytesDone += n;
  const pct = Math.min(100, (bytesDone / bytesTotal) * 100);
  $('barfill').style.width = pct.toFixed(1) + '%';
  $('progtext').textContent = 'Loading the rooms: ' + Math.round(pct) + ' percent';
}
async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('could not load ' + url);
  if (!res.body || !res.body.getReader) {
    const b = await res.arrayBuffer();
    bump(b.byteLength);
    return b;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    bump(value.length);
  }
  const out = new Uint8Array(got);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out.buffer;
}

async function loadTexture(url, maxAniso) {
  const buf = await fetchBytes(url);
  const blob = new Blob([buf], { type: 'image/webp' });
  let picture;
  try {
    picture = await createImageBitmap(blob, { colorSpaceConversion: 'none' });
  } catch (err) {
    // Older Safari: decode through a plain image element instead.
    picture = await new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = no;
      im.src = URL.createObjectURL(blob);
    });
  }
  const tex = new THREE.Texture(picture);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.flipY = false;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;
  return tex;
}

// ---- three.js ---------------------------------------------------------------
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) { showFallback(); throw e; }
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;
renderer.setClearColor(0xf3f8fb, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, 1, 0.05, 600);

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.75 : 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.fov = camera.aspect < 0.8 ? 78 : (camera.aspect < 1.2 ? 72 : 62);
  camera.updateProjectionMatrix();
  dirty = true;
}
let dirty = true;
new ResizeObserver(resize).observe(stage);

// ---- world / collision -------------------------------------------------------
let RECTS = [], WALLS = [], BOUNDS = null, SPAWNS = {}, EYE = 1.45, RAD = 0.22;

function setPlan(c) {
  RECTS = c.rects;
  WALLS = RECTS.filter((r) => r.kind === 'wall');
  BOUNDS = c.bounds; SPAWNS = c.spawns; EYE = c.eye; RAD = c.radius;
}

function insideRect(r, x, y, pad = 0) {
  return x > r.x0 - pad && x < r.x1 + pad && y > r.y0 - pad && y < r.y1 + pad;
}

function resolve(x, y) {
  // Slide: push the walker out of any rectangle along the shortest way.
  for (let iter = 0; iter < 4; iter++) {
    let moved = false;
    for (const r of RECTS) {
      const nx = Math.max(r.x0, Math.min(x, r.x1));
      const ny = Math.max(r.y0, Math.min(y, r.y1));
      let dx = x - nx, dy = y - ny;
      const d2 = dx * dx + dy * dy;
      if (d2 >= RAD * RAD) continue;
      moved = true;
      if (d2 > 1e-9) {
        const d = Math.sqrt(d2), k = (RAD - d) / d;
        x += dx * k; y += dy * k;
      } else {
        // center is inside the rectangle: leave by the nearest side
        const left = x - r.x0, right = r.x1 - x, down = y - r.y0, up = r.y1 - y;
        const m = Math.min(left, right, down, up);
        if (m === left) x = r.x0 - RAD; else if (m === right) x = r.x1 + RAD;
        else if (m === down) y = r.y0 - RAD; else y = r.y1 + RAD;
      }
    }
    if (!moved) break;
  }
  const B = BOUNDS;
  x = Math.max(B.x0 + RAD, Math.min(B.x1 - RAD, x));
  y = Math.max(B.y0 + RAD, Math.min(B.y1 - RAD, y));
  return [x, y];
}

function isFree(x, y) {
  if (x < BOUNDS.x0 + RAD || x > BOUNDS.x1 - RAD || y < BOUNDS.y0 + RAD || y > BOUNDS.y1 - RAD) return false;
  for (const r of RECTS) {
    const nx = Math.max(r.x0, Math.min(x, r.x1));
    const ny = Math.max(r.y0, Math.min(y, r.y1));
    const dx = x - nx, dy = y - ny;
    if (dx * dx + dy * dy < (RAD + 0.01) * (RAD + 0.01)) return false;
  }
  return true;
}

function segClear(ax, ay, bx, by) {
  const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / 0.08));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (!isFree(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
  }
  return true;
}

// Grid path for tap-to-walk, so a tap across the room goes around the furniture.
const CELL = 0.2;
function findPath(sx, sy, tx, ty) {
  if (segClear(sx, sy, tx, ty)) return [[tx, ty]];
  const B = BOUNDS;
  const nx = Math.ceil((B.x1 - B.x0) / CELL), ny = Math.ceil((B.y1 - B.y0) / CELL);
  const idx = (i, j) => j * nx + i;
  const cellOf = (x, y) => [Math.max(0, Math.min(nx - 1, Math.floor((x - B.x0) / CELL))), Math.max(0, Math.min(ny - 1, Math.floor((y - B.y0) / CELL)))];
  const center = (i, j) => [B.x0 + (i + 0.5) * CELL, B.y0 + (j + 0.5) * CELL];
  const free = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const [x, y] = center(i, j);
    free[idx(i, j)] = isFree(x, y) ? 1 : 0;
  }
  const near = (i0, j0) => {
    if (free[idx(i0, j0)]) return [i0, j0];
    for (let r = 1; r < 12; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      const i = i0 + di, j = j0 + dj;
      if (i >= 0 && j >= 0 && i < nx && j < ny && free[idx(i, j)]) return [i, j];
    }
    return null;
  };
  const start = near(...cellOf(sx, sy)), goal = near(...cellOf(tx, ty));
  if (!start || !goal) return null;
  const startI = idx(...start), goalI = idx(...goal);
  const dist = new Float32Array(nx * ny).fill(Infinity), came = new Int32Array(nx * ny).fill(-1);
  dist[startI] = 0;
  const open = [startI];
  const h = (k) => { const i = k % nx, j = (k / nx) | 0; return Math.hypot(i - goal[0], j - goal[1]); };
  const dirs = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
  while (open.length) {
    let best = 0, bf = Infinity;
    for (let q = 0; q < open.length; q++) { const f = dist[open[q]] + h(open[q]); if (f < bf) { bf = f; best = q; } }
    const cur = open.splice(best, 1)[0];
    if (cur === goalI) break;
    const ci = cur % nx, cj = (cur / nx) | 0;
    for (const [dx, dy, c] of dirs) {
      const ni = ci + dx, nj = cj + dy;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const k = idx(ni, nj);
      if (!free[k]) continue;
      if (dx && dy && (!free[idx(ci + dx, cj)] || !free[idx(ci, cj + dy)])) continue;
      const g = dist[cur] + c;
      if (g < dist[k]) { dist[k] = g; came[k] = cur; open.push(k); }
    }
  }
  if (came[goalI] < 0 && goalI !== startI) return null;
  const raw = [];
  for (let k = goalI; k !== -1 && k !== startI; k = came[k]) { const i = k % nx, j = (k / nx) | 0; raw.push(center(i, j)); }
  raw.reverse();
  raw.push([tx, ty]);
  // Straighten the path: skip points while a straight walk is clear.
  const out = [];
  let ax = sx, ay = sy, i = 0;
  while (i < raw.length) {
    let j = raw.length - 1;
    while (j > i && !segClear(ax, ay, raw[j][0], raw[j][1])) j--;
    out.push(raw[j]);
    [ax, ay] = raw[j];
    i = j + 1;
  }
  return out;
}

// ---- player -------------------------------------------------------------------
const P = { x: 0, y: 0.95, h: 0, p: -4 };
let path = null;
function applyCamera() {
  camera.position.set(P.x, EYE, -P.y);
  camera.rotation.set(THREE.MathUtils.degToRad(P.p), THREE.MathUtils.degToRad(-P.h), 0, 'YXZ');
  dirty = true;
}
function setPose(x, y, h, p = -3) {
  [P.x, P.y] = resolve(x, y); P.h = h; P.p = p; path = null; applyCamera();
}

const held = new Set();
const MAP = { ArrowUp: 'f', KeyW: 'f', ArrowDown: 'b', KeyS: 'b', KeyA: 'l', KeyD: 'r', ArrowLeft: 'tl', ArrowRight: 'tr' };
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = MAP[e.code];
  if (k) { held.add(k); e.preventDefault(); path = null; }
});
addEventListener('keyup', (e) => { const k = MAP[e.code]; if (k) held.delete(k); });
addEventListener('blur', () => held.clear());

function bindHold(btn, key) {
  const on = (e) => { e.preventDefault(); held.add(key); path = null; try { btn.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ } };
  const off = () => held.delete(key);
  btn.addEventListener('pointerdown', on);
  btn.addEventListener('pointerup', off);
  btn.addEventListener('pointercancel', off);
  btn.addEventListener('lostpointercapture', off);
}
bindHold($('fwd'), 'f');
bindHold($('back'), 'b');

// drag to look; a short press with no drag is a tap (walk there)
let dragging = null;
canvas.addEventListener('pointerdown', (e) => {
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
  dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), moved: false };
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging || dragging.id !== e.pointerId) return;
  const dx = e.clientX - dragging.x, dy = e.clientY - dragging.y;
  dragging.x = e.clientX; dragging.y = e.clientY;
  if (Math.hypot(e.clientX - dragging.sx, e.clientY - dragging.sy) > 8) dragging.moved = true;
  if (!dragging.moved) return;
  const k = 180 / Math.max(280, stage.clientHeight) * 0.75;
  P.h -= dx * k;
  P.p = Math.max(-68, Math.min(52, P.p - dy * k));
  path = null;
  applyCamera();
});
function endDrag(e) {
  if (!dragging || dragging.id !== e.pointerId) return;
  const tapped = !dragging.moved && performance.now() - dragging.t < 500;
  const tx = dragging.sx, ty = dragging.sy;
  dragging = null;
  if (tapped && e.type === 'pointerup') tapAt(tx, ty);
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

const ray = new THREE.Raycaster();
function tapAt(clientX, clientY) {
  const b = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2((clientX - b.left) / b.width * 2 - 1, -((clientY - b.top) / b.height) * 2 + 1), camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  if (d.y > -0.02) return; // above the horizon: a wall or the ceiling, not the floor
  const t = -o.y / d.y;
  let hx = o.x + d.x * t, hy = -(o.z + d.z * t);
  // stop at the first wall along the line of sight
  const L = Math.hypot(hx - P.x, hy - P.y), n = Math.ceil(L / 0.05);
  let tx = P.x, ty = P.y;
  for (let i = 1; i <= n; i++) {
    const x = P.x + (hx - P.x) * i / n, y = P.y + (hy - P.y) * i / n;
    if (WALLS.some((r) => insideRect(r, x, y))) break;
    tx = x; ty = y;
  }
  showMarker(clientX - b.left, clientY - b.top);
  if (reduced) {
    const route = findPath(P.x, P.y, tx, ty);
    if (route && route.length) { const end = route[route.length - 1]; [P.x, P.y] = resolve(end[0], end[1]); applyCamera(); }
    return;
  }
  path = findPath(P.x, P.y, tx, ty);
}

let markerTimer = 0;
function showMarker(x, y) {
  const m = $('marker');
  m.style.left = x + 'px'; m.style.top = y + 'px'; m.style.opacity = 1;
  clearTimeout(markerTimer);
  markerTimer = setTimeout(() => (m.style.opacity = 0), 500);
}

// ---- rooms --------------------------------------------------------------------
let current = 'Entry', jumping = false;
function markRoom() {
  document.querySelectorAll('.rooms button').forEach((b) => {
    const on = b.dataset.room === current;
    b.classList.toggle('here', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
}
function gotoRoom(name) {
  const s = SPAWNS[name];
  if (!s || jumping) return;
  const finish = () => { setPose(s.x, s.y, s.yaw, -6); current = name; markRoom(); };
  if (reduced) { finish(); return; }
  jumping = true;
  fade.style.opacity = 1;
  setTimeout(() => { finish(); requestAnimationFrame(() => { fade.style.opacity = 0; jumping = false; }); }, 180);
}
document.querySelectorAll('.rooms button').forEach((b) => b.addEventListener('click', () => gotoRoom(b.dataset.room)));

function roomAt(x, y) {
  if (y > 7.1) return 'Corridor';
  for (const [n, r] of [['Infants', [-13.7, -7.6]], ['Toddlers', [-7.6, -1.4]], ['Entry', [-1.4, 1.4]], ['Preschool', [1.4, 7.6]], ['Pre-K', [7.6, 13.7]]])
    if (x >= r[0] && x < r[1]) return n;
  return 'Entry';
}

// ---- movement loop --------------------------------------------------------------
let last = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  step(dt);
  if (dirty) { renderer.render(scene, camera); dirty = false; }
}

function step(dt) {
  const SPEED = 1.9, TURN = 72;
  if (held.has('tl')) { P.h -= TURN * dt; dirty = true; }
  if (held.has('tr')) { P.h += TURN * dt; dirty = true; }
  let vx = 0, vy = 0;
  const hr = THREE.MathUtils.degToRad(P.h);
  if (held.has('f')) { vx += Math.sin(hr); vy += Math.cos(hr); }
  if (held.has('b')) { vx -= Math.sin(hr); vy -= Math.cos(hr); }
  if (held.has('l')) { vx -= Math.cos(hr); vy += Math.sin(hr); }
  if (held.has('r')) { vx += Math.cos(hr); vy -= Math.sin(hr); }
  if (vx || vy) {
    const L = Math.hypot(vx, vy);
    moveBy((vx / L) * SPEED * dt, (vy / L) * SPEED * dt);
    path = null;
  } else if (path && path.length) {
    let left = 1.7 * dt;
    while (left > 0 && path.length) {
      const [tx, ty] = path[0];
      const dx = tx - P.x, dy = ty - P.y, d = Math.hypot(dx, dy);
      if (d < 0.03) { path.shift(); continue; }
      const m = Math.min(left, d);
      moveBy((dx / d) * m, (dy / d) * m);
      left -= m;
      if (m < 1e-4) { path = null; break; }
    }
  }
  if (held.size || path) {
    applyCamera();
    const room = roomAt(P.x, P.y);
    if (room !== current && room !== 'Corridor') { current = room; markRoom(); }
  }
}

function moveBy(dx, dy) {
  // Small steps so the walker can never hop over a wall in one frame.
  const dist = Math.hypot(dx, dy), n = Math.max(1, Math.ceil(dist / 0.06));
  for (let i = 0; i < n; i++) {
    [P.x, P.y] = resolve(P.x + dx / n, P.y + dy / n);
  }
}

// ---- boot -----------------------------------------------------------------------
async function main() {
  const manifest = await (await fetch('assets/manifest.json')).json();
  const collide = await (await fetch('assets/collision.json')).json();
  setPlan(collide);
  const maxTex = renderer.capabilities.maxTextureSize;
  const usePhone = (coarse && small) || maxTex < 4096 || (navigator.deviceMemory && navigator.deviceMemory < 4);
  const set = usePhone ? manifest.phone : manifest.desktop;
  bytesTotal = set.bytes + manifest.glb_bytes;
  const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy(), usePhone ? 4 : 8);

  await MeshoptDecoder.ready;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const glbBuf = await fetchBytes(manifest.glb);
  const tex = {};
  await Promise.all(Object.entries(set.files).map(async ([k, f]) => { tex[k] = await loadTexture('assets/' + f, maxAniso); }));
  const gltf = await new Promise((ok, no) => loader.parse(glbBuf, './', ok, no));

  const basic = (t) => new THREE.MeshBasicMaterial({ map: t, side: THREE.FrontSide });
  const mats = { fc: basic(tex.floorceil), walls: basic(tex.walls), furn: basic(tex.furn), toys: basic(tex.toys) };
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const n = (o.name || '') + ' ' + (o.parent ? o.parent.name : '');
    if (n.includes('atlas_floorceil')) o.material = mats.fc;
    else if (n.includes('atlas_walls')) o.material = mats.walls;
    else if (n.includes('atlas_furn')) o.material = mats.furn;
    else if (n.includes('atlas_toys')) o.material = mats.toys;
    else if (n.includes('exterior')) {
      o.material = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false });
    } else if (n.includes('snowflakes')) {
      o.material = new THREE.MeshBasicMaterial({ color: 0xf6f9fc, side: THREE.DoubleSide });
    } else if (n.includes('glass')) {
      o.material = new THREE.MeshBasicMaterial({ color: 0xeef6ff, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide });
      o.renderOrder = 2;
    } else {
      o.visible = false;
    }
    o.frustumCulled = true;
  });
  scene.add(gltf.scene);
  resize();
  const s = SPAWNS.Entry;
  setPose(s.x, s.y, s.yaw, -3);
  current = 'Entry'; markRoom();
  $('progress').style.display = 'none';
  // Make everything ready to draw before the first frame.
  renderer.compile(scene, camera);
  requestAnimationFrame(frame);
}

main().catch((e) => { console.error(e); showFallback(); });

// A small read-only window for testing (position, room, how long a frame takes).
window.__walk = {
  pose: () => ({ x: P.x, y: P.y, h: P.h, p: P.p, room: current }),
  goto: gotoRoom,
  setPose,
  rects: () => RECTS,
  stats: () => ({ calls: renderer.info.render.calls, tris: renderer.info.render.triangles }),
};
