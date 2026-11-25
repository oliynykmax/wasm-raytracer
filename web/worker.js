// Each worker owns a private WebAssembly instance and renders interleaved rows.
let wasm, mem, objCount = 0;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const instance = await WebAssembly.instantiate(m.module, {});
    wasm = instance.exports;
    mem = wasm.memory;
    self.postMessage({ type: 'ready' });
    return;
  }
  if (m.scene) {
    new Float32Array(mem.buffer, wasm.scene_ptr(), m.scene.length).set(m.scene);
    objCount = m.count;
    wasm.set_scene(objCount);
  }
  const t0 = performance.now();
  const c = m.cam;
  const ptr = wasm.render(m.w, m.h, m.row0, m.step, m.frame,
    c[0], c[1], c[2], c[3], c[4], c[5], m.sky);
  const rows = m.row0 >= m.h ? 0 : Math.ceil((m.h - m.row0) / m.step);
  const px = new Float32Array(rows * m.w * 8);
  px.set(new Float32Array(mem.buffer, ptr, px.length));
  self.postMessage({ type: 'rows', id: m.id, row0: m.row0, step: m.step, px, ms: performance.now() - t0 }, [px.buffer]);
};
