// Host side: input, scene editing, worker pool and compositing.
// All pixels come from the Rust path tracer compiled to WebAssembly.

const SPHERE = 0, BOX = 1;
const DIFFUSE = 0, METAL = 1, GLASS = 2, EMIT = 3, GLOSSY = 4;
const FLOOR = -1, NONE = -2;
const STRIDE = 16;
const SKY_NAMES = ['Sunset', 'Night', 'Day'];

const ITEMS = [
  { name: 'Mirror Orb', k: SPHERE, s: 0.5, c: [0.95, 0.95, 0.97], m: METAL, rough: 0 },
  { name: 'Glass Orb', k: SPHERE, s: 0.5, c: [1, 1, 1], m: GLASS, ior: 1.5 },
  { name: 'Gold Orb', k: SPHERE, s: 0.5, c: [1.0, 0.76, 0.33], m: METAL, rough: 0.08 },
  { name: 'Ruby Glass Block', k: BOX, s: 0.5, c: [1.0, 0.3, 0.38], m: GLASS, ior: 1.6 },
  { name: 'Chrome Block', k: BOX, s: 0.5, c: [0.9, 0.9, 0.92], m: METAL, rough: 0.02 },
  { name: 'Light Orb', k: SPHERE, s: 0.3, c: [1.0, 0.72, 0.42], m: EMIT, e: 8 },
  { name: 'Neon Block', k: BOX, s: 0.5, c: [0.15, 0.85, 1.0], m: EMIT, e: 2.5 },
  { name: 'Marble Block', k: BOX, s: 0.5, c: [0.86, 0.85, 0.82], m: GLOSSY, rough: 0.04 },
  { name: 'Clay Ball', k: SPHERE, s: 0.5, c: [0.85, 0.28, 0.12], m: DIFFUSE },
];

function obj(k, p, s, c, m, extra = {}) {
  return { k, p, s: Array.isArray(s) ? s : [s, s, s], c, m, rough: extra.rough ?? 0, ior: extra.ior ?? 1.5, e: extra.e ?? 0 };
}
function fromItem(it, p) {
  return obj(it.k, p, it.s, it.c, it.m, it);
}
function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12;
    return l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function defaultScene() {
  const o = [];
  // Centrepiece: a huge perfect mirror.
  o.push(obj(SPHERE, [0, 2, 0], 2, [0.96, 0.96, 0.98], METAL));
  o.push(obj(SPHERE, [3.2, 1.1, 4.0], 1.1, [1, 1, 1], GLASS, { ior: 1.5 }));
  o.push(obj(SPHERE, [-4.2, 1.0, 3.4], 1.0, [1.0, 0.76, 0.33], METAL, { rough: 0.05 }));
  o.push(obj(SPHERE, [5.6, 0.8, -1.4], 0.8, [0.95, 0.55, 0.35], METAL, { rough: 0.28 }));
  o.push(obj(SPHERE, [-1.6, 0.5, 5.6], 0.5, [0.8, 0.08, 0.1], DIFFUSE));
  o.push(obj(SPHERE, [-5.6, 0.7, -1.2], 0.7, [0.3, 0.6, 1.0], GLASS, { ior: 1.45 }));
  // Rainbow ring of tiny orbs around the mirror.
  const ringN = 16;
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * Math.PI * 2 + 0.1;
    const col = hsl(i / ringN, 0.85, 0.55);
    const m = i % 3 === 0 ? GLASS : i % 3 === 1 ? METAL : GLOSSY;
    o.push(obj(SPHERE, [Math.cos(a) * 3.5, 0.32, Math.sin(a) * 3.5], 0.32, m === GLASS ? col.map((x) => 0.5 + x * 0.5) : col, m, { rough: 0.05 }));
  }
  // Coloured light orbs.
  o.push(obj(SPHERE, [-2.6, 3.6, -1.2], 0.38, [0.2, 0.75, 1.0], EMIT, { e: 3.5 }));
  o.push(obj(SPHERE, [2.9, 3.1, -0.6], 0.34, [1.0, 0.2, 0.75], EMIT, { e: 4 }));
  o.push(obj(SPHERE, [1.6, 0.3, 2.45], 0.28, [1.0, 0.7, 0.35], EMIT, { e: 4 }));
  // Ziggurat of chrome and glass blocks topped with a neon cube.
  for (let x = 0; x < 3; x++) for (let z = 0; z < 3; z++) {
    if (x === 1 && z === 1) continue;
    const corner = (x + z) % 2 === 0;
    o.push(obj(BOX, [x - 1.5, 0.5, z - 8.5], 0.5, corner ? [0.92, 0.92, 0.95] : [0.55, 0.95, 0.9], corner ? METAL : GLASS, { rough: 0.01 }));
  }
  o.push(obj(BOX, [-0.5, 0.5, -7.5], 0.5, [0.86, 0.85, 0.82], GLOSSY));
  o.push(obj(BOX, [-0.5, 1.5, -7.5], 0.5, [0.92, 0.92, 0.95], METAL, { rough: 0.0 }));
  o.push(obj(BOX, [-0.5, 2.5, -7.5], 0.5, [1.0, 0.25, 0.7], EMIT, { e: 4 }));
  // Neon pillars.
  o.push(obj(BOX, [-6.5, 1.75, -5], [0.12, 1.75, 0.12], [0.1, 0.8, 1.0], EMIT, { e: 5 }));
  o.push(obj(BOX, [6.5, 1.75, -5], [0.12, 1.75, 0.12], [1.0, 0.15, 0.6], EMIT, { e: 5 }));
  // Two facing mirror walls: an infinite corridor of reflections.
  o.push(obj(BOX, [-9.5, 2.6, -2], [0.1, 2.6, 5], [0.9, 0.92, 0.95], METAL));
  o.push(obj(BOX, [9.5, 2.6, -2], [0.1, 2.6, 5], [0.9, 0.92, 0.95], METAL));
  return o;
}

