/** 当前是不是以已安装的 web app 形态在跑（主屏/Dock/独立窗口）。 */
export declare function isStandalone(): boolean;
/** installed=已装；promptable=浏览器给了安装入口（Chromium）；manual=只能教用户手动装（iOS Safari 等）。 */
export type InstallState = "installed" | "promptable" | "manual";
export declare function installState(): InstallState;
/** iOS/iPadOS Safari？（决定说明文案走「分享→添加到主屏幕」那套） */
export declare function isIOSSafari(): boolean;
/** 触发原生安装框。**必须在 user-gesture 的同步续体里调**（iOS 红线同款：await 之后活化可能已丢）。
 *  返回 null = 这个浏览器没有可用的原生入口，调用方去弹手动说明。 */
export declare function promptInstall(): Promise<string> | null;
