// 云关 = Blockbench 模式（file-first）的真浏览器验收夹具。
//
// 守的契约（user 2026-08-21 拍板：「禁用云的时候应该所有用户路线都走 blockbench 模式」）：
//   云端功能关闭时，**作品字节一个都不进浏览器存储** —— 不进 store 的 files/ 分区，
//   也不进 app 库的 checkpoints（那同样是一份完整 .ora 副本）。doc 的家 = 用户磁盘上的文件。
// 背景：改造前云关时图库被封死、作品却还在往库里写 ⇒ 用户存进去了却看不见、管不了、删不掉。
//   详 ai-docs/20260821-storage-eviction-investigation.md。
//
// 跑法：bash scripts/build.sh && node tools/cloudoff-blockbench-check.mjs
//   （要先构建：夹具跑的是 index.html + dist/ 里的**真实 bundle**，不是源码。）
//
// ⚠ 夹具限制（别把它当成端到端）：headless 里合成的 pointer 事件走不通真实输入栈，
//   所以「脏轨」那条验的是**契约层** —— 直接派发 app 自己的编辑信号 wp:histchange，
//   再看 beforeunload 挽留是否生效。真描边→标脏属真机批。
//   同理保存按钮：headless 无 user-gesture 活化，showSaveFilePicker 会抛；
//   该断言只问「库里有没有多出字节」，不验 OS 保存框本身。

// 云关 = Blockbench 模式的真浏览器验收。
// 判据：关云后新建作品 → store 的 files/ 分区 **零键**、checkpoints **零键**，且文档有脏轨（关 tab 会被拦）。
import { chromium } from "playwright";
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = process.cwd(), PORT = 8952;
const MIME={".html":"text/html",".mjs":"text/javascript",".js":"text/javascript",".json":"application/json",".css":"text/css",".svg":"image/svg+xml",".png":"image/png",".webmanifest":"application/manifest+json"};
const srv=http.createServer((q,res)=>{let u=decodeURIComponent((q.url||"/").split("?")[0]);if(u==="/")u="/index.html";
  const f=path.join(ROOT,u);
  if(!f.startsWith(ROOT)||!fs.existsSync(f)||fs.statSync(f).isDirectory()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{"content-type":MIME[path.extname(f)]||"application/octet-stream"});res.end(fs.readFileSync(f));});
await new Promise(r=>srv.listen(PORT,r));
const t0=Date.now(); const T=m=>console.log(`[${((Date.now()-t0)/1000).toFixed(1)}s] ${m}`);
const browser=await chromium.launch({args:["--enable-unsafe-swiftshader","--use-angle=swiftshader","--ignore-gpu-blocklist","--enable-webgl"]});
const ctx=await browser.newContext(); const page=await ctx.newPage();
const errs=[]; page.on("pageerror",e=>errs.push(String(e).split("\n")[0]));

const clickId=(id)=>page.evaluate((i)=>{const el=document.getElementById(i); if(!el) return "no-el"; el.click(); return "clicked";},id);
const dbDump=()=>page.evaluate(async()=>{
  const names=(await (indexedDB.databases?indexedDB.databases():Promise.resolve([]))).map(d=>d.name).filter(Boolean);
  const out={};
  for(const n of names){
    const db=await new Promise(res=>{const r=indexedDB.open(n);r.onsuccess=()=>res(r.result);r.onerror=()=>res(null);r.onblocked=()=>res(null);setTimeout(()=>res(null),2000);});
    if(!db){out[n]="<blocked>";continue;}
    out[n]={};
    for(const s of Array.from(db.objectStoreNames))
      out[n][s]=await new Promise(res=>{const t=db.transaction(s,"readonly");const q=t.objectStore(s).getAllKeys();t.oncomplete=()=>res(q.result.map(String));t.onabort=()=>res(["<abort>"]);});
    db.close();
  }
  return out;});
const st=()=>page.evaluate(()=>({status:document.getElementById("statusLabel")?.textContent||"",mode:document.body.dataset.mode||"(canvas)",
  cloudState:document.querySelector('[data-state-for="cloudEnabled"]')?.textContent||"?"}));

await page.goto(`http://localhost:${PORT}/`,{waitUntil:"domcontentloaded",timeout:20000});
await page.waitForTimeout(3500); T("boot#1（云默认开）"+JSON.stringify(await st()));

T("关云 → "+await clickId("menuCloudEnabled"));
await page.waitForTimeout(1500); T("关云后 "+JSON.stringify(await st()));

