// 家族文件信封 codec（ADR-0011 身份 / spec: ../../20260601 MyPWAPatterns/docs/file-envelope.md
// + docs/file-envelope.md）。身份+极简 meta 住 zip 的 **EOCD comment**：MAGIC(4) + 极简 JSON {g,v,e}。
// app-agnostic、纯函数、可单测（zip 读写在 zip.js；这里只管 comment bytes ⇄ meta 对象）。
// WebPaint 是 pilot：在地写，稳了 merge 回 MyPWAPatterns 共享库。

const MAGIC = "WPM1";                 // family Meta v1；不兼容布局变更才 bump
const ENC = new TextEncoder();
const DEC = new TextDecoder();

export const ENVELOPE_VERSION = 1;
export { MAGIC as ENVELOPE_MAGIC };

// meta={g(guid), v(信封版本), e(editor版本)} —— **极简**，不放绘画态/名字。→ EOCD comment bytes。
export function buildMetaComment(meta) {
  return ENC.encode(MAGIC + JSON.stringify(meta));
}

// EOCD comment bytes → meta；非本格式 / 坏 JSON / 无 guid → null（**robust，绝不抛**，降级走 name）。
export function parseMetaComment(commentBytes) {
  if (!commentBytes || commentBytes.length < 4) return null;
  try {
    const s = DEC.decode(commentBytes);
    if (s.slice(0, MAGIC.length) !== MAGIC) return null;
    const o = JSON.parse(s.slice(MAGIC.length));
    return (o && typeof o.g === "string" && o.g) ? o : null;
  } catch { return null; }
}
