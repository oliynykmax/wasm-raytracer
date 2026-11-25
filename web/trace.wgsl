// GPU port of src/lib.rs: one invocation per pixel traces `spp` paths, then
// reprojects last frame's history to this camera and blends (same scheme as the
// CPU compositor in main.js).

struct Obj { a: vec4f, b: vec4f, c: vec4f, d: vec4f }
// a: kind, cx, cy, cz   b: sx, sy, sz, mat   c: r, g, b, rough   d: ior, emit, -, -

struct U {
  eye: vec4f, fwd: vec4f, right: vec4f, up: vec4f,     // eye.w = tan(fov/2), fwd.w = aspect
  peye: vec4f, pfwd: vec4f, pright: vec4f, pup: vec4f, // previous camera, same packing
  sun: vec4f, sunCol: vec4f, zenith: vec4f, horizon: vec4f, ground: vec4f, glow: vec4f, // sun.w = stars
  dims: vec4u,  // w, h, prev w, prev h
  misc: vec4u,  // frame, spp, object count, light count
  flags: vec4f, // has history, history cap, upscaled, exposure
}

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> objs: array<Obj>;
@group(0) @binding(2) var<storage, read> lights: array<u32>;
@group(0) @binding(3) var<storage, read> histIn: array<vec4f>;
@group(0) @binding(4) var<storage, read> posIn: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> histOut: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> posOut: array<vec4f>;

const EPS: f32 = 1e-3;
const PI: f32 = 3.14159265;
const MAX_DEPTH: i32 = 7;
const DIFFUSE: u32 = 0u;
const METAL: u32 = 1u;
const GLASS: u32 = 2u;
const EMIT: u32 = 3u;
const GLOSSY: u32 = 4u;

var<private> seed: u32;
var<private> firstHit: vec4f;

fn rnd() -> f32 {
  seed = seed * 747796405u + 2891336453u;
  var w = ((seed >> ((seed >> 28u) + 4u)) ^ seed) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w >> 8u) * (1.0 / 16777216.0);
}

fn hashu(x: u32) -> u32 {
  var h = x;
  h ^= h >> 16u; h *= 0x7feb352du; h ^= h >> 15u; h *= 0x846ca68bu; h ^= h >> 16u;
  return h;
}

fn safeInv(d: vec3f) -> vec3f {
  let s = select(vec3f(1.0), vec3f(-1.0), d < vec3f(0.0));
  return 1.0 / select(d, s * 1e-8, abs(d) < vec3f(1e-8));
}

// Returns (t, normal) or t < 0 on a miss.
fn hitObj(i: u32, ro: vec3f, rd: vec3f, inv: vec3f, tmax: f32) -> vec4f {
  let o = objs[i];
  let c = o.a.yzw;
  if (o.a.x < 0.5) {
    let r = o.b.x;
    let oc = ro - c;
    let b = dot(oc, rd);
    let disc = b * b - (dot(oc, oc) - r * r);
    if (disc < 0.0) { return vec4f(-1.0); }
    let sq = sqrt(disc);
    var t = -b - sq;
    if (t < EPS) { t = -b + sq; }
    if (t < EPS || t > tmax) { return vec4f(-1.0); }
    return vec4f(t, (ro + rd * t - c) / r);
  }
  let s = o.b.xyz;
  let t1 = (c - s - ro) * inv;
  let t2 = (c + s - ro) * inv;
  let mn = min(t1, t2);
  let mx = max(t1, t2);
  let tn = max(max(mn.x, mn.y), mn.z);
  let tf = min(min(mx.x, mx.y), mx.z);
  if (tf < tn || tf < EPS) { return vec4f(-1.0); }
  let t = select(tf, tn, tn > EPS);
  if (t > tmax) { return vec4f(-1.0); }
  let q = (ro + rd * t - c) / s;
  let aq = abs(q);
  var n = vec3f(0.0, 0.0, sign(q.z));
  if (aq.x > aq.y && aq.x > aq.z) { n = vec3f(sign(q.x), 0.0, 0.0); }
  else if (aq.y > aq.z) { n = vec3f(0.0, sign(q.y), 0.0); }
  return vec4f(t, n);
}

struct Hit { t: f32, n: vec3f, id: i32 }