function packScene(objs) {
  const f = new Float32Array(objs.length * STRIDE);
  objs.forEach((o, i) => {
    f.set([o.k, ...o.p, ...o.s, ...o.c, o.m, o.rough, o.ior, o.e], i * STRIDE);
  });
  return f;
}

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const canvas = $('view');
const ctx = canvas.getContext('2d');
const overlay = $('overlay');
const octx = overlay.getContext('2d');
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
document.body.classList.toggle('touch', isTouch);

// ---------- State ----------
const cam = { p: [0, 2.3, 10.5], yaw: 0, pitch: -0.12, fov: 70 * Math.PI / 180 };
let scene = defaultScene();
let sceneVersion = 1;
let selected = 0;
let skyMode = 0;
let exposure = 0.85;
const keys = new Set();
const joy = { x: 0, y: 0 };
const vert = { up: false, down: false };

// ---------- WebAssembly ----------
const res = await fetch('raytracer.wasm');
const bytes = await res.arrayBuffer();
const { instance } = await WebAssembly.instantiate(bytes, {});
const W = instance.exports;
const MAX_OBJ = W.max_objects();

function uploadMain(packed, count) {
  new Float32Array(W.memory.buffer, W.scene_ptr(), packed.length).set(packed);
  W.set_scene(count);
}

const hashBuf = await crypto.subtle.digest('SHA-256', bytes);
const hash = [...new Uint8Array(hashBuf)].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------- Hotbar with icons rendered by the same wasm ----------
const hotbar = $('hotbar');
function renderIcon(it) {
  const size = 64;
  const packed = packScene([fromItem(it, [0, it.s, 0])]);
  uploadMain(packed, 1);
  const eye = [1.25, 1.1, 1.45];
  const d = [0 - eye[0], it.s - eye[1], 0 - eye[2]];
  const len = Math.hypot(...d);
  const yaw = Math.atan2(d[0], -d[2]);
  const pitch = Math.asin(d[1] / len);
  let ptr = 0;
  for (let f = 0; f < 48; f++) {
    ptr = W.render(size, size, 0, 1, f, 0, eye[0], eye[1], eye[2], yaw, pitch, 0.75, 0, 1.2);
  }
  const img = new ImageData(new Uint8ClampedArray(W.memory.buffer, ptr, size * size * 4).slice(), size, size);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').putImageData(img, 0, 0);
  return c;
}
ITEMS.forEach((it, i) => {
  const slot = document.createElement('button');
  slot.className = 'slot';
  slot.setAttribute('aria-label', it.name);
  slot.appendChild(renderIcon(it));
  const n = document.createElement('span');
  n.className = 'num';
  n.textContent = i + 1;
  slot.appendChild(n);
  slot.addEventListener('pointerdown', (e) => { e.stopPropagation(); select(i); });
  hotbar.appendChild(slot);
});
let nameTimer;
function select(i) {
  selected = (i + ITEMS.length) % ITEMS.length;
  [...hotbar.children].forEach((s, j) => s.classList.toggle('sel', j === selected));
  const label = $('itemname');
  label.textContent = ITEMS[selected].name;
  label.classList.add('show');
  clearTimeout(nameTimer);
  nameTimer = setTimeout(() => label.classList.remove('show'), 1500);
}
select(0);

