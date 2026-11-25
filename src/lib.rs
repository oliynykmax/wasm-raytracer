//! Progressive path tracer compiled to WebAssembly.
//! The host writes the scene into `scene_ptr()`, then calls `render` for a set of
//! interleaved rows. Every Web Worker owns its own instance, so rendering runs on
//! all cores without SharedArrayBuffer.
#![allow(static_mut_refs)]

use core::f32::consts::PI;
use core::ops::{Add, Mul, Neg, Sub};

#[derive(Clone, Copy, Default)]
struct V {
    x: f32,
    y: f32,
    z: f32,
}
const fn v(x: f32, y: f32, z: f32) -> V {
    V { x, y, z }
}
impl Add for V {
    type Output = V;
    fn add(self, o: V) -> V {
        v(self.x + o.x, self.y + o.y, self.z + o.z)
    }
}
impl Sub for V {
    type Output = V;
    fn sub(self, o: V) -> V {
        v(self.x - o.x, self.y - o.y, self.z - o.z)
    }
}
impl Mul<f32> for V {
    type Output = V;
    fn mul(self, s: f32) -> V {
        v(self.x * s, self.y * s, self.z * s)
    }
}
impl Mul<V> for V {
    type Output = V;
    fn mul(self, o: V) -> V {
        v(self.x * o.x, self.y * o.y, self.z * o.z)
    }
}
impl Neg for V {
    type Output = V;
    fn neg(self) -> V {
        v(-self.x, -self.y, -self.z)
    }
}
impl V {
    fn dot(self, o: V) -> f32 {
        self.x * o.x + self.y * o.y + self.z * o.z
    }
    fn cross(self, o: V) -> V {
        v(
            self.y * o.z - self.z * o.y,
            self.z * o.x - self.x * o.z,
            self.x * o.y - self.y * o.x,
        )
    }
    fn norm(self) -> V {
        self * (1.0 / self.dot(self).sqrt())
    }
    fn min(self, o: V) -> V {
        v(self.x.min(o.x), self.y.min(o.y), self.z.min(o.z))
    }
    fn max(self, o: V) -> V {
        v(self.x.max(o.x), self.y.max(o.y), self.z.max(o.z))
    }
    fn maxc(self) -> f32 {
        self.x.max(self.y).max(self.z)
    }
    fn axis(self, a: usize) -> f32 {
        match a {
            0 => self.x,
            1 => self.y,
            _ => self.z,
        }
    }
}

const SPHERE: u32 = 0;
#[allow(dead_code)]
const BOX: u32 = 1;

#[allow(dead_code)]
const DIFFUSE: u32 = 0;
const METAL: u32 = 1;
const GLASS: u32 = 2;
const EMIT: u32 = 3;
const GLOSSY: u32 = 4;

const MAX_OBJ: usize = 512;
const STRIDE: usize = 16;
const EPS: f32 = 1e-3;
const MAX_DEPTH: u32 = 7;

#[derive(Clone, Copy, Default)]
struct Obj {
    kind: u32,
    c: V,
    s: V,
    col: V,
    mat: u32,
    rough: f32,
    ior: f32,
    emit: f32,
    bmin: V,
    bmax: V,
}

#[derive(Clone, Copy, Default)]
struct Node {
    bmin: V,
    bmax: V,
    // Interior: index of left child (right is left + 1). Leaf: first item.
    first: u32,
    count: u32,
}

static mut SCENE: [f32; MAX_OBJ * STRIDE] = [0.0; MAX_OBJ * STRIDE];
static mut OBJS: Vec<Obj> = Vec::new();
static mut ORDER: Vec<u32> = Vec::new();
static mut NODES: Vec<Node> = Vec::new();
static mut LIGHTS: Vec<u32> = Vec::new();
static mut ACC: Vec<f32> = Vec::new();
static mut OUT: Vec<u8> = Vec::new();
static mut PICK: [f32; 8] = [0.0; 8];
static mut SKY: Sky = SKIES[0];

#[no_mangle]
pub extern "C" fn scene_ptr() -> *mut f32 {
    unsafe { SCENE.as_mut_ptr() }
}

#[no_mangle]
pub extern "C" fn max_objects() -> u32 {
    MAX_OBJ as u32
}

#[no_mangle]
pub extern "C" fn pick_ptr() -> *const f32 {
    unsafe { PICK.as_ptr() }
}

