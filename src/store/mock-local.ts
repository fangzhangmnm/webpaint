// MockLocal —— 内存模拟本地持久层（IDB），实现 store.local 契约。
// 真 LocalCache（包 session.js/storage.js）在 C1b 写；现在用它测 Store 的编排。
//
// store.local 契约：
//   save(name, bytes)      → void        覆盖写（一文件一原子写，H1）
//   get(name)             → bytes|null
//   exists(name)          → bool
//   backup(name)          → backupName   复制一份（原件留着；pull 前的安全网）；本地无此项则抛
//   trash(name)           → trashKey     move-aside 进本地 trash（绝不硬删用户数据）
//   hardDelete(name)      → void         真删（仅用于「云端已进 trash、不留双份」的本地侧）
//   restore(trashKey)     → name|null    从本地 trash 恢复

import type { Bytes } from "./substrate.ts";
import type { LocalCache, TrashEntry } from "./types.ts";

// 本地 trash 条目内部形状。
interface TrashItem {
  name: string;
  bytes: Bytes;
}

async function toU8(x: Bytes | Blob | ArrayBuffer | string | null | undefined): Promise<Bytes> {
  if (x == null) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (typeof x === "string") return new TextEncoder().encode(x);
  if (typeof x.arrayBuffer === "function") return new Uint8Array(await x.arrayBuffer());
  throw new Error("MockLocal: 无法识别的 bytes 类型");
}

// MockLocal = LocalCache 契约（类型层验证真 LocalCache 同契约）+ 测试辅助内省字段。
export interface MockLocal extends LocalCache {
  _items: Map<string, Bytes>;
  _trash: Map<string, TrashItem>;
}

export function createMockLocal(): MockLocal {
  const items = new Map<string, Bytes>();           // name → Uint8Array
  const trash = new Map<string, TrashItem>();        // trashKey → { name, bytes }
  let tk = 0, bk = 0;
  // 注：本测试替身内部以 Uint8Array 存取（测试断言 .length / u8txt），而真 LocalCache
  // 契约「内部落 Blob、get 出 Blob」。二者在「字节 vs Blob」上有意背离 —— 测试只关心字节内容。
  // 故 get 运行时回 Bytes，但声明为契约的 Blob（下方 as 处擦除），保持 MockLocal ⊆ LocalCache。
  const adapter: LocalCache = {
    async save(name: string, bytes: Bytes | Blob) { items.set(name, await toU8(bytes)); },
    async get(name: string): Promise<Blob | null> {
      // 测试替身：运行时回 Uint8Array（测试只读字节内容），类型按契约声明 Blob。
      return (items.has(name) ? items.get(name)! : null) as unknown as Blob | null;
    },
    async exists(name: string) { return items.has(name); },
    async appKeys() { return [...items.keys()].filter((k) => !k.startsWith("local-trash:") && !k.startsWith(".backup-local/") && !k.startsWith("__collection__/")); },
    async backup(name: string) {
      if (!items.has(name)) throw new Error(`本地无 ${name}，无法备份`);
      const backupName = `.backup-local/${++bk}:${name}`;   // 隐藏命名空间 + counter 防撞（测试确定性）；同名多次也唯一
      items.set(backupName, items.get(name)!);              // 复制：原件不动
      return backupName;
    },
    async trash(name: string) {
      // 契约 trash 出 string；本替身在缺名时回 null（测试断言 null），类型按契约擦除。
      if (!items.has(name)) return null as unknown as string;
      const key = `trash:${++tk}:${name}`;
      trash.set(key, { name, bytes: items.get(name)! });
      items.delete(name);
      return key;
    },
    async hardDelete(name: string) { items.delete(name); },
    async restore(trashKey: string) {
      const e = trash.get(trashKey);
      if (!e) return null as unknown as string;   // 同上：缺 key 回 null
      items.set(e.name, e.bytes);
      trash.delete(trashKey);
      return e.name;
    },
    async purgeTrash(trashKey: string) { trash.delete(trashKey); },
    async listTrash(): Promise<TrashEntry[]> { return [...trash.entries()].map(([trashKey, e]) => ({ trashKey, name: e.name })); },
  };
  return {
    ...adapter,
    // 测试辅助
    _items: items,
    _trash: trash,
  };
}
