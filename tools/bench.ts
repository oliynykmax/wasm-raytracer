// Benchmark the live renderers in headless Chromium with WebGPU enabled.
// Usage: bun tools/bench.ts <baseUrl> [label]   → prints JSON with median paths/s per config.
const base = Bun.argv[2] ?? "http://localhost:8765/";
const configs = [
  { name: "gpu-default", q: "" },
  { name: "gpu-stress300", q: "?stress=300" },
  { name: "cpu-default", q: "?cpu" },
  { name: "cpu-stress300", q: "?cpu&stress=300" },
];
const port = 9334;

async function runOne(url: string) {
  const prof = `${process.env.TMPDIR ?? "/tmp"}/bench-prof-${Date.now()}`;
  const proc = Bun.spawn(["chromium", "--headless=new", "--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=vulkan",
    "--ignore-gpu-blocklist", `--remote-debugging-port=${port}`, "--window-size=1280,720", `--user-data-dir=${prof}`, "about:blank"], { stderr: "ignore", stdout: "ignore" });
  try {
    let tabs: any[] = [];
    for (let i = 0; i < 60; i++) { try { tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); if (tabs.some((t) => t.type === "page")) break; } catch {} await Bun.sleep(200); }
    const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
    await new Promise((r) => (ws.onopen = r));
    let id = 0; const pending = new Map<number, (v: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); } };
    const send = (method: string, params: any = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (e: string) => (await send("Runtime.evaluate", { expression: e, awaitPromise: true, returnByValue: true })).result?.result?.value;
    await send("Page.navigate", { url });
    let ready = 0;
    for (let i = 0; i < 200 && !ready; i++) { await Bun.sleep(100); ready = await ev("document.readyState==='complete' && !document.getElementById('loading') ? performance.now() : 0"); }
    await ev("document.getElementById('start').click()");
    await Bun.sleep(4000);
    const samples: number[] = [];
    for (let i = 0; i < 12; i++) {
      await Bun.sleep(600);
      const t: string = await ev("document.getElementById('stats').textContent");
      const m = t.match(/([\d.]+) M paths\/s/);
      if (m) samples.push(+m[1]);
    }
    const backend = await ev("document.getElementById('backend').textContent");
    ws.close();
    samples.sort((a, b) => a - b);
    return { readyMs: Math.round(ready), mpaths: samples[samples.length >> 1], backend };
  } finally { proc.kill(); await Bun.sleep(500); }
}

const out: Record<string, any> = {};
for (const c of configs) out[c.name] = await runOne(base + c.q);
console.log(JSON.stringify(out, null, 2));