/// Parse `n` objects from the scene buffer and rebuild the BVH.
#[no_mangle]
pub extern "C" fn set_scene(n: u32) {
    unsafe {
        let n = (n as usize).min(MAX_OBJ);
        OBJS.clear();
        LIGHTS.clear();
        for i in 0..n {
            let f = &SCENE[i * STRIDE..(i + 1) * STRIDE];
            let kind = f[0] as u32;
            let c = v(f[1], f[2], f[3]);
            let s = if kind == SPHERE { v(f[4], f[4], f[4]) } else { v(f[4], f[5], f[6]) };
            let o = Obj {
                kind,
                c,
                s,
                col: v(f[7], f[8], f[9]),
                mat: f[10] as u32,
                rough: f[11],
                ior: if f[12] > 0.0 { f[12] } else { 1.5 },
                emit: f[13],
                bmin: c - s,
                bmax: c + s,
            };
            if o.mat == EMIT && o.kind == SPHERE {
                LIGHTS.push(i as u32);
            }
            OBJS.push(o);
        }
        build_bvh();
    }
}

unsafe fn build_bvh() {
    ORDER.clear();
    ORDER.extend(0..OBJS.len() as u32);
    NODES.clear();
    NODES.push(Node::default());
    if OBJS.is_empty() {
        NODES[0].bmin = v(1e30, 1e30, 1e30);
        NODES[0].bmax = v(-1e30, -1e30, -1e30);
        return;
    }
    build_node(0, 0, OBJS.len());
}

unsafe fn build_node(ni: usize, start: usize, end: usize) {
    let mut bmin = v(1e30, 1e30, 1e30);
    let mut bmax = v(-1e30, -1e30, -1e30);
    let mut cmin = bmin;
    let mut cmax = bmax;
    for &i in &ORDER[start..end] {
        let o = &OBJS[i as usize];
        bmin = bmin.min(o.bmin);
        bmax = bmax.max(o.bmax);
        cmin = cmin.min(o.c);
        cmax = cmax.max(o.c);
    }
    NODES[ni].bmin = bmin;
    NODES[ni].bmax = bmax;
    let count = end - start;
    if count <= 2 {
        NODES[ni].first = start as u32;
        NODES[ni].count = count as u32;
        return;
    }
    let ext = cmax - cmin;
    let axis = if ext.x > ext.y && ext.x > ext.z { 0 } else if ext.y > ext.z { 1 } else { 2 };
    ORDER[start..end].sort_unstable_by(|a, b| {
        let ca = OBJS[*a as usize].c.axis(axis);
        let cb = OBJS[*b as usize].c.axis(axis);
        ca.partial_cmp(&cb).unwrap_or(core::cmp::Ordering::Equal)
    });
    let mid = (start + end) / 2;
    let left = NODES.len();
    NODES.push(Node::default());
    NODES.push(Node::default());
    NODES[ni].first = left as u32;
    NODES[ni].count = 0;
    build_node(left, start, mid);
    build_node(left + 1, mid, end);
}

#[inline]
fn aabb(bmin: V, bmax: V, ro: V, inv: V, tmax: f32) -> f32 {
    let t1 = (bmin - ro) * inv;
    let t2 = (bmax - ro) * inv;
    let tn = t1.min(t2).maxc();
    let tf = t1.max(t2);
    let tf = tf.x.min(tf.y).min(tf.z);
    if tf >= tn.max(0.0) && tn < tmax {
        tn
    } else {
        f32::INFINITY
    }
}

#[inline]
fn hit_obj(o: &Obj, ro: V, rd: V, inv: V, tmax: f32) -> Option<(f32, V)> {
    if o.kind == SPHERE {
        let r = o.s.x;
        let oc = ro - o.c;
        let b = oc.dot(rd);
        let c = oc.dot(oc) - r * r;
        let disc = b * b - c;
        if disc < 0.0 {
            return None;
        }
        let sq = disc.sqrt();
        let mut t = -b - sq;
        if t < EPS {
            t = -b + sq;
        }
        if t < EPS || t > tmax {
            return None;
        }
        Some((t, (ro + rd * t - o.c) * (1.0 / r)))
    } else {
        let t1 = (o.bmin - ro) * inv;
        let t2 = (o.bmax - ro) * inv;
        let tn = t1.min(t2).maxc();
        let tfv = t1.max(t2);
        let tf = tfv.x.min(tfv.y).min(tfv.z);
        if tf < tn || tf < EPS {
            return None;
        }
        let t = if tn > EPS { tn } else { tf };
        if t > tmax {
            return None;
        }
        let p = ro + rd * t - o.c;
        let q = v(p.x / o.s.x, p.y / o.s.y, p.z / o.s.z);
        let (ax, ay, az) = (q.x.abs(), q.y.abs(), q.z.abs());
        let n = if ax > ay && ax > az {
            v(q.x.signum(), 0.0, 0.0)
        } else if ay > az {
            v(0.0, q.y.signum(), 0.0)
        } else {
            v(0.0, 0.0, q.z.signum())
        };
        Some((t, n))
    }
}

