// 入口：注册全部 test 文件后跑。用法：node test/run.mjs
import { run } from "./runner.mjs";
import "./mock-provider.contract.test.mjs";
import "./cloud.contract.test.mjs";
import "./cloud-faults.contract.test.mjs";
import "./store-flow-push.contract.test.mjs";
import "./store-flow-open-exit.contract.test.mjs";
import "./store-flow-trash.contract.test.mjs";
import "./store-multitab.contract.test.mjs";

console.log("\n  sync-store contract tests\n");
await run();
