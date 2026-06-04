// @local/sync-store 公开导出。
export { createStore } from "./store.js";
export { createCloudSync, CloudConflictError, memKv } from "./cloud-sync.js";
export { createMockProvider } from "./mock-provider.js";
export { createMockLocal } from "./mock-local.js";
export { graphToCloudProvider } from "./onedrive-provider.js";   // 纯适配器（可 Mock 验）
export { createOneDriveProvider } from "./providers/index.js";    // config 驱动完整 provider（浏览器）