const FLOOR: i32 = -1;
const NONE: i32 = -2;

struct Hit {
    t: f32,
    n: V,
    id: i32,
}

fn intersect(ro: V, rd: V) -> Hit {
    let mut h = Hit { t: 1e30, n: v(0.0, 1.0, 0.0), id: NONE };
    if rd.y.abs() > 1e-7 {
        let t = -ro.y / rd.y;
        if t > EPS && t < 400.0 {
            h.t = t;
            h.id = FLOOR;
            h.n = v(0.0, if ro.y >= 0.0 { 1.0 } else { -1.0 }, 0.0);
        }
    }
    let inv = v(1.0 / rd.x, 1.0 / rd.y, 1.0 / rd.z);
    unsafe {
        if OBJS.is_empty() {
            return h;
        }
        let mut stack = [0u32; 64];
        let mut sp = 0usize;
        stack[sp] = 0;
        sp += 1;
        while sp > 0 {
            sp -= 1;
            let node = NODES.get_unchecked(stack[sp] as usize);
            if aabb(node.bmin, node.bmax, ro, inv, h.t) == f32::INFINITY {
                continue;
            }
            if node.count > 0 {
                for k in node.first..node.first + node.count {
                    let id = *ORDER.get_unchecked(k as usize);
                    if let Some((t, n)) = hit_obj(OBJS.get_unchecked(id as usize), ro, rd, inv, h.t) {
                        h.t = t;
                        h.n = n;
                        h.id = id as i32;
                    }
                }
            } else {
                let l = node.first as usize;
                let a = NODES.get_unchecked(l);
                let b = NODES.get_unchecked(l + 1);
                let ta = aabb(a.bmin, a.bmax, ro, inv, h.t);
                let tb = aabb(b.bmin, b.bmax, ro, inv, h.t);
                // Push the farther child first so the nearer one is visited first.
                let (near, far, tnear, tfar) = if ta <= tb { (l, l + 1, ta, tb) } else { (l + 1, l, tb, ta) };
                if tfar != f32::INFINITY {
                    stack[sp] = far as u32;
                    sp += 1;
                }
                if tnear != f32::INFINITY {
                    stack[sp] = near as u32;
                    sp += 1;
                }
            }
        }
    }
    h
}

/// Transmittance along a shadow ray. Glass tints light instead of blocking it.
fn occlusion(ro: V, rd: V, tmax: f32, skip: i32) -> V {
    if rd.y < 0.0 && ro.y > 0.0 && -ro.y / rd.y < tmax {
        return V::default();
    }
    let mut tr = v(1.0, 1.0, 1.0);
    let inv = v(1.0 / rd.x, 1.0 / rd.y, 1.0 / rd.z);
    unsafe {
        if OBJS.is_empty() {
            return tr;
        }
        let mut stack = [0u32; 64];
        let mut sp = 1usize;
        while sp > 0 {
            sp -= 1;
            let node = NODES.get_unchecked(stack[sp] as usize);
            if aabb(node.bmin, node.bmax, ro, inv, tmax) == f32::INFINITY {
                continue;
            }
            if node.count > 0 {
                for k in node.first..node.first + node.count {
                    let id = *ORDER.get_unchecked(k as usize);
                    if id as i32 == skip {
                        continue;
                    }
                    let o = OBJS.get_unchecked(id as usize);
                    if hit_obj(o, ro, rd, inv, tmax).is_some() {
                        if o.mat == GLASS {
                            tr = tr * (o.col * 0.85);
                        } else {
                            return V::default();
                        }
                    }
                }
            } else {
                stack[sp] = node.first;
                stack[sp + 1] = node.first + 1;
                sp += 2;
            }
        }
    }
    tr
}

#[derive(Clone, Copy)]
struct Sky {
    sun: V,
    sun_col: V,
    zenith: V,
    horizon: V,
    ground: V,
    glow: V,
    stars: f32,
}

