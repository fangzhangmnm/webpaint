// MockLocal —— 内存模拟本地持久层（IDB），实现 store.local 契约。
// 真 LocalAdapter（包 session.js/storage.js）在 C1b 写；现在用它测 Store 的编排。
//
// store.local 契约：
//   save(name, bytes)      → void        覆盖写（一文件一原子写，H1）
//   get(name)             → bytes|null
//   exists(name)          → bool
//   backup(name)          → backupName   复制一份（原件留着；pull 前的安全网）；本地无此项则抛
//   trash(name)           → trashKey     move-aside 进本地 trash（绝不硬删用户数据）
//   hardDelete(name)      → void         真删（仅用于「云端已进 trash、不留双份」的本地侧）
//   restore(trashKey)     → name|null    从本地 trash 恢复

async function toU8(x) {
  if (x == null) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (typeof x === "string") return new TextEncoder().encode(x);
  if (typeof x.arrayBuffer === "function") return new Uint8Array(await x.arrayBuffer());
  throw new Error("MockLocal: 无法识别的 bytes 类型");
}

export function createMockLocal() {
  const items = new Map();     // name → Uint8Array
  const trash = new Map();     // trashKey → { name, bytes }
  let tk = 0;
  return {
    async save(name, bytes) { items.set(name, await toU8(bytes)); },
    async get(name) { return items.has(name) ? items.get(name) : null; },
    async exists(name) { return items.has(name); },
    async backup(name) {
      if (!items.has(name)) throw new Error(`本地无 ${name}，无法备份`);
      const backupName = `${name}-backup`;
      items.set(backupName, items.get(name));        // 复制：原件不动
      return backupName;
    },
    async trash(name) {
      if (!items.has(name)) return null;
      const key = `trash:${++tk}:${name}`;
      trash.set(key, { name, bytes: items.get(name) });
      items.delete(name);
      return key;
    },
    async hardDelete(name) { items.delete(name); },
    async restore(trashKey) {
      const e = trash.get(trashKey);
      if (!e) return null;
      items.set(e.name, e.bytes);
      trash.delete(trashKey);
      return e.name;
    },
    // 测试辅助
    _items: items,
    _trash: trash,
  };
}