fn intersect(ro: vec3f, rd: vec3f) -> Hit {
  var h = Hit(1e30, vec3f(0.0, 1.0, 0.0), -2);
  if (abs(rd.y) > 1e-7) {
    let t = -ro.y / rd.y;
    if (t > EPS && t < 400.0) {
      h.t = t; h.id = -1;
      h.n = vec3f(0.0, select(-1.0, 1.0, ro.y >= 0.0), 0.0);
    }
  }
  let inv = safeInv(rd);
  for (var i = 0u; i < u.misc.z; i++) {
    let r = hitObj(i, ro, rd, inv, h.t);
    if (r.x > 0.0) { h.t = r.x; h.n = r.yzw; h.id = i32(i); }
  }
  return h;
}

// Transmittance along a shadow ray; glass tints instead of blocking.
fn occlusion(ro: vec3f, rd: vec3f, tmax: f32, skip: i32) -> vec3f {
  if (rd.y < 0.0 && ro.y > 0.0 && -ro.y / rd.y < tmax) { return vec3f(0.0); }
  var tr = vec3f(1.0);
  let inv = safeInv(rd);
  for (var i = 0u; i < u.misc.z; i++) {
    if (i32(i) == skip) { continue; }
    if (hitObj(i, ro, rd, inv, tmax).x > 0.0) {
      let o = objs[i];
      if (u32(o.b.w) == GLASS) { tr *= o.c.xyz * 0.85; } else { return vec3f(0.0); }
    }
  }
  return tr;
}

fn hash3(x: i32, y: i32, z: i32) -> u32 {
  var h = (u32(x) * 73856093u) ^ (u32(y) * 19349663u) ^ (u32(z) * 83492791u);
  h ^= h >> 13u;
  h *= 0x5bd1e995u;
  return h ^ (h >> 15u);
}

fn sky(d: vec3f, specular: bool) -> vec3f {
  var c: vec3f;
  if (d.y > 0.0) {
    let t = sqrt(d.y);
    c = mix(u.horizon.xyz, u.zenith.xyz, t);
  } else {
    c = mix(u.horizon.xyz, u.ground.xyz, min(-d.y * 6.0, 1.0));
  }
  let sd = max(dot(d, u.sun.xyz), 0.0);
  c += u.glow.xyz * (pow(sd, 16.0) * 0.6 + pow(sd, 256.0) * 2.0);
  if (specular && sd > 0.9993) { c += u.sunCol.xyz * 220.0; }
  if (u.sun.w > 0.0 && d.y > 0.02) {
    let q = 420.0;
    let h = hash3(i32(d.x * q), i32(d.y * q), i32(d.z * q));
    if (h % 1000u < 2u) {
      let b = (h >> 10u) % 100u;
      c += vec3f(0.8, 0.85, 1.0) * (0.5 + f32(b) * 0.04);
    }
  }
  return c;
}

fn onb(n: vec3f) -> mat2x3f {
  let s = select(-1.0, 1.0, n.z >= 0.0);
  let a = -1.0 / (s + n.z);
  let b = n.x * n.y * a;
  return mat2x3f(vec3f(1.0 + s * n.x * n.x * a, s * b, -s * n.x), vec3f(b, s + n.y * n.y * a, -n.y));
}

fn cosineDir(n: vec3f) -> vec3f {
  let u1 = rnd();
  let phi = 2.0 * PI * rnd();
  let r = sqrt(u1);
  let tb = onb(n);
  return normalize(tb[0] * (r * cos(phi)) + tb[1] * (r * sin(phi)) + n * sqrt(max(0.0, 1.0 - u1)));
}

fn inSphere() -> vec3f {
  for (var i = 0; i < 8; i++) {
    let p = vec3f(rnd(), rnd(), rnd()) * 2.0 - 1.0;
    if (dot(p, p) < 1.0) { return p; }
  }
  return vec3f(0.0);
}

