/** 开关变更广播（window 事件；detail 无——消费方自己重读 isCloudEnabled()）。 */
export declare const CLOUD_CAPABILITY_EVENT = "wp:cloud-capability-changed";
/** 用户存的 pref 原值（不含 isAuthConfigured 门）——设置页 toggle 显示「用户意愿」用。 */
export declare function cloudPrefEnabled(): boolean;
/** 云端功能有效开关：容器不支持云（未配置 auth）→ 恒 false；否则读设备本地 pref（默认 true）。 */
export declare function isCloudEnabled(): boolean;
export declare function setCloudEnabled(v: boolean): void;
