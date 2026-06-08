// 色轮纯模型测试（UI 深化 candidate 1 · pilot）。
// 从 .ts 直接 import —— node 24 原生 strip types，无需构建。
import { describe, it, eq, assert } from "./runner.mjs";
import { hsvToHex, hexToHsv, normalizeHex, sameHex } from "../src/ui/color-model.ts";

describe("color-model", () => {
  it("hsvToHex 基准色", () => {
    eq(hsvToHex(0, 1, 1), "#ff0000", "红");
    eq(hsvToHex(120, 1, 1), "#00ff00", "绿");
    eq(hsvToHex(240, 1, 1), "#0000ff", "蓝");
    eq(hsvToHex(0, 0, 1), "#ffffff", "白");
    eq(hsvToHex(0, 0, 0), "#000000", "黑");
  });

  it("hexToHsv 基准色", () => {
    const r = hexToHsv("#ff0000");
    eq(Math.round(r.h), 0); eq(r.s, 1); eq(r.v, 1);
    const g = hexToHsv("#00ff00");
    eq(Math.round(g.h), 120);
    const b = hexToHsv("#0000ff");
    eq(Math.round(b.h), 240);
  });

  it("hex round-trip 在饱和色上稳定", () => {
    for (const hex of ["#1b1b1b", "#3a7fd5", "#c0392b", "#2ecc71"]) {
      const { h, s, v } = hexToHsv(hex);
      eq(hsvToHex(h, s, v), hex, `round-trip ${hex}`);
    }
  });

  it("hexToHsv 非法输入归零", () => {
    const z = hexToHsv("garbage");
    eq(z.h, 0); eq(z.s, 0); eq(z.v, 0);
  });

  it("normalizeHex 补 # / 校验 / 小写", () => {
    eq(normalizeHex("1b1b1b"), "#1b1b1b");
    eq(normalizeHex("#ABCDEF"), "#abcdef");
    eq(normalizeHex(" #abcdef "), "#abcdef");
    eq(normalizeHex("#abc"), null, "3 位非法");
    eq(normalizeHex("xyz"), null, "非 hex 非法");
  });

  it("sameHex 大小写无关 + null 安全", () => {
    assert(sameHex("#ABCDEF", "#abcdef"), "大小写无关");
    assert(!sameHex("#000000", "#000001"), "不同色");
    assert(!sameHex(null, "#000"), "null 安全");
    assert(!sameHex("#000", null), "null 安全");
  });
});
