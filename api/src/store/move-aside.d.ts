/** move-aside 防撞标：`<yyyymmddhhmmss>-<guid>`。ms 由调用方给（cloud-sync 注入时钟便于测试；local 用 Date.now）。 */
export declare function asideStamp(ms: number): string;