// Next-event estimation: sun plus one random spherical light.
fn direct(p: vec3f, n: vec3f) -> vec3f {
  var c = vec3f(0.0);
  let tb = onb(u.sun.xyz);
  let a = 0.025 * sqrt(rnd());
  let ph = 2.0 * PI * rnd();
  let sd = normalize(u.sun.xyz + tb[0] * (a * cos(ph)) + tb[1] * (a * sin(ph)));
  let cs = dot(n, sd);
  if (cs > 0.0) { c += u.sunCol.xyz * occlusion(p, sd, 1e30, -2) * cs; }
  let nl = u.misc.w;
  if (nl > 0u) {
    let li = lights[min(u32(rnd() * f32(nl)), nl - 1u)];
    let l = objs[li];
    let to = l.a.yzw - p;
    let d2 = dot(to, to);
    let rad = l.b.x;
    if (d2 > rad * rad * 1.0001) {
      let dist = sqrt(d2);
      let w = to / dist;
      let cosMax = sqrt(max(0.0, 1.0 - rad * rad / d2));
      let ct = 1.0 - rnd() * (1.0 - cosMax);
      let st = sqrt(max(0.0, 1.0 - ct * ct));
      let lph = 2.0 * PI * rnd();
      let lb = onb(w);
      let dir = normalize(lb[0] * (st * cos(lph)) + lb[1] * (st * sin(lph)) + w * ct);
      let cn = dot(n, dir);
      if (cn > 0.0) {
        let tr = occlusion(p, dir, dist - rad, i32(li));
        c += l.c.xyz * l.d.y * tr * (cn * 2.0 * (1.0 - cosMax) * f32(nl));
      }
    }
  }
  return c;
}

fn reflectV(d: vec3f, n: vec3f) -> vec3f { return d - n * (2.0 * dot(d, n)); }

fn trace(roIn: vec3f, rdIn: vec3f, record: bool) -> vec3f {
  var ro = roIn;
  var rd = rdIn;
  var thr = vec3f(1.0);
  var col = vec3f(0.0);
  var specular = true;
  if (record) { firstHit = vec4f(rd, 0.0); }
  for (var depth = 0; depth < MAX_DEPTH; depth++) {
    let h = intersect(ro, rd);
    if (h.id == -2) { col += thr * sky(rd, specular); break; }
    let p = ro + rd * h.t;
    if (record && depth == 0) { firstHit = vec4f(p, 1.0); }
    let front = dot(rd, h.n) < 0.0;
    let nl = select(-h.n, h.n, front);
    var alb: vec3f; var mat: u32; var rough: f32; var ior = 1.5; var emit = 0.0; var isLight = false;
    if (h.id == -1) {
      let fx = p.x - floor(p.x);
      let fz = p.z - floor(p.z);
      let seam = fx < 0.02 || fz < 0.02 || fx > 0.98 || fz > 0.98;
      let check = ((i32(floor(p.x)) + i32(floor(p.z))) & 1) == 0;
      alb = select(select(vec3f(0.03, 0.035, 0.04), vec3f(0.55, 0.55, 0.58), check), vec3f(0.02), seam);
      mat = GLOSSY; rough = 0.03;
    } else {
      let o = objs[u32(h.id)];
      alb = o.c.xyz; mat = u32(o.b.w); rough = o.c.w;
      ior = select(1.5, o.d.x, o.d.x > 0.0); emit = o.d.y; isLight = o.a.x < 0.5;
    }
    if (mat == EMIT) {
      if (specular || !isLight) { col += thr * alb * emit; }
      break;
    } else if (mat == METAL) {
      var d = reflectV(rd, nl);
      if (rough > 0.0) {
        d = normalize(d + inSphere() * rough);
        if (dot(d, nl) <= 0.0) { d = reflectV(rd, nl); }
      }
      let f = pow(max(1.0 + dot(rd, nl), 0.0), 5.0);
      thr *= alb * (1.0 - f) + vec3f(f);
      rd = d; ro = p + nl * EPS; specular = true;
    } else if (mat == GLASS) {
      let cosi = min(-dot(rd, nl), 1.0);
      let eta = select(ior, 1.0 / ior, front);
      let k = 1.0 - eta * eta * (1.0 - cosi * cosi);
      let r0 = pow((1.0 - ior) / (1.0 + ior), 2.0);
      let f = select(r0 + (1.0 - r0) * pow(1.0 - cosi, 5.0), 1.0, k < 0.0);
      if (rnd() < f) {
        rd = reflectV(rd, nl); ro = p + nl * EPS;
      } else {
        rd = normalize(rd * eta + nl * (eta * cosi - sqrt(k)));
        ro = p - nl * EPS;
        if (front) { thr *= alb; }
      }
      specular = true;
    } else {
      var coat = false;
      if (mat == GLOSSY) {
        let c = max(-dot(rd, nl), 0.0);
        coat = rnd() < max(0.04 + 0.96 * pow(1.0 - c, 5.0), 0.12);
      }
      ro = p + nl * EPS;
      if (coat) {
        var d = reflectV(rd, nl);
        if (rough > 0.0) {
          d = normalize(d + inSphere() * rough);
          if (dot(d, nl) <= 0.0) { d = reflectV(rd, nl); }
        }
        rd = d; specular = true;
      } else {
        col += thr * alb * direct(ro, nl);
        thr *= alb;
        rd = cosineDir(nl);
        specular = false;
      }
    }
    if (depth >= 3) {
      let pr = clamp(max(max(thr.x, thr.y), thr.z), 0.05, 0.95);
      if (rnd() > pr) { break; }
      thr /= pr;
    }
  }
  let m = max(max(col.x, col.y), col.z);
  if (m > 24.0) { col *= 24.0 / m; }
  return col;
}

