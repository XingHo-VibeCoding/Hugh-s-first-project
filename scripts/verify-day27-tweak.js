/* Day 27：新增的两处改动 —— 反向验证脚本
 *
 * 为什么要反向验证：
 *   「新增的检查项必须反向验证过」—— 只验「改对了」不够，
 *   还得故意做错一次，确认检查项能测出来。否则检查项等于摆设。
 *
 * 验三件事：
 *   1. app.js 语法正常（不然整个页面脚本都不跑）
 *   2. 新手引导只在「板块和课程都为空」时显示，有任何数据就隐藏
 *   3. 开发者工具默认隐藏，但 ?dev=1 / #dev 能打开（不能把自测工具弄丢）
 */

const fs = require("fs");

let fail = 0;
function ok(label, cond) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label);
  if (!cond) fail++;
}

console.log("=== Day 27 改动验证 ===\n");

// ---------- 1. 语法 ----------
console.log("① 语法");
let appJs = "";
try {
  appJs = fs.readFileSync("app.js", "utf8");
  new Function(appJs);
  ok("app.js 语法正常", true);
} catch (e) {
  ok("app.js 语法正常（" + e.message + "）", false);
}
let css = "", html = "";
try { css = fs.readFileSync("style.css", "utf8"); } catch (e) {}
try { html = fs.readFileSync("index.html", "utf8"); } catch (e) {}
ok("style.css 里 .dev-panel 有 display:none",
   /\.dev-panel\s*\{[^}]*display:\s*none/.test(css));
ok("style.css 里 .dev-panel.is-dev-visible 能覆盖回 block",
   /\.dev-panel\.is-dev-visible\s*\{[^}]*display:\s*block/.test(css));
ok("index.html 里有 id=onboarding 的容器",
   html.indexOf('id="onboarding"') !== -1);

// ---------- 2. 空态引导的判据 ----------
console.log("\n② 空态引导判据");
ok("app.js 里有 renderOnboarding 函数",
   /function\s+renderOnboarding\s*\(/.test(appJs));
ok("renderGpa 会调用 renderOnboarding",
   /renderGpa[\s\S]{0,900}renderOnboarding\s*\(\s*\)/.test(appJs));
ok("判据是「板块和课程都为空」",
   /categories\.length\s*===\s*0\s*&&\s*state\.courses\.length\s*===\s*0/.test(appJs));

// ---------- 3. dev 面板开关 ----------
console.log("\n③ 开发者工具开关");
ok("app.js 里有 initDevPanel 函数",
   /function\s+initDevPanel\s*\(/.test(appJs));
// 写法是：get("dev") 取出来存进 flag，再判断 flag === "1"。
// 不能只匹配 get("dev") === "1" 的字面形式，那样会误报 FAIL。
ok("取 ?dev= 参数", /URLSearchParams\([^)]*\)\.get\(\s*["']dev["']\s*\)/.test(appJs));
ok("参数值 1 才显示", /flag\s*===\s*["']1["']/.test(appJs));
ok("支持 #dev 锚点", /location\.hash\s*===\s*["']#dev["']/.test(appJs));
ok("DOMContentLoaded 里调用了 initDevPanel",
   /DOMContentLoaded[\s\S]{0,400}initDevPanel\s*\(\s*\)/.test(appJs));

// ---------- 4. 反向测试：故意写错，检查项必须 FAIL ----------
console.log("\n④ 反向测试（故意做错，确认上面几项真的能测出来）");
const badApp = appJs.replace(
  /state\.categories\.length\s*===\s*0\s*&&\s*state\.courses\.length\s*===\s*0/,
  "true"
);
const badCss = css.replace(/(\.dev-panel\s*\{[^}]*?)display:\s*none/, "$1display: block");
ok("把判据换成恒真 → 「判据是两者都为空」应 FAIL", !/categories\.length\s*===\s*0\s*&&\s*state\.courses\.length\s*===\s*0/.test(badApp));
ok("把 display:none 改成 block → 应 FAIL", !/\.dev-panel\s*\{[^}]*display:\s*none/.test(badCss));

console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
process.exit(fail === 0 ? 0 : 1);