const SKIES: [Sky; 3] = [
    // Sunset
    Sky {
        sun: v(0.42, 0.16, -0.89),
        sun_col: v(2.6, 1.35, 0.6),
        zenith: v(0.012, 0.02, 0.09),
        horizon: v(0.5, 0.17, 0.06),
        ground: v(0.03, 0.02, 0.02),
        glow: v(1.4, 0.42, 0.1),
        stars: 0.0,
    },
    // Night
    Sky {
        sun: v(-0.3, 0.55, -0.78),
        sun_col: v(0.05, 0.07, 0.13),
        zenith: v(0.002, 0.004, 0.012),
        horizon: v(0.02, 0.015, 0.04),
        ground: v(0.003, 0.003, 0.004),
        glow: v(0.03, 0.04, 0.08),
        stars: 1.0,
    },
    // Day
    Sky {
        sun: v(0.35, 0.86, -0.37),
        sun_col: v(3.2, 3.0, 2.7),
        zenith: v(0.22, 0.42, 0.95),
        horizon: v(0.75, 0.85, 1.0),
        ground: v(0.1, 0.1, 0.1),
        glow: v(0.6, 0.5, 0.35),
        stars: 0.0,
    },
];

const SUN_COS: f32 = 0.9993;

fn hash3(x: i32, y: i32, z: i32) -> u32 {
    let mut h = (x as u32).wrapping_mul(73856093) ^ (y as u32).wrapping_mul(19349663) ^ (z as u32).wrapping_mul(83492791);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5bd1e995);
    h ^ (h >> 15)
}

fn sky(d: V, specular: bool) -> V {
    let s = unsafe { &SKY };
    let mut c = if d.y > 0.0 {
        let t = d.y.sqrt();
        s.horizon * (1.0 - t) + s.zenith * t
    } else {
        let t = (-d.y * 6.0).min(1.0);
        s.horizon * (1.0 - t) + s.ground * t
    };
    let sd = d.dot(s.sun).max(0.0);
    c = c + s.glow * (sd.powi(16) * 0.6 + sd.powi(256) * 2.0);
    if specular && sd > SUN_COS {
        c = c + s.sun_col * 220.0;
    }
    if s.stars > 0.0 && d.y > 0.02 {
        let q = 420.0;
        let h = hash3((d.x * q) as i32, (d.y * q) as i32, (d.z * q) as i32);
        if h % 1000 < 2 {
            let b = (h >> 10) % 100;
            c = c + v(0.8, 0.85, 1.0) * (0.5 + b as f32 * 0.04);
        }
    }
    c
}

struct Rng(u32);
impl Rng {
    #[inline]
    fn f(&mut self) -> f32 {
        // PCG-style hash step.
        self.0 = self.0.wrapping_mul(747796405).wrapping_add(2891336453);
        let w = ((self.0 >> ((self.0 >> 28) + 4)) ^ self.0).wrapping_mul(277803737);
        let w = (w >> 22) ^ w;
        (w >> 8) as f32 * (1.0 / 16777216.0)
    }
}

fn onb(n: V) -> (V, V) {
    let s = if n.z >= 0.0 { 1.0 } else { -1.0 };
    let a = -1.0 / (s + n.z);
    let b = n.x * n.y * a;
    (v(1.0 + s * n.x * n.x * a, s * b, -s * n.x), v(b, s + n.y * n.y * a, -n.y))
}

fn cosine_dir(n: V, r: &mut Rng) -> V {
    let u1 = r.f();
    let phi = 2.0 * PI * r.f();
    let rr = u1.sqrt();
    let (t, b) = onb(n);
    (t * (rr * phi.cos()) + b * (rr * phi.sin()) + n * (1.0 - u1).max(0.0).sqrt()).norm()
}

fn in_sphere(r: &mut Rng) -> V {
    loop {
        let p = v(r.f() * 2.0 - 1.0, r.f() * 2.0 - 1.0, r.f() * 2.0 - 1.0);
        if p.dot(p) < 1.0 {
            return p;
        }
    }
}

fn reflect(d: V, n: V) -> V {
    d - n * (2.0 * d.dot(n))
}