@compute @workgroup_size(8, 8)
fn cs_main(@builtin(global_invocation_id) gid: vec3u) {
  let w = u.dims.x;
  let h = u.dims.y;
  if (gid.x >= w || gid.y >= h) { return; }
  let idx = gid.y * w + gid.x;
  seed = hashu(idx ^ hashu(u.misc.x * 0x9e3779b9u + 17u));
  let th = u.eye.w;
  let aspect = u.fwd.w;
  let spp = u.misc.y;
  var col = vec3f(0.0);
  var first = vec4f(0.0);
  for (var s = 0u; s < spp; s++) {
    let sx = ((f32(gid.x) + rnd()) / f32(w) * 2.0 - 1.0) * th * aspect;
    let sy = (1.0 - (f32(gid.y) + rnd()) / f32(h) * 2.0) * th;
    let rd = normalize(u.fwd.xyz + u.right.xyz * sx + u.up.xyz * sy);
    col += trace(u.eye.xyz, rd, s == 0u);
    if (s == 0u) { first = firstHit; }
  }
  col /= f32(spp);

  // Reproject into the previous frame and blend with the history found there.
  var prevN = 0.0;
  var hcol = vec3f(0.0);
  if (u.flags.x > 0.5) {
    var d = first.xyz;
    if (first.w > 0.5) { d = first.xyz - u.peye.xyz; }
    let z = dot(d, u.pfwd.xyz);
    if (z > 1e-4) {
      let sx = dot(d, u.pright.xyz) / z / (u.peye.w * u.pfwd.w);
      let sy = dot(d, u.pup.xyz) / z / u.peye.w;
      let qx = floor((sx + 1.0) * 0.5 * f32(u.dims.z));
      let qy = floor((1.0 - sy) * 0.5 * f32(u.dims.w));
      if (qx >= 0.0 && qy >= 0.0 && qx < f32(u.dims.z) && qy < f32(u.dims.w)) {
        let j = u32(qy) * u.dims.z + u32(qx);
        let hp = posIn[j];
        let hc = histIn[j];
        if (first.w > 0.5) {
          if (hp.w > 0.5) {
            let dd = hp.xyz - first.xyz;
            let vv = first.xyz - u.eye.xyz;
            if (dot(dd, dd) < 0.035 * 0.035 * dot(vv, vv) + 1e-4) { prevN = hc.w; hcol = hc.xyz; }
          }
        } else if (hp.w < 0.5) { prevN = hc.w; hcol = hc.xyz; }
      }
    }
  }
  if (u.flags.z > 0.5) { prevN = min(prevN, 2.0); }
  let fs = f32(spp);
  var outc = col;
  var outn = fs;
  if (prevN > 0.0) {
    let k = max(min(prevN + fs, u.flags.y), fs);
    outc = hcol + (col - hcol) * (fs / k);
    outn = k;
  }
  histOut[idx] = vec4f(outc, outn);
  posOut[idx] = first;
}