function markDirty() {
  sceneVersion++;
  uploadMain(packScene(scene), scene.length);
  resetAccum();
}

// ---------- Camera helpers ----------
function basis() {
  const cp = Math.cos(cam.pitch);
  const fwd = [cp * Math.sin(cam.yaw), Math.sin(cam.pitch), -cp * Math.cos(cam.yaw)];
  let right = [-fwd[2], 0, fwd[0]];
  const rl = Math.hypot(...right) || 1;
  right = right.map((x) => x / rl);
  const up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2], right[0] * fwd[1] - right[1] * fwd[0]];
  return { fwd, right, up };
}

function target() {
  const { fwd } = basis();
  const id = W.pick(cam.p[0], cam.p[1], cam.p[2], fwd[0], fwd[1], fwd[2]);
  const r = new Float32Array(W.memory.buffer, W.pick_ptr(), 8);
  if (id === NONE || r[0] > 40) return null;
  const hp = [r[1], r[2], r[3]];
  const n = [r[4], r[5], r[6]];
  const cell = hp.map((x, i) => Math.floor(x + n[i] * 0.5) + 0.5);
  return { id, hp, n, cell };
}

function place() {
  const t = target();
  if (!t || scene.length >= MAX_OBJ) return;
  const it = ITEMS[selected];
  const p = [...t.cell];
  if (it.k === SPHERE && it.s < 0.5) p[1] = t.cell[1] - 0.5 + it.s; // small orbs rest on the surface
  if (scene.some((o) => Math.abs(o.p[0] - p[0]) < 0.01 && Math.abs(o.p[1] - p[1]) < 0.01 && Math.abs(o.p[2] - p[2]) < 0.01)) return;
  scene.push(fromItem(it, p));
  markDirty();
}
function breakTarget() {
  const t = target();
  if (!t || t.id < 0) return;
  scene.splice(t.id, 1);
  markDirty();
}

// ---------- Workers ----------
const N = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16));
const workers = [];
await Promise.all(Array.from({ length: N }, () => new Promise((ok) => {
  const w = new Worker('worker.js');
  w.sent = 0;
  w.onmessage = (e) => { if (e.data.type === 'ready') { w.onmessage = onRows; ok(); } };
  w.postMessage({ type: 'init', bytes: bytes.slice(0) });
  workers.push(w);
})));

let frame = 0, inflight = 0, frameId = 0, img = null, rw = 0, rh = 0;
let moveScale = isTouch ? 0.3 : 0.4;
let lastMove = 0, still = false, lastDispatch = 0, lastFrameMs = 0;
let samplesWindow = 0, fpsWindow = 0, statT = performance.now(), pathsPerSec = 0, fps = 0;
const maxSpp = 4096;

function resetAccum() { frame = 0; }

function onRows(e) {
  const m = e.data;
  if (m.id !== frameId || !img) { inflight--; maybeDispatch(); return; }
  const rowBytes = rw * 4;
  const dst = img.data;
  for (let i = 0, y = m.row0; y < rh; i++, y += m.step) {
    dst.set(m.px.subarray(i * rowBytes, (i + 1) * rowBytes), y * rowBytes);
  }
  inflight--;
  if (inflight === 0) {
    ctx.putImageData(img, 0, 0);
    lastFrameMs = performance.now() - lastDispatch;
    samplesWindow += rw * rh;
    fpsWindow++;
    frame++;
    adapt();
  }
}

function adapt() {
  if (still) return;
  if (lastFrameMs > 45) moveScale = Math.max(0.12, moveScale * 0.88);
  else if (lastFrameMs < 28) moveScale = Math.min(0.75, moveScale * 1.06);
}

function wantedSize() {
  const cw = innerWidth, ch = innerHeight;
  let s = still ? 1 : moveScale;
  const maxPx = still ? 1.4e6 : 6e5;
  if (cw * ch * s * s > maxPx) s = Math.sqrt(maxPx / (cw * ch));
  return [Math.max(32, Math.round(cw * s)), Math.max(24, Math.round(ch * s))];
}

let sentVersion = new Map();
function maybeDispatch() {
  if (inflight > 0) return;
  if (still && frame >= maxSpp) return;
  const [w, h] = wantedSize();
  if (w !== rw || h !== rh) {
    rw = w; rh = h;
    canvas.width = w; canvas.height = h;
    img = new ImageData(w, h);
    resetAccum();
  }
  frameId++;
  lastDispatch = performance.now();
  const blend = still ? 0 : 0.55;
  const packed = workers.some((wk) => sentVersion.get(wk) !== sceneVersion) ? packScene(scene) : null;
  workers.forEach((wk, i) => {
    const msg = {
      type: 'frame', id: frameId, w, h, row0: i, step: N, frame, blend, sky: skyMode, exposure,
      cam: [cam.p[0], cam.p[1], cam.p[2], cam.yaw, cam.pitch, cam.fov],
    };
    if (sentVersion.get(wk) !== sceneVersion) {
      msg.scene = packed; msg.count = scene.length;
      sentVersion.set(wk, sceneVersion);
    }
    inflight++;
    wk.postMessage(msg);
  });
}

