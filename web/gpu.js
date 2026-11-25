// WebGPU backend: trace.wgsl computes paths + reprojection into ping-pong
// history buffers, then a fullscreen pass tonemaps and upscales to the canvas.

const DISPLAY_WGSL = /* wgsl */ `
struct D { src: vec4f, dst: vec4f }
@group(0) @binding(0) var<uniform> dd: D;
@group(0) @binding(1) var<storage, read> img: array<vec4f>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(p * 2.0 - 1.0, 0.0, 1.0);
}

fn px(x: i32, y: i32) -> vec3f {
  let w = i32(dd.src.x);
  let h = i32(dd.src.y);
  let cx = clamp(x, 0, w - 1);
  let cy = clamp(y, 0, h - 1);
  return img[u32(cy * w + cx)].xyz;
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let p = pos.xy / dd.dst.xy * dd.src.xy - 0.5;
  let i = floor(p);
  let f = p - i;
  let x = i32(i.x);
  let y = i32(i.y);
  let c = mix(mix(px(x, y), px(x + 1, y), f.x), mix(px(x, y + 1), px(x + 1, y + 1), f.x), f.y);
  return vec4f(pow(aces(c * dd.src.z), vec3f(1.0 / 2.2)), 1.0);
}
`;

export const SKIES = [
  { sun: [0.42, 0.16, -0.89], sunCol: [2.6, 1.35, 0.6], zenith: [0.012, 0.02, 0.09], horizon: [0.5, 0.17, 0.06], ground: [0.03, 0.02, 0.02], glow: [1.4, 0.42, 0.1], stars: 0 },
  { sun: [-0.3, 0.55, -0.78], sunCol: [0.05, 0.07, 0.13], zenith: [0.002, 0.004, 0.012], horizon: [0.02, 0.015, 0.04], ground: [0.003, 0.003, 0.004], glow: [0.03, 0.04, 0.08], stars: 1 },
  { sun: [0.35, 0.86, -0.37], sunCol: [3.2, 3.0, 2.7], zenith: [0.22, 0.42, 0.95], horizon: [0.75, 0.85, 1.0], ground: [0.1, 0.1, 0.1], glow: [0.6, 0.5, 0.35], stars: 0 },
];
for (const s of SKIES) {
  const l = Math.hypot(...s.sun);
  s.sun = s.sun.map((x) => x / l);
}

// Flatten the wasm BVH (children at first, first + 1) into depth-first order with
// skip links so the shader can walk it without a stack.
function threadBvh(raw) {
  const f = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const u = new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const outF = new Float32Array(f.length), outU = new Uint32Array(outF.buffer);
  let next = 0;
  (function emit(i) {
    const o = next++ * 8, s = i * 8;
    outF.set(f.subarray(s, s + 3), o);
    outF.set(f.subarray(s + 4, s + 7), o + 4);
    const first = u[s + 3], count = u[s + 7];
    if (count > 0) outU[o + 3] = (count << 24) | first;
    else { outU[o + 3] = 0; emit(first); emit(first + 1); }
    outU[o + 7] = next; // skip: first node after this subtree
  })(0);
  return outF;
}

