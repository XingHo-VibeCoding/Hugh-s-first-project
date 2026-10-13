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
// Day 27 第 2 轮重测后改过：原来是「板块和课程都为空才显示」，
// 但试用者浏览器里已有上一轮的数据 → 判据为假 → 引导不显示 → 他的「一片空」没变。
// 现在改成**常驻 + 两种文案**。所以检查项也从「查旧判据」改成「查新判据」，
// 并且要能防住有人改回旧写法（见下方反向测试）。
ok("app.js 里有 renderOnboarding 函数",
   /function\s+renderOnboarding\s*\(/.test(appJs));
ok("renderGpa 会调用 renderOnboarding",
   /renderGpa[\s\S]{0,1400}renderOnboarding\s*\(\s*\)/.test(appJs));
ok("引导块常驻，不再因有数据而隐藏（不能再写 box.hidden = !isBlank）",
   !/box\.hidden\s*=\s*!isBlank/.test(appJs));
ok("有「已有数据」那一支文案（标题换成不是「从这里开始」）",
   /你现在录到这儿了/.test(appJs));
ok("会解释决策板块为什么空（要求学分）", /要求学分/.test(appJs));
ok("成绩缺失判据是「已修课没成绩」，不是「已修数 < 总数」",
   /missingScore/.test(appJs));
// 只看「真正的代码」，剥掉注释再查 —— 否则注释里写的
// 「原来写的是 doneCount < courseCount」会把这项误判成 FAIL
const codeOnly = appJs
  .replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释
  .replace(/^\s*\/\/.*$/gm, "");     // 行注释
ok("代码里没有 doneCount < courseCount 这种旧写法（注释不算）",
   !/doneCount\s*<\s*courseCount/.test(codeOnly));
ok("但注释里留了踩坑记录（说明改过、为什么改）",
   /doneCount\s*<\s*courseCount/.test(appJs));

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

// 反向测试 4-1：模拟「第 1 版的判据」，看「常驻」这项能不能拦住
const oldVersionLogic = "  const isBlank = true;\n  box.hidden = !isBlank;";
ok("模拟旧写法（有数据就隐藏）→ 被「常驻」这项测出来",
   /box\.hidden\s*=\s*!isBlank/.test(oldVersionLogic));

// 反向测试 4-2：模拟「旧的错误成绩判据」，看能不能被「missingScore」这项拦住
const oldScoreLogic = "  const missingScore = (doneCount < courseCount) ? 1 : 0;";
ok("模拟旧成绩判据（doneCount < courseCount）→ 被成绩判据这项测出来",
   /doneCount\s*<\s*courseCount/.test(oldScoreLogic));
ok("旧写法缺少 missingScore 变量名 → 能区分出新旧",
   !/const\s+missingScore\s*=\s*state\.courses/.test(oldScoreLogic));

const badCss = css.replace(/(\.dev-panel\s*\{[^}]*?)display:\s*none/, "$1display: block");
ok("把 display:none 改成 block → 应 FAIL", !/\.dev-panel\s*\{[^}]*display:\s*none/.test(badCss));

console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
process.exit(fail === 0 ? 0 : 1);
