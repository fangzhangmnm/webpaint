// 云盘图片 picker 纯模型测试（spec ai-docs/20260820-cloud-image-picker-spec.md）。
// 列举订阅 / IDB 缓存 / 组件 DOM node 测不到 → 进真机批；扩展名路由、token、缩图数学、
// 白底平铺、jpeg 编码接缝是纯的，钉在这里。
import { describe, it, assert, eq } from "./runner.mjs";
import {
  isDocPath, isImagePath, imageBasename, mimeForImageName,
  imageThumbToken, thumbTargetSize, flattenOntoWhite,
} from "../src/gallery/cloud-image-model.ts";
import { encodeJpegFromBytes } from "../src/backend/jpeg-codec.ts";

describe("cloud-image · 扩展名路由（gallery 白名单 / 图片白名单）", () => {
  it("gallery 只认画作与加密容器", () => {
    assert(isDocPath("foo.ora") && isDocPath("a/b/画.ORA"), ".ora 大小写都算");
    assert(isDocPath("foo.ora.zip"), "加密容器 X.ora.zip");
    assert(!isDocPath("claude.md") && !isDocPath("notes.txt"), "杂物不进 gallery");
    assert(!isDocPath("mock.png"), "图片不进 gallery（拍板：不 distract）");
  });
  it("图片白名单 = 浏览器可解码集", () => {
    for (const p of ["a.png", "b.jpg", "c.JPEG", "d.gif", "e.webp", "f.bmp", "g.avif", "夹/图.png"]) {
      assert(isImagePath(p), `${p} 应是图片`);
    }
    for (const p of ["a.ora", "a.ora.zip", "a.md", "a.psd", "a.svg", "a.tga", "png"]) {
      assert(!isImagePath(p), `${p} 不该进图片白名单（svg/tga 显式后置，spec §3）`);
    }
  });
  it("两个白名单互斥（一个文件绝不同时进 gallery 和 picker）", () => {
    for (const p of ["a.ora", "a.zip", "a.png", "a.jpg", "a.md"]) {
      assert(!(isDocPath(p) && isImagePath(p)), p);
    }
  });
  it("basename / MIME", () => {
    eq(imageBasename("素材/mock/ui-a.png"), "ui-a.png");
    eq(imageBasename("root.png"), "root.png");
    eq(mimeForImageName("x.PNG"), "image/png");
    eq(mimeForImageName("x.jpeg"), "image/jpeg");
    eq(mimeForImageName("x.unknown"), "application/octet-stream", "未知扩展给 octet-stream（浏览器嗅字节，无害）");
  });
});

describe("cloud-image · 缩略图 token/尺寸（错了会缓存不失效或糊图）", () => {
  it("token：lastModified 优先，退 size；变了必换", () => {
    eq(imageThumbToken({ lastModified: 111, size: 5 }), imageThumbToken({ lastModified: 111, size: 9 }), "有 lastModified 时 size 不参与");
    assert(imageThumbToken({ lastModified: 111 }) !== imageThumbToken({ lastModified: 222 }), "改文件 → token 变 → 重拉");
    assert(imageThumbToken({ size: 5 }) !== imageThumbToken({ size: 6 }), "无 lastModified 退 size");
    assert(imageThumbToken({ lastModified: 5 }) !== imageThumbToken({ size: 5 }), "两种来源不串号");
  });
  it("目标尺寸：长边压到 max、保比例、绝不放大", () => {
    eq(JSON.stringify(thumbTargetSize(1024, 512, 128)), JSON.stringify({ w: 128, h: 64 }));
    eq(JSON.stringify(thumbTargetSize(512, 1024, 128)), JSON.stringify({ w: 64, h: 128 }));
    eq(JSON.stringify(thumbTargetSize(100, 50, 128)), JSON.stringify({ w: 100, h: 50 }), "小图不放大");
    eq(JSON.stringify(thumbTargetSize(10000, 1, 128)), JSON.stringify({ w: 128, h: 1 }), "极端条状不塌成 0");
  });
});

describe("cloud-image · 白底平铺 + jpeg 编码（透明 png 缩略图不糊黑）", () => {
  it("全透明 → 纯白；不透明像素不动；半透明线性混白", () => {
    const d = new Uint8ClampedArray([
      0, 0, 0, 0,          // 全透明黑 → 应变纯白
      10, 20, 30, 255,     // 不透明 → 原样
      0, 0, 0, 128,        // 半透明黑 → 灰（~127）
    ]);
    flattenOntoWhite(d);
    eq(String([d[0], d[1], d[2], d[3]]), "255,255,255,255", "透明区平铺成白");
    eq(String([d[4], d[5], d[6], d[7]]), "10,20,30,255", "不透明原样");
    assert(Math.abs(d[8] - 127) <= 1 && d[11] === 255, `半透明黑混白 ≈127，实得 ${d[8]}`);
  });
  it("encodeJpegFromBytes：SOI/EOI 魔数 + 尺寸校验", () => {
    const w = 16, h = 9;
    const d = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < d.length; i += 4) { d[i] = 200; d[i + 1] = 90; d[i + 2] = 40; d[i + 3] = 255; }
    const out = encodeJpegFromBytes(d, w, h, 80);
    assert(out.length > 100, "有实体字节");
    eq(String([out[0], out[1]]), "255,216", "SOI ffd8");
    eq(String([out[out.length - 2], out[out.length - 1]]), "255,217", "EOI ffd9");
    let threw = false;
    try { encodeJpegFromBytes(d, w + 1, h); } catch { threw = true; }
    assert(threw, "字节长度和宽高不符必须炸（错误路径不许吞）");
  });
});
