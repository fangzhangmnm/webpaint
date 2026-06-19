// Contribution 注册表原语（架构深化 candidate 2，见 docs/reports/20260608-ui-deepening-and-plugin-survey.html）。
//
// 背景：项目早有一套好接缝（filters.js 的 registerFilter/onFilterRegistered），但只服务 filter。
// 其余「能出现在菜单/工具栏上的贡献项」（导出格式 / 文档操作 / 工具）全是 god file 里的硬 switch。
// 这个 makeRegistry 把「注册 + 监听 + 列举」抽成一道**纯接缝**，让各类贡献共用同一形状：
//   filter / exporter / op / tool 各自一个 registry 实例，契约不同、机制相同。
// 「两个 adapter = 真接缝」：filters.js 与 exporters.js 都用它 → 不是假抽象。
//
// 无 DOM / 无领域知识：只管「id → 贡献项」的 Map + 注册监听。菜单怎么渲染、贡献怎么调用，
// 都是消费侧（view-model / app）的事，不进这里。
//
// 用法：
//   const reg = makeRegistry({ name: "exporter" });
//   reg.register(spec);                 // spec[idKey] 必须有；重复 id = 覆盖（热替换插件友好）
//   reg.get(id) / reg.list() / reg.has(id);
//   const off = reg.onRegistered(fn);   // 新注册时回调（菜单 lazy 重渲染）；返回取消订阅
//
// idKey 默认 "id"；支持 static getter（如 FilterClass.id 是 static 字段，传 "id" 即可）。

export interface RegistryOpts {
  name?: string;
  idKey?: string;
}

export interface Registry<T> {
  register(item: T): T;
  get(id: unknown): T | null;
  has(id: unknown): boolean;
  list(): T[];
  onRegistered(fn: (item: T) => void): () => void;
}

export function makeRegistry<T>({ name = "registry", idKey = "id" }: RegistryOpts = {}): Registry<T> {
  const items = new Map<unknown, T>();
  const listeners = new Set<(item: T) => void>();

  function idOf(item: T): unknown {
    const rec = item as unknown as Record<string, unknown>;
    const raw = item == null ? undefined : rec[idKey];
    return typeof raw === "function" ? (raw as () => unknown).call(item) : raw;
  }

  return {
    register(item: T): T {
      const id = idOf(item);
      if (!id) throw new Error(`${name}: 注册项缺少 ${idKey}`);
      items.set(id, item);
      for (const fn of listeners) {
        try { fn(item); } catch (e) { console.warn(`[${name} listener]`, e); }
      }
      return item;
    },
    get(id: unknown): T | null { return items.get(id) || null; },
    has(id: unknown): boolean { return items.has(id); },
    list(): T[] { return [...items.values()]; },
    onRegistered(fn: (item: T) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
