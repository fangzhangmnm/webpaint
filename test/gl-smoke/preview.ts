// GL 预览页（独立，不碰生产 board）。一个 demo 文档（含 clip 层 + multiply 组）每帧整树重合成 →
// 显 fps + tile/内存。用来在桌面/iPad **肉眼看 GL 渲染 + 量真机性能**（尤其 clip 层 60fps 这个核心痛点）。
// 像素正确性已由 smoke 自 diff（vs compositeLayers）证；这页是感性确认 + perf。

import { GLContext } from "../../src/gl/gl-context.ts";
import { GLDocRenderer, poolCapacityForBudget } from "../../src/gl/gl-doc-renderer.ts";
import type { DocNode } from "../../src/gl/gl-doc-bridge.ts";

const N = 1024;   // doc 尺寸（4×4 tile/满层）

function layerCanvas(w: number, h: number, fn: (x: number, y: number) => [number, number, number, number]): HTMLCanvasElement {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const im = new ImageData(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b, a] = fn(x, y); const i = (y * w + x) * 4;
    im.data[i] = r; im.data[i + 1] = g; im.data[i + 2] = b; im.data[i + 3] = a;
  }
  c.getContext("2d")!.putImageData(im, 0, 0);
  return c;
}
let _id = 1;
function leaf(bx: number, by: number, bw: number, bh: number, fn: (x: number, y: number) => [number, number, number, number], opts: { mode?: string; opacity?: number; clip?: boolean } = {}): DocNode {
  return { isGroup: false, id: _id++, opacity: opts.opacity ?? 1, mode: opts.mode ?? "source-over", clippingMask: !!opts.clip, visible: true, bboxX: bx, bboxY: by, bboxW: bw, bboxH: bh, canvas: layerCanvas(bw, bh, fn) };
}
function group(children: DocNode[], opts: { mode?: string; opacity?: number } = {}): DocNode & { isGroup: true } {
  return { isGroup: true, id: _id++, opacity: opts.opacity ?? 1, mode: opts.mode ?? "pass-through", clippingMask: false, visible: true, children };
}

// demo 文档：底 + 形状 + 2 个 clip 层（核心痛点）+ multiply 组。
const bg = leaf(0, 0, N, N, (x, y) => [30 + (x % 80), 40 + (y % 100), 70 + ((x + y) % 120), 255]);
const shape1 = leaf(80, 80, 600, 500, (x, y) => [220, 80 + (x % 150), 60, 230]);
const clipA = leaf(120, 120, 500, 400, (x, y) => ((x + y) % 40 < 24) ? [60, 200, 220, 255] : [0, 0, 0, 0], { clip: true });   // 剪裁到 shape1
const shape2 = leaf(400, 350, 560, 560, (x, y) => [80, 60 + (y % 160), 220, 200], { mode: "screen" });
const clipB = leaf(420, 380, 500, 480, (x, y) => (x % 30 < 18) ? [240, 200, 60, 255] : [0, 0, 0, 0], { clip: true });          // 剪裁到 shape2
const gLeaf1 = leaf(200, 500, 500, 400, (x, y) => [200, 200, 200, 200]);
const gLeaf2 = leaf(250, 540, 420, 320, (x, y) => [120 + (x % 130), 60, 180, 220], { mode: "multiply" });
const grp = group([gLeaf1, gLeaf2], { mode: "multiply", opacity: 0.9 });

const nodes: DocNode[] = [bg, shape1, clipA, shape2, clipB, grp];

const canvas = document.getElementById("c") as HTMLCanvasElement;
canvas.width = N; canvas.height = N;
const hud = document.getElementById("hud") as HTMLDivElement;

let renderer: GLDocRenderer;
try {
  const glctx = new GLContext(canvas);
  renderer = new GLDocRenderer(glctx, poolCapacityForBudget(256 * 1024 * 1024));   // 256MB 池
  renderer.syncAll(nodes, N, N);
} catch (e) {
  hud.textContent = "需要 WebGL2：" + String(e);
  throw e;
}

let frames = 0, t0 = performance.now(), fps = 0;
function frame() {
  const t = performance.now() / 1000;
  grp.opacity = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin(t));        // 动起来让 fps 可量（仅改节点字段，不重传像素）
  clipA.opacity = 0.5 + 0.5 * Math.sin(t * 1.3);
  renderer.renderToScreen(nodes, N, N, canvas.width, canvas.height);
  frames++;
  const dt = performance.now() - t0;
  if (dt >= 500) {
    fps = frames * 1000 / dt; frames = 0; t0 = performance.now();
    const m = renderer.memory;
    hud.textContent = `GL 整树重合成 ${fps.toFixed(0)} fps · doc ${N}² · ${nodes.length} 层(含 2 clip + multiply 组) · tile ${m.usedTiles}/${m.capacity} · 实占 ${(m.usedBytes / 1048576).toFixed(1)}MB`;
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