await page.reload({waitUntil:"domcontentloaded"}); await page.waitForTimeout(3500);
const bootState=await st(); T("boot#2（云关）"+JSON.stringify(bootState));
const before=await dbDump();
const filesOf=d=>{const e=Object.entries(d).find(([n])=>n.includes("defaultStore"));return e&&e[1].blobs?e[1].blobs.filter(k=>k.startsWith("files/")):[];};
const cpsOf=d=>(Object.entries(d).find(([n])=>n==="weebpaint")?.[1]?.checkpoints)||[];
T("新建前 files/="+JSON.stringify(filesOf(before))+" checkpoints="+JSON.stringify(cpsOf(before)));

T("新建作品 → "+await clickId("addNew"));
await page.waitForTimeout(600);
T("确认 → "+await clickId("newDocConfirm"));
await page.waitForTimeout(3000);
const afterState=await st(); const after=await dbDump();
T("新建后 "+JSON.stringify(afterState));

// 脏轨：画一笔后 session.dirty 应为 true（beforeunload 才会拦）
const dirty=await page.evaluate(async()=>{
  let sawHist=false; const spy=()=>{sawHist=true;};
  window.addEventListener("wp:histchange",spy);
  const c=document.querySelector("canvas");
  if(c){ const r=c.getBoundingClientRect();
    const opt=(x,y,p)=>({bubbles:true,cancelable:true,pointerId:1,pointerType:"pen",isPrimary:true,clientX:x,clientY:y,pressure:p,buttons:1});
    c.dispatchEvent(new PointerEvent("pointerdown",opt(r.left+r.width/2,r.top+r.height/2,.7)));
    for(let i=1;i<=6;i++) c.dispatchEvent(new PointerEvent("pointermove",opt(r.left+r.width/2+i*12,r.top+r.height/2+i*8,.7)));
    c.dispatchEvent(new PointerEvent("pointerup",{...opt(r.left+r.width/2+72,r.top+r.height/2+48,0),buttons:0}));
    await new Promise(z=>setTimeout(z,900));
  }
  const strokeMadeHist=sawHist;
  // 契约验证：不依赖能否合成出一笔真描边 —— 直接派 app 自己的编辑信号。
  if(!sawHist) window.dispatchEvent(new CustomEvent("wp:histchange",{detail:{canUndo:true,canRedo:false}}));
  await new Promise(z=>setTimeout(z,300));
  window.removeEventListener("wp:histchange",spy);
  const blocked=!window.dispatchEvent(new Event("beforeunload",{cancelable:true}));
  return { strokeMadeHist, blocked };
});

// 保存按钮：云关时必须走本地文件路线，**绝不**往库里写。
//   （headless 里 showSaveFilePicker 拿不到 user-gesture 活化会抛 —— 代码 catch 后报错即可；
//    本断言只问一件事：库里有没有多出字节。）
T("按保存 → "+await clickId("topSaveBtn"));
await page.waitForTimeout(2000);
const afterSave=await dbDump();
const filesAfterSave=filesOf(afterSave);
T("保存后 files/="+JSON.stringify(filesAfterSave)+" status="+(await st()).status);

const files=filesOf(after), cps=cpsOf(after);
console.log("\n===== 判定 =====");
const ok=[];
const chk=(c,l,d)=>{console.log(`  ${c?"✓":"✗"} ${l}${d?"  — "+d:""}`);ok.push(c);};
chk(bootState.cloudState!=="开"&&bootState.cloudState!=="On", "云确实关着", "开关显示："+bootState.cloudState);
chk(files.length===0, "store files/ 零键（作品没进库）", JSON.stringify(files));
chk(cps.length===0, "checkpoints 零键（没写完整 .ora 副本）", JSON.stringify(cps));
chk(dirty.blocked, "未保存文档有脏轨（关 tab 会被挽留）", "合成描边触发 histchange="+dirty.strokeMadeHist);
chk(filesAfterSave.length===0, "按了保存之后库里仍然零键", JSON.stringify(filesAfterSave));
const banner=await page.evaluate(()=>{const b=document.getElementById("__errBar");return b?(b.textContent||"").slice(0,120):"";});
chk(!banner, "云关流程不弹错误 banner", banner||"(无)");
chk(errs.length===0, "无页面异常", errs.slice(0,2).join(" | "));
console.log("  IDB 全量:", JSON.stringify(after));
await browser.close(); srv.close();
process.exit(ok.every(Boolean)?0:1);
