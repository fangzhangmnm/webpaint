// AST 级扫描：src/**/*.ts 里含 CJK 的字符串字面量 / 模板字面量（注释天然排除）。
// 输出：文件:行  字面量内容（截断）+ 简单上下文（外层调用名，便于分类）。
import ts from "../node_modules/typescript/lib/typescript.js";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;

const SKIP_DIRS = new Set(["vendor", "node_modules"]);
const SKIP_FILES = new Set([
  "src/i18n/strings.ts",   // SSoT 本体
  "src/i18n/ucsur.ts",     // 转写表
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) yield* walk(p); }
    else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) yield p;
  }
}

// 找最近的有信息量的祖先：调用表达式名 / 属性赋值名 / JSX 什么的
function contextOf(node) {
  let cur = node.parent;
  while (cur) {
    if (ts.isCallExpression(cur)) return cur.expression.getText().split("\n")[0].slice(0, 40) + "()";
    if (ts.isPropertyAssignment(cur)) return "prop:" + cur.name.getText().slice(0, 30);
    if (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken)
      return "assign:" + cur.left.getText().split("\n")[0].slice(0, 40);
    if (ts.isVariableDeclaration(cur)) return "var:" + cur.name.getText().slice(0, 30);
    if (ts.isReturnStatement(cur)) return "return";
    cur = cur.parent;
  }
  return "?";
}

const hits = [];
for (const file of walk(join(ROOT, "src"))) {
  const rel = relative(ROOT, file);
  if (SKIP_FILES.has(rel)) continue;
  const src = readFileSync(file, "utf8");
  if (!CJK.test(src)) continue;
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, /*parents*/ true);
  const visit = (node) => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && CJK.test(node.text)) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
      hits.push({ file: rel, line: line + 1, text: node.text, ctx: contextOf(node) });
    } else if (ts.isTemplateExpression(node)) {
      const full = node.getText();
      if (CJK.test(node.head.text) || node.templateSpans.some(s => CJK.test(s.literal.text))) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
        hits.push({ file: rel, line: line + 1, text: full.slice(0, 120), ctx: contextOf(node) });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const h of hits) {
  const t = h.text.replace(/\n/g, "\\n").slice(0, 100);
  console.log(`${h.file}:${h.line}\t[${h.ctx}]\t${t}`);
}
console.error(`total: ${hits.length}`);
