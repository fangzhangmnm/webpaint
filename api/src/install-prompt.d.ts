/** boot 时调一次（settings-menu init）：越早越好——事件发在监听之前就永远收不到了。 */
export declare function initInstallCapture(): void;
/** 把一个菜单按钮登记为安装入口：显隐归本模块管，点击=（先跑 owner 的收面板回调再）弹系统安装框。 */
export declare function bindInstallButton(el: HTMLElement | null, beforePrompt?: () => void): void;
