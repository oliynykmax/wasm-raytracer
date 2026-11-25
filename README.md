# Wasm + WebGPU path tracer

A real-time path tracer you can fly through and build in, running entirely on your device in the browser.

**Live:** https://game.oliinyk.dev

- **GPU:** a WGSL compute shader (WebGPU) traces the scene when the browser supports it.
- **CPU:** the same tracer written in Rust and compiled to one ~65 KB `wasm32` binary, run on every core through Web Workers. It's used when WebGPU is missing, or press **G** to compare.
- Reflections, glass with refraction, soft shadows, coloured area lights and sky lighting all come from following light paths. Nothing is faked with separate effects.
- Temporal reprojection reuses earlier samples while you move, so motion stays smooth. Standing still, the image converges to a clean render.
- A hotbar places mirror, glass, gold and glowing blocks or orbs on a grid.

## Controls

| Desktop | Phone |
|---|---|
| Click to start, WASD fly, Space/Shift up/down, hold F faster | Left thumb joystick, drag to look |
| Left click place, right click break, 1–9 or wheel picks an item | Tap a slot, **+** place, **−** break |
| G GPU/CPU · T sky · R reset · H hide panel | GPU, ☀ and ↺ buttons |

`?cpu` starts on the CPU renderer and `?touch` forces the phone controls.

## Layout

```
src/lib.rs       Rust path tracer → raytracer.wasm (CPU renderer, also used for picking and hotbar icons)
web/trace.wgsl   WGSL port of the tracer plus reprojection (GPU renderer)
web/gpu.js       WebGPU setup, ping-pong history buffers, tonemapping pass
web/main.js      controls, scene, hotbar, worker pool, CPU reprojection
web/worker.js    Web Worker that runs the wasm
web/index.html   page and styles
```

## Build and deploy

Needs Rust with the `wasm32-unknown-unknown` target.

```sh
./build.sh                    # cargo build → web/raytracer.wasm
python3 -m http.server -d web # local preview
wrangler deploy               # Cloudflare Workers static assets
```