/// Next-event estimation: the sun plus one randomly chosen spherical light.
fn direct(p: V, n: V, r: &mut Rng) -> V {
    let s = unsafe { &SKY };
    let mut c = V::default();
    // Sun with a small angular radius for soft shadows.
    let (t, b) = onb(s.sun);
    let a = 0.025 * r.f().sqrt();
    let phi = 2.0 * PI * r.f();
    let sd = (s.sun + t * (a * phi.cos()) + b * (a * phi.sin())).norm();
    let cs = n.dot(sd);
    if cs > 0.0 {
        let tr = occlusion(p, sd, 1e30, NONE);
        c = c + s.sun_col * tr * cs;
    }
    unsafe {
        let nl = LIGHTS.len();
        if nl > 0 {
            let li = LIGHTS[((r.f() * nl as f32) as usize).min(nl - 1)];
            let l = &OBJS[li as usize];
            let to = l.c - p;
            let d2 = to.dot(to);
            let rad = l.s.x;
            if d2 > rad * rad * 1.0001 {
                let dist = d2.sqrt();
                let w = to * (1.0 / dist);
                let cos_max = (1.0 - rad * rad / d2).max(0.0).sqrt();
                let ct = 1.0 - r.f() * (1.0 - cos_max);
                let st = (1.0 - ct * ct).max(0.0).sqrt();
                let ph = 2.0 * PI * r.f();
                let (lt, lb) = onb(w);
                let dir = (lt * (st * ph.cos()) + lb * (st * ph.sin()) + w * ct).norm();
                let cn = n.dot(dir);
                if cn > 0.0 {
                    let tr = occlusion(p, dir, dist - rad, li as i32);
                    let le = l.col * l.emit;
                    c = c + le * tr * (cn * 2.0 * (1.0 - cos_max) * nl as f32);
                }
            }
        }
    }
    c
}

fn trace(mut ro: V, mut rd: V, r: &mut Rng) -> V {
    let mut thr = v(1.0, 1.0, 1.0);
    let mut col = V::default();
    let mut specular = true;
    for depth in 0..MAX_DEPTH {
        let h = intersect(ro, rd);
        if h.id == NONE {
            col = col + thr * sky(rd, specular);
            break;
        }
        let p = ro + rd * h.t;
        let front = rd.dot(h.n) < 0.0;
        let nl = if front { h.n } else { -h.n };
        let (alb, mat, rough, ior, emit, is_light) = if h.id == FLOOR {
            let check = ((p.x.floor() as i32 + p.z.floor() as i32) & 1) == 0;
            let fx = p.x - p.x.floor();
            let fz = p.z - p.z.floor();
            let seam = fx < 0.02 || fz < 0.02 || fx > 0.98 || fz > 0.98;
            let a = if seam { v(0.02, 0.02, 0.02) } else if check { v(0.55, 0.55, 0.58) } else { v(0.03, 0.035, 0.04) };
            (a, GLOSSY, 0.03, 1.5, 0.0, false)
        } else {
            let o = unsafe { &OBJS[h.id as usize] };
            (o.col, o.mat, o.rough, o.ior, o.emit, o.kind == SPHERE)
        };
        match mat {
            EMIT => {
                if specular || !is_light {
                    col = col + thr * alb * emit;
                }
                break;
            }
            METAL => {
                let mut d = reflect(rd, nl);
                if rough > 0.0 {
                    d = (d + in_sphere(r) * rough).norm();
                    if d.dot(nl) <= 0.0 {
                        d = reflect(rd, nl);
                    }
                }
                // Fresnel-tinted metal: grazing angles go white.
                let f = (1.0 + rd.dot(nl)).max(0.0).powi(5);
                thr = thr * (alb * (1.0 - f) + v(1.0, 1.0, 1.0) * f);
                rd = d;
                ro = p + nl * EPS;
                specular = true;
            }
            GLASS => {
                let cosi = (-rd.dot(nl)).min(1.0);
                let eta = if front { 1.0 / ior } else { ior };
                let k = 1.0 - eta * eta * (1.0 - cosi * cosi);
                let r0 = ((1.0 - ior) / (1.0 + ior)).powi(2);
                let f = if k < 0.0 { 1.0 } else { r0 + (1.0 - r0) * (1.0 - cosi).powi(5) };
                if r.f() < f {
                    rd = reflect(rd, nl);
                    ro = p + nl * EPS;
                } else {
                    rd = (rd * eta + nl * (eta * cosi - k.sqrt())).norm();
                    ro = p - nl * EPS;
                    if front {
                        thr = thr * alb;
                    }
                }
                specular = true;
            }
            _ => {
                let coat = mat == GLOSSY && {
                    let c = (-rd.dot(nl)).max(0.0);
                    let f = 0.04 + 0.96 * (1.0 - c).powi(5);
                    r.f() < f.max(0.12)
                };
                ro = p + nl * EPS;
                if coat {
                    let mut d = reflect(rd, nl);
                    if rough > 0.0 {
                        d = (d + in_sphere(r) * rough).norm();
                        if d.dot(nl) <= 0.0 {
                            d = reflect(rd, nl);
                        }
                    }
                    rd = d;
                    specular = true;
                } else {
                    col = col + thr * alb * direct(ro, nl, r);
                    thr = thr * alb;
                    rd = cosine_dir(nl, r);
                    specular = false;
                }
            }
        }
        if depth >= 3 {
            let pr = thr.maxc().clamp(0.05, 0.95);
            if r.f() > pr {
                break;
            }
            thr = thr * (1.0 / pr);
        }
    }
    // Clamp fireflies.
    let m = col.maxc();
    if m > 24.0 {
        col = col * (24.0 / m);
    }
    col
}

