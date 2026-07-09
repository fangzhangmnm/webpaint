// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// seal（深模块）—— at-rest 加密**透明**的 router。单一职责 = "encode 永出明文，写前按 name 的
//   at-rest 加密态包壳、读后解壳，密码非交互"。容器格式的重活在 crypto-container（另一模块）；
//   seal 只管**路由 + 非交互密码**，crypto 原语经 seam 注入 → 不碰真 7z 也能测路由。
//
// 红线：明文绝不落盘（加密文件 + 无密码 → 写路径**响亮抛 LOCKED**，绝不静默存明文）。
//   读路径锁定（无/错密码）→ 返 null（**不弹窗**；解锁循环是 UI 在 busy 外的事，见 README.md §7）。
import { toU8 } from "./substrate.ts";
import type { Bytes } from "./substrate.ts";

export class LockedError extends Error {
  code = "LOCKED";
  constructor(name: string) { super(`「${name}」已加密且未解锁（需要密码）`); this.name = "LockedError"; }
}

export interface SealCfg {
  looksContainer: (bytes: Blob | Uint8Array) => Promise<boolean>;                          // 是否加密容器（按 magic，不碰 codec）
  pack: (o: { dataBytes: Bytes; fileName: string; ext?: string; peek?: Uint8Array | null; password: string }) => Promise<Blob>;
  unpack: (blob: Blob | Bytes, password: string) => Promise<{ dataBlob: Blob }>;
  getPassword: (name: string) => string | null;                                            // 同步、非交互、只读内存（唯一密码来源）
  getPrev: (name: string) => Promise<Blob | Uint8Array | null>;                            // 本地 at-rest 字节（判该 name 加密态）
  makePeek?: (plain: Blob) => Promise<Uint8Array | null>;                                  // 明文→不透明预览字节（app；store 不看内容）
  ext?: string;
}

export interface Seal {
  isContainer(bytes: Blob | Uint8Array): Promise<boolean>;
  sealForWrite(name: string, plain: Bytes): Promise<Bytes>;     // 明文→按 at-rest 态包壳；加密态无密码→throw LOCKED
  unsealForRead(name: string, bytes: Blob): Promise<Blob | null>;  // 容器→解壳；锁定→null
  withPassword<T>(name: string, attempt: (pw: string) => Promise<T>): Promise<T | null>;   // 内存密码跑一次；无/错→null
}

export function createSeal(cfg: SealCfg): Seal {
  const { looksContainer, pack, unpack, getPassword, getPrev, makePeek, ext } = cfg;

  function isContainer(bytes: Blob | Uint8Array): Promise<boolean> { return looksContainer(bytes); }

  // 用内存密码跑一次。没密码 / 错密码（code=WRONG_PASSWORD）→ null；其它错误原样上抛。**永不弹窗、永不循环。**
  async function withPassword<T>(name: string, attempt: (pw: string) => Promise<T>): Promise<T | null> {
    const pw = getPassword(name);
    if (!pw) return null;
    try { return await attempt(pw); }
    catch (e: unknown) { if ((e as { code?: string } | null)?.code === "WRONG_PASSWORD") return null; throw e; }
  }

  // 包壳：SSoT = at-rest 字节本身（无登记表可漂移）。
  //   明文 / 输入已是容器（搬运路径）→ 原样；加密文件 + 无密码 → 响亮 LOCKED（绝不静默存明文）。
  async function sealForWrite(name: string, plain: Bytes): Promise<Bytes> {
    if (await looksContainer(plain)) return plain;                          // 已是容器（搬运路径）→ 不二次包
    const prev = await getPrev(name);
    if (!prev || !(await looksContainer(prev))) return plain;              // 明文文件
    const pw = getPassword(name);
    if (!pw) throw new LockedError(name);
    let peek: Uint8Array | null = null;
    if (makePeek) { try { peek = await makePeek(new Blob([plain as BlobPart])); } catch { peek = null; } }
    const container = await pack({ dataBytes: plain, fileName: name, ext, peek, password: pw });
    return await toU8(container);
  }

  // 解壳：明文原样；容器→内存密码解；锁定（无/错密码）→ null。
  async function unsealForRead(name: string, bytes: Blob): Promise<Blob | null> {
    if (!(await looksContainer(bytes))) return bytes;
    const res = await withPassword(name, (pw) => unpack(bytes, pw));
    return res ? res.dataBlob : null;
  }

  return { isContainer, sealForWrite, unsealForRead, withPassword };
}