// ---------- Input ----------
let started = false;
const startEl = $('start');
function start() {
  started = true;
  startEl.classList.add('hidden');
  if (!isTouch && canvas.requestPointerLock) canvas.requestPointerLock();
}
startEl.addEventListener('click', start);
document.addEventListener('pointerlockchange', () => {
  if (!isTouch && document.pointerLockElement !== canvas) startEl.classList.remove('hidden');
});

addEventListener('keydown', (e) => {
  if (e.repeat && !/^Key[WASD]|Arrow|Space|Shift/.test(e.code)) return;
  keys.add(e.code);
  if (/^Digit[1-9]$/.test(e.code)) select(+e.code.slice(5) - 1);
  if (e.code === 'KeyT') { skyMode = (skyMode + 1) % 3; resetAccum(); toast(SKY_NAMES[skyMode]); }
  if (e.code === 'KeyH') $('hud').classList.toggle('hidden');
  if (e.code === 'KeyR') { scene = defaultScene(); markDirty(); toast('Scene reset'); }
  if (e.code === 'KeyQ') breakTarget();
  if (e.code === 'KeyE') place();
  if (e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (isTouch || document.pointerLockElement !== canvas) return;
  if (e.button === 0) place();
  if (e.button === 2) breakTarget();
});
addEventListener('mousemove', (e) => {
  if (document.pointerLockElement !== canvas) return;
  look(e.movementX, e.movementY, 0.0022);
});
addEventListener('wheel', (e) => { if (started) select(selected + Math.sign(e.deltaY)); }, { passive: true });

function look(dx, dy, k) {
  cam.yaw += dx * k;
  cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - dy * k));
  lastMove = performance.now();
}

// Touch: left-half joystick, drag elsewhere to look.
const touches = new Map();
const stick = $('stick'), knob = $('knob');
canvas.addEventListener('touchstart', (e) => {
  e.preventDefault();
  if (!started) start();
  for (const t of e.changedTouches) {
    const isJoy = t.clientX < innerWidth * 0.4 && t.clientY > innerHeight * 0.35;
    touches.set(t.identifier, { x: t.clientX, y: t.clientY, ox: t.clientX, oy: t.clientY, joy: isJoy && ![...touches.values()].some((v) => v.joy) });
    if (touches.get(t.identifier).joy) {
      stick.style.left = t.clientX + 'px'; stick.style.top = t.clientY + 'px';
      stick.classList.add('on');
    }
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    const s = touches.get(t.identifier);
    if (!s) continue;
    if (s.joy) {
      let dx = t.clientX - s.ox, dy = t.clientY - s.oy;
      const l = Math.hypot(dx, dy), R = 50;
      if (l > R) { dx *= R / l; dy *= R / l; }
      joy.x = dx / R; joy.y = dy / R;
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
    } else {
      look(t.clientX - s.x, t.clientY - s.y, 0.005);
    }
    s.x = t.clientX; s.y = t.clientY;
  }
}, { passive: false });
const endTouch = (e) => {
  for (const t of e.changedTouches) {
    const s = touches.get(t.identifier);
    if (s?.joy) { joy.x = joy.y = 0; knob.style.transform = ''; stick.classList.remove('on'); }
    touches.delete(t.identifier);
  }
};
canvas.addEventListener('touchend', endTouch);
canvas.addEventListener('touchcancel', endTouch);

const hold = (id, on, off) => {
  const el = $(id);
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); on(); });
  if (off) ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => el.addEventListener(ev, off));
};
hold('btn-place', place);
hold('btn-break', breakTarget);
hold('btn-up', () => (vert.up = true), () => (vert.up = false));
hold('btn-down', () => (vert.down = true), () => (vert.down = false));
hold('btn-sky', () => { skyMode = (skyMode + 1) % 3; resetAccum(); toast(SKY_NAMES[skyMode]); });
hold('btn-reset', () => { scene = defaultScene(); markDirty(); toast('Scene reset'); });

let toastTimer;
function toast(t) {
  const el = $('toast');
  el.textContent = t; el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1200);
}

