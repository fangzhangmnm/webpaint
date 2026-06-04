// OneDriveProvider —— config 驱动的完整 OneDrive CloudProvider（MSAL + Graph + 适配器）。
// **浏览器专属**（MSAL/Graph/document）：方法调用时才碰浏览器；顶层 import 在 node 安全。
// auth 流程（登录/token）只能真机验。
//
// 用法（app 传的就这些，你猜对了：clientId + 浏览器相关 msalUrl）：
//   const { provider, auth } = createOneDriveProvider({
//     clientId: "....",                                  // 必传
//     msalUrl: "./vendor/msal/msal-browser.min.js",      // 浏览器相关：vendored 脚本
//     scopes?, authority?,                               // 有家族默认
//   });
//   await auth.initAuth(); if (auth.isSignedIn()) { ...store 用 provider... }

import * as graph from "./graph.js";
import {
  configureOneDriveAuth,
  isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn,
  getActiveAccount, retrySilentSignIn,
} from "./auth.js";
import { graphToCloudProvider } from "../onedrive-provider.js";

export function createOneDriveProvider(config = {}) {
  configureOneDriveAuth(config);                  // { clientId, scopes?, authority?, msalUrl? }
  return {
    provider: graphToCloudProvider(graph),        // CloudProvider（喂 createCloudSync）
    auth: { isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn, getActiveAccount, retrySilentSignIn },
  };
}

export { configureOneDriveAuth };