fn aces(x: f32) -> f32 {
    ((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)).clamp(0.0, 1.0)
}

/// Render rows `row0, row0 + step, ...` of a `w`×`h` image.
/// `frame` 0 resets the accumulation buffer; `blend` is the minimum weight for the
/// new sample (0 for a true progressive average, higher while the camera moves).
/// Returns a pointer to RGBA8 pixels for just those rows.
#[no_mangle]
pub extern "C" fn render(
    w: u32,
    h: u32,
    row0: u32,
    step: u32,
    frame: u32,
    blend: f32,
    px: f32,
    py: f32,
    pz: f32,
    yaw: f32,
    pitch: f32,
    fov: f32,
    sky_mode: u32,
    exposure: f32,
) -> *const u8 {
    unsafe {
        SKY = SKIES[(sky_mode as usize).min(SKIES.len() - 1)];
        let rows = if row0 >= h { 0 } else { (h - row0 + step - 1) / step } as usize;
        let n = rows * w as usize;
        if ACC.len() != n * 3 {
            ACC = vec![0.0; n * 3];
        }
        if OUT.len() != n * 4 {
            OUT = vec![255; n * 4];
        }
        let eye = v(px, py, pz);
        let fwd = v(pitch.cos() * yaw.sin(), pitch.sin(), -pitch.cos() * yaw.cos());
        let right = fwd.cross(v(0.0, 1.0, 0.0)).norm();
        let up = right.cross(fwd);
        let th = (fov * 0.5).tan();
        let aspect = w as f32 / h as f32;
        let wt = if frame == 0 { 1.0 } else { (1.0 / (frame as f32 + 1.0)).max(blend) };
        for ri in 0..rows {
            let y = row0 as usize + ri * step as usize;
            for x in 0..w as usize {
                let idx = ri * w as usize + x;
                let mut rng = Rng((y as u32 * 9781 + x as u32 * 6271) ^ frame.wrapping_mul(26699) ^ 0x9e3779b9);
                rng.f();
                let sx = ((x as f32 + rng.f()) / w as f32 * 2.0 - 1.0) * th * aspect;
                let sy = (1.0 - (y as f32 + rng.f()) / h as f32 * 2.0) * th;
                let rd = (fwd + right * sx + up * sy).norm();
                let c = trace(eye, rd, &mut rng);
                let a = &mut ACC[idx * 3..idx * 3 + 3];
                a[0] += (c.x - a[0]) * wt;
                a[1] += (c.y - a[1]) * wt;
                a[2] += (c.z - a[2]) * wt;
                let o = &mut OUT[idx * 4..idx * 4 + 4];
                o[0] = (aces(a[0] * exposure).powf(1.0 / 2.2) * 255.0) as u8;
                o[1] = (aces(a[1] * exposure).powf(1.0 / 2.2) * 255.0) as u8;
                o[2] = (aces(a[2] * exposure).powf(1.0 / 2.2) * 255.0) as u8;
            }
        }
        OUT.as_ptr()
    }
}

/// Cast one ray. Returns the hit object index, -1 for the floor, -2 for nothing.
/// `pick_ptr()` then holds [t, px, py, pz, nx, ny, nz].
#[no_mangle]
pub extern "C" fn pick(ox: f32, oy: f32, oz: f32, dx: f32, dy: f32, dz: f32) -> i32 {
    let ro = v(ox, oy, oz);
    let rd = v(dx, dy, dz).norm();
    let h = intersect(ro, rd);
    let p = ro + rd * h.t;
    unsafe {
        PICK = [h.t, p.x, p.y, p.z, h.n.x, h.n.y, h.n.z, 0.0];
    }
    h.id
}