// ---------- Ghost outline of the targeted cell ----------
function project(q, b, aspect, th) {
  const d = [q[0] - cam.p[0], q[1] - cam.p[1], q[2] - cam.p[2]];
  const z = d[0] * b.fwd[0] + d[1] * b.fwd[1] + d[2] * b.fwd[2];
  if (z < 0.05) return null;
  const sx = (d[0] * b.right[0] + d[1] * b.right[1] + d[2] * b.right[2]) / (z * th * aspect);
  const sy = (d[0] * b.up[0] + d[1] * b.up[1] + d[2] * b.up[2]) / (z * th);
  return [(sx + 1) / 2 * overlay.width, (1 - sy) / 2 * overlay.height];
}
function drawGhost() {
  const dpr = devicePixelRatio || 1;
  const ow = Math.round(innerWidth * dpr), oh = Math.round(innerHeight * dpr);
  if (overlay.width !== ow || overlay.height !== oh) { overlay.width = ow; overlay.height = oh; }
  octx.clearRect(0, 0, ow, oh);
  if (!started) return;
  const t = target();
  if (!t) return;
  const b = basis();
  const th = Math.tan(cam.fov / 2), aspect = ow / oh;
  const o = t.id >= 0 && breakHint() ? scene[t.id] : null;
  const c = o ? o.p : t.cell;
  const s = o ? o.s : [0.5, 0.5, 0.5];
  const pts = [];
  for (let i = 0; i < 8; i++) {
    pts.push(project([c[0] + (i & 1 ? s[0] : -s[0]), c[1] + (i & 2 ? s[1] : -s[1]), c[2] + (i & 4 ? s[2] : -s[2])], b, aspect, th));
  }
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  octx.lineWidth = 2 * dpr;
  octx.strokeStyle = o ? 'rgba(255,90,90,0.9)' : 'rgba(255,255,255,0.75)';
  octx.beginPath();
  for (const [a, z] of edges) {
    if (!pts[a] || !pts[z]) continue;
    octx.moveTo(...pts[a]); octx.lineTo(...pts[z]);
  }
  octx.stroke();
}
const breakHint = () => keys.has('KeyQ') || keys.has('AltLeft');

// ---------- HUD ----------
const ua = navigator.userAgent;
const browser = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /CriOS|Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
const os = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'macOS' : /Win/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown OS';
let arch = '';
navigator.userAgentData?.getHighEntropyValues?.(['architecture', 'bitness']).then((v) => {
  if (v.architecture) arch = `${v.architecture}${v.bitness ? '-' + v.bitness : ''}`;
}).catch(() => {});
$('device').textContent = `${browser} · ${os}`;
$('hash').textContent = hash.slice(0, 16);
$('hash').title = `SHA-256 of raytracer.wasm (${bytes.byteLength.toLocaleString()} bytes): ${hash}`;
$('size').textContent = `${(bytes.byteLength / 1024).toFixed(0)} KB`;

function updateStats(now) {
  if (now - statT < 500) return;
  const dt = (now - statT) / 1000;
  pathsPerSec = samplesWindow / dt;
  fps = fpsWindow / dt;
  samplesWindow = 0; fpsWindow = 0; statT = now;
  $('stats').textContent =
    `${fps.toFixed(1)} fps · ${(pathsPerSec / 1e6).toFixed(2)} M paths/s\n` +
    `${rw}×${rh} · ${still ? Math.min(frame, maxSpp) + ' spp' : 'moving'}\n` +
    `${N} workers${arch ? ' · ' + arch : ''} · ${scene.length} objects · ${SKY_NAMES[skyMode]}`;
}

// ---------- Main loop ----------
let prev = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  const flat = [Math.sin(cam.yaw), 0, -Math.cos(cam.yaw)];
  const right = [Math.cos(cam.yaw), 0, Math.sin(cam.yaw)];
  let f = 0, r = 0, u = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) r += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) r -= 1;
  if (keys.has('Space') || vert.up) u += 1;
  if (keys.has('ShiftLeft') || keys.has('ShiftRight') || keys.has('KeyC') || vert.down) u -= 1;
  f -= joy.y; r += joy.x;
  if (f || r || u) {
    const speed = (keys.has('ControlLeft') ? 12 : 4.5) * dt;
    for (let i = 0; i < 3; i++) cam.p[i] += (flat[i] * f + right[i] * r) * speed;
    cam.p[1] = Math.max(0.15, cam.p[1] + u * speed);
    lastMove = now;
  }
  const wasStill = still;
  still = now - lastMove > 220;
  if (still && !wasStill) resetAccum();
  maybeDispatch();
  drawGhost();
  updateStats(now);
  requestAnimationFrame(tick);
}
markDirty();
$('loading').remove();
requestAnimationFrame(tick);
