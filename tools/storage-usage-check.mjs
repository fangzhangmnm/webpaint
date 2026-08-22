// storage-usage-check —— 「本机占用」全口径的真浏览器验收（2026-08-21）。
//
// 守的契约（user 拍板：「存储占用估算要算上这些别的地方，用一个专门的深模块放在一起」）：
//   页脚那个数必须把**用户看不见的几处**也算进去 —— 尤其 `checkpoints`（每幅打开过的画
//   一份完整 .ora 的 revert 快照）。实测：建 2 幅画后 works=14822 B 而 checkpoints=15034 B
//   —— 快照**比作品本体还大**，老口径（只数 store 的 files 分区）少报约 2.9 倍。
//
// 跑法：bash scripts/build.sh && node tools/storage-usage-check.mjs
//   （跑的是 index.html + dist/ 的真实 bundle，经 window.WeebPaint.storageReport() 取数。）
//
// ⚠ 夹具限制：headless 里驱动图库页脚不可靠（exitCanvasToGallery 有等用户点击的模态循环），
//   所以这里验的是**深模块的数据**，不是页脚那行字的渲染。渲染归真机批。

import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT=process.cwd(),PORT=8958;
const MIME={".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".json":"application/json",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".webmanifest":"application/manifest+json"};
const srv=http.createServer((q,res)=>{let u=decodeURIComponent((q.url||"/").split("?")[0]);if(u==="/")u="/index.html";const f=path.join(ROOT,u);
 if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end();return;}
 res.writeHead(200,{"content-type":MIME[path.extname(f)]||"application/octet-stream"});res.end(fs.readFileSync(f));});
await new Promise(r=>srv.listen(PORT,r));
const b=await chromium.launch({args:["--enable-unsafe-swiftshader","--use-angle=swiftshader"]});
const p=await (await b.newContext()).newPage();
p.on("pageerror",e=>console.log("PAGEERR",String(e).split("\n")[0]));
await p.goto(`http://localhost:${PORT}/`,{waitUntil:"domcontentloaded"}); await p.waitForTimeout(3500);

console.log("=== A. 云关 · 空仓 ===");
console.log(JSON.stringify(await p.evaluate(()=>window.WeebPaint.storageReport()),null,1));

await p.evaluate(()=>document.getElementById("menuCloudEnabled")?.click()); await p.waitForTimeout(1500);
for (let i=0;i<2;i++){
  await p.evaluate(()=>document.getElementById("addNew")?.click()); await p.waitForTimeout(500);
  await p.evaluate(()=>document.getElementById("newDocConfirm")?.click()); await p.waitForTimeout(2800);
}
console.log("\n=== B. 云开 · 建了 2 幅画之后 ===");
const rep=await p.evaluate(()=>window.WeebPaint.storageReport());
console.log(JSON.stringify(rep,null,1));
const before=await p.evaluate(()=>window.WeebPaint.storageReport());
const works=rep.buckets.find(x=>x.id==="works"), cps=rep.buckets.find(x=>x.id==="checkpoints");
const ok=[]; const chk=(c,l,d)=>{console.log(`  ${c?"\u2713":"\u2717"} ${l}${d?"  \u2014 "+d:""}`);ok.push(c);};
console.log("\n===== 判定 =====");
chk(!!works && works.count===2, "works 桶数对", works?`${works.count} 件 / ${works.bytes} B`:"缺");
chk(!!cps && cps.count===2, "checkpoints 桶被算进来了（老口径漏的正是它）", cps?`${cps.count} 件 / ${cps.bytes} B`:"缺");
chk(!!cps && !!works && cps.bytes > works.bytes*0.5, "撤销快照与作品本体同量级（证明它不是零头）", cps&&works?`cps/works = ${(cps.bytes/works.bytes).toFixed(2)}`:"—");
chk(rep.accountedBytes > (works?works.bytes:0)*1.5, "全口径明显大于「只数作品」的老口径", `accounted=${rep.accountedBytes} vs works=${works?works.bytes:0}`);
chk(rep.originUsage!=null && rep.accountedBytes<=rep.originUsage, "解释的字节不超过浏览器统计（没重复计数）", `accounted=${rep.accountedBytes} origin=${rep.originUsage}`);
chk(rep.unaccountedBytes!=null && rep.unaccountedBytes>=0, "未计入字节非负", String(rep.unaccountedBytes));
chk(["persistent","best-effort","unsupported","error","unknown"].includes(rep.persistence), "持久化状态可读", rep.persistence);
console.log("  origin usage/quota:", rep.originUsage, "/", rep.originQuota);
await b.close(); srv.close();
process.exit(ok.every(Boolean)?0:1);