export async function createGpu(canvas, { maxObjects, onLost }) {
  if (!navigator.gpu) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  device.lost.then((e) => onLost?.(e.message || 'device lost'));
  const context = canvas.getContext('webgpu');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const code = await (await fetch('trace.wgsl')).text();
  const traceModule = device.createShaderModule({ code });
  const info = await traceModule.getCompilationInfo?.();
  const errors = info?.messages?.filter((m) => m.type === 'error') ?? [];
  if (errors.length) throw new Error('WGSL: ' + errors.map((m) => `${m.lineNum}:${m.linePos} ${m.message}`).join('; '));

  const compute = device.createComputePipeline({ layout: 'auto', compute: { module: traceModule, entryPoint: 'cs_main' } });
  const displayModule = device.createShaderModule({ code: DISPLAY_WGSL });
  const display = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: displayModule, entryPoint: 'vs' },
    fragment: { module: displayModule, entryPoint: 'fs', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });

  const U_SIZE = 17 * 16;
  const uniform = device.createBuffer({ size: U_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const dUniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const objBuf = device.createBuffer({ size: Math.max(1, maxObjects) * 64, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const lightBuf = device.createBuffer({ size: Math.max(1, maxObjects) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const nodeBuf = device.createBuffer({ size: (2 * Math.max(1, maxObjects) + 1) * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  let objCount = 0, lightCount = 0;

  let cap = 0; // pixels the history buffers can hold
  let hist = [], pos = [], groups = [], dgroups = [];
  let cur = 0;
  let prev = null; // { w, h, cam } of the frame currently in hist[cur]

  function allocate(px) {
    for (const b of [...hist, ...pos]) b.destroy();
    cap = px;
    const mk = () => device.createBuffer({ size: px * 16, usage: GPUBufferUsage.STORAGE });
    hist = [mk(), mk()];
    pos = [mk(), mk()];
    // groups[i] reads buffer i and writes buffer 1 - i.
    groups = [0, 1].map((i) => device.createBindGroup({
      layout: compute.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: objBuf } },
        { binding: 2, resource: { buffer: lightBuf } },
        { binding: 3, resource: { buffer: hist[i] } },
        { binding: 4, resource: { buffer: pos[i] } },
        { binding: 5, resource: { buffer: hist[1 - i] } },
        { binding: 6, resource: { buffer: pos[1 - i] } },
        { binding: 7, resource: { buffer: nodeBuf } },
      ],
    }));
    dgroups = [0, 1].map((i) => device.createBindGroup({
      layout: display.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: dUniform } }, { binding: 1, resource: { buffer: hist[i] } }],
    }));
    prev = null;
  }

  /** `bvh` comes from the wasm (`nodes`: raw 32-byte nodes, `order`: object index per leaf slot). */
  function setScene(objs, bvh) {
    const f = new Float32Array(Math.max(1, objs.length) * 16);
    const lights = [];
    for (let slot = 0; slot < objs.length; slot++) {
      const o = objs[bvh.order[slot]];
      f.set([o.k, ...o.p, ...o.s, o.m, ...o.c, o.rough, o.ior, o.e, 0, 0], slot * 16);
      if (o.m === 3 && o.k === 0) lights.push(slot);
    }
    device.queue.writeBuffer(objBuf, 0, f);
    device.queue.writeBuffer(nodeBuf, 0, threadBvh(bvh.nodes));
    if (lights.length) device.queue.writeBuffer(lightBuf, 0, new Uint32Array(lights));
    objCount = objs.length;
    lightCount = lights.length;
    prev = null;
  }

  const ub = new ArrayBuffer(U_SIZE);
  const uf = new Float32Array(ub), uu = new Uint32Array(ub);
  const v4 = (o, a, w = 0) => { uf[o] = a[0]; uf[o + 1] = a[1]; uf[o + 2] = a[2]; uf[o + 3] = w; };

  /** Trace one frame and present it. Resolves when the GPU has finished. */
  async function frame({ cam, w, h, spp, historyCap, sky, exposure, frameIndex }) {
    if (w * h > cap) allocate(Math.ceil(w * h * 1.25));
    const s = SKIES[sky];
    v4(0, cam.eye, cam.th); v4(4, cam.fwd, cam.aspect); v4(8, cam.right); v4(12, cam.up);
    const p = prev?.cam ?? cam;
    v4(16, p.eye, p.th); v4(20, p.fwd, p.aspect); v4(24, p.right); v4(28, p.up);
    v4(32, s.sun, s.stars); v4(36, s.sunCol); v4(40, s.zenith); v4(44, s.horizon); v4(48, s.ground); v4(52, s.glow);
    uu[56] = w; uu[57] = h; uu[58] = prev?.w ?? w; uu[59] = prev?.h ?? h;
    uu[60] = frameIndex; uu[61] = spp; uu[62] = objCount; uu[63] = lightCount;
    uf[64] = prev ? 1 : 0; uf[65] = historyCap; uf[66] = prev && prev.w < w ? 1 : 0; uf[67] = exposure;
    device.queue.writeBuffer(uniform, 0, ub);
    device.queue.writeBuffer(dUniform, 0, new Float32Array([w, h, exposure, 0, canvas.width, canvas.height, 0, 0]));

    const enc = device.createCommandEncoder();
    const cp = enc.beginComputePass();
    cp.setPipeline(compute);
    cp.setBindGroup(0, groups[cur]);
    cp.dispatchWorkgroups(Math.ceil(w / 8), Math.ceil(h / 8));
    cp.end();
    const out = 1 - cur;
    const rp = enc.beginRenderPass({
      colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    });
    rp.setPipeline(display);
    rp.setBindGroup(0, dgroups[out]);
    rp.draw(3);
    rp.end();
    device.queue.submit([enc.finish()]);
    cur = out;
    prev = { w, h, cam };
    await device.queue.onSubmittedWorkDone();
  }

  const ai = adapter.info ?? {};
  const name = [ai.vendor, ai.architecture || ai.description].filter(Boolean).join(' ') || 'WebGPU';
  return { name, setScene, frame, reset: () => { prev = null; } };
}
