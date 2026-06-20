// 加密容器「格式接口」—— app 侧访问 store 加密容器探测/定位能力的唯一入口（收口边界渗漏，B）。
//
// looksEncryptedContainer / scanEncPeekFromEnd / ENC_PEEK_MIME 定义在 store 深模块的
// crypto-container.ts。历史上 session / 导出 / 云缩略图 / 图库 四处**各自直 import store 内部件**
// （app→store-internal reach-around）。本模块把它收成单一 chokepoint：
//   · app 层只 import 这里，不再钻 src/store/；
//   · merge-up 到 MyPWAPatterns sync-store 时，唯一要改的 import 行在此，四个消费方不动。
// （注：crypto-container.ts 自身还反向依赖 app 的 zip.js/sevenzip.js，故它本身尚未真正可上抽——
//   那是另一刀；本模块只先收掉 app→store 这一向的散落 import。）
export { looksEncryptedContainer, scanEncPeekFromEnd, ENC_PEEK_MIME } from "./store/crypto-container.ts";
