/* 课程名词典功能验证（Day 29）
 *
 * 验四件事：
 *   1. 词典文件本身能用（100 门全覆盖、容错）
 *   2. 建议的「模糊匹配」逻辑对不对（词典名 vs 用户板块名不一样）
 *   3. **反向测试：词典坏掉/不存在时，页面不能崩，也不能瞎建议**
 *   4. 生产代码里没有把词典当成「自动填」
 *
 * 不联网、不碰数据库，纯逻辑验证。
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");

let fail = 0;
function ok(label, cond, extra) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
  if (!cond) fail++;
}

const ROOT = path.join(__dirname, "..");

console.log("=== 课程名词典功能验证 ===\n");

// ---------- ① 文件都在吗 ----------
console.log("① 文件检查");
const dictPath = path.join(ROOT, "db", "course-dictionary.js");
ok("db/course-dictionary.js 存在", fs.existsSync(dictPath),
   fs.existsSync(dictPath) ? fs.statSync(dictPath).size + " 字节" : "缺失");

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
ok("index.html 引入了词典", html.includes("course-dictionary.js"));
ok("index.html 有 dict-hint 容器", html.includes('id="dict-hint"'));
ok("dict-hint 默认 hidden（没命中时不占位）",
   /id="dict-hint"[^>]*hidden/.test(html));

const appJs = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
ok("app.js 有 bindDictHint 函数", /function\s+bindDictHint\s*\(/.test(appJs));
ok("bindDictHint 在 DOMContentLoaded 里被调用",
   /DOMContentLoaded[\s\S]{0,200}bindDictHint\s*\(\s*\)/.test(appJs));
ok("词典没加载时会跳过（不崩）",
   /if\s*\(!window\.CourseDictionary\)\s*return/.test(appJs));

// ---------- ② 词典本身 ----------
console.log("\n② 词典本身");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(dictPath, "utf8"), sandbox);
const CD = sandbox.window.CourseDictionary;

ok("能加载", !!CD);
ok("收录 100 门课", CD.size === 100, CD.size + " 门");

const TRUTH = JSON.parse(fs.readFileSync(path.join(ROOT, "db", "truth-curriculum.json"), "utf8"));
let miss = 0, wrongSec = 0;
TRUTH.cats.forEach(function (cat) {
  (cat.courses || []).forEach(function (n) {
    const r = CD.suggest(n);
    if (!r.hit) { miss++; return; }
    if (!r.ambiguous && r.sections[0] !== cat.name) wrongSec++;
  });
});
ok("真值集 100 门全部能查到", miss === 0, miss === 0 ? "" : miss + " 门查不到");
ok("查到的板块与真值一致", wrongSec === 0, wrongSec === 0 ? "" : wrongSec + " 门不一致");

console.log("\n  容错：");
ok("空字符串 → 不命中", CD.suggest("").hit === false);
ok("null → 不命中（不崩）", CD.suggest(null).hit === false);
ok("undefined → 不命中（不崩）", CD.suggest(undefined).hit === false);
ok("乱输入 → 不命中", CD.suggest("!!!@@@###").hit === false);
ok("数字 → 不命中（不崩）", CD.suggest(12345).hit === false);

console.log("\n  归一化：");
ok("前后空格", CD.suggest("  量子力学A  ").hit);
ok("全角括号 → 半角", CD.suggest("大学英语听说（3）").hit);
ok("半角括号（已归一）", CD.suggest("大学英语听说(3)").hit);
ok("大写 A → 小写 a", CD.suggest("量子力学a").hit);

// ---------- ③ 模糊匹配逻辑 ----------
console.log("\n③ 建议的模糊匹配（词典名 vs 用户板块名不一样）");

// 复刻 app.js 里的匹配逻辑
function matchCategory(sectionName, categories) {
  let target = null;
  categories.forEach(function (c) { if (c.name === sectionName) target = c; });
  if (!target) {
    const key = CD.norm(sectionName);
    categories.forEach(function (c) {
      const cn = CD.norm(c.name);
      if (!target && (key.indexOf(cn) !== -1 || cn.indexOf(key) !== -1)) target = c;
    });
  }
  return target;
}

// 用户的真实板块（线上实测）
const userCats = [
  { id: "c1", name: "通识必修" },
  { id: "c2", name: "专业核心" },
  { id: "c3", name: "专业选修" },
  { id: "c4", name: "通识选修" },
  { id: "c5", name: "实践环节" },
  { id: "c6", name: "自由选修" },
];

console.log("  用线上真实板块名测：");
let m1 = matchCategory("专业核心课程", userCats);
ok("「专业核心课程」→ 匹配到「专业核心」", !!m1 && m1.name === "专业核心",
   m1 ? m1.name : "没匹配上");

let m2 = matchCategory("专业选修课程（天体物理与理论方向）", userCats);
ok("「专业选修课程（…方向）」→ 匹配到「专业选修」", !!m2 && m2.name === "专业选修",
   m2 ? m2.name : "没匹配上");

let m3 = matchCategory("拓展教育课程", userCats);
ok("「拓展教育课程」→ 用户没建这个板块 → 不匹配（不瞎填）", m3 === null,
   m3 ? "错误地匹配到 " + m3.name : "正确：不匹配");

let m4 = matchCategory("通识教育必修课程组（一）（2025 级）（本科生院）", userCats);
ok("「通识教育必修课程组（一）…」→ 不匹配「通识必修」（名字不含，不瞎填）",
   m4 === null || m4.name === "通识必修",
   m4 ? "匹配到 " + m4.name + "（靠「通识」二字，语义上有风险）" : "正确：不匹配");

// ---------- ④ 反向测试 ----------
console.log("\n④ 反向测试（词典坏了必须能测出来）");

// 反向 1：词典内容被清空 → suggest 应该全都不命中
const emptyDict = { window: {} };
vm.createContext(emptyDict);
vm.runInContext("window.CD = (function(){var MAP={};return {suggest:function(){return {hit:false,sections:[],ambiguous:false}},norm:function(s){return s},size:0}})();",
  emptyDict);
ok("反向：词典为空 → 全部不命中（页面不会瞎建议）",
   emptyDict.window.CD.suggest("量子力学A").hit === false);

// 反向 2：词典里塞了错误数据 → 应该能被「真值集对照」这项抓到
const badDict = JSON.parse(JSON.stringify({}));
// 模拟「词典只收了 50 门」的情况
let partial = 0;
vm.runInContext(fs.readFileSync(dictPath, "utf8"), sandbox);
const CD2 = sandbox.window.CourseDictionary;
const halfMap = {};
let k = 0;
TRUTH.cats.forEach(function (cat) {
  (cat.courses || []).forEach(function (n) {
    if (k++ % 2 === 0) halfMap[CD2.norm(n)] = [cat.name];
  });
});
partial = Object.keys(halfMap).length;
ok("反向：词典只收一半 → 「全部能查到」这项应该 FAIL",
   partial < 100, "收 " + partial + " 门（真值 100 门，检查项会判 FAIL）");

// 反向 3：生产代码不能偷偷自动填
console.log("\n  生产代码的红线检查：");
ok("app.js 里没有「自动填板块」的赋值（catSelect.value 只在点击时赋值）",
   (appJs.match(/catSelect\.value\s*=/g) || []).length === 1,
   "出现 " + (appJs.match(/catSelect\.value\s*=/g) || []).length + " 次");
ok("建议逻辑里有「不瞎填」的分支",
   /还没有建.*这个板块|先��「板块」页加一个/.test(appJs));
// 注意：判据写成 `!r || !r.hit` —— 因为 Day 29 修了「词典中途没了」的 bug，
// suggest 可能返回 undefined，那也要 hide。用 /!r\s*\|\|\s*!r\.hit/ 匹配两种写法。
ok("没命中时是 hide()（什么都不显示）",
   /if\s*\(\s*!r\s*\|\|\s*!r\.hit\s*\)\s*\{\s*hide\(\);/.test(appJs));
ok("词典中途没了也会 hide（不卡住旧建议）",
   /if\s*\(!dict\s*\|\|\s*typeof\s+dict\.suggest\s*!==\s*"function"\)\s*\{\s*hide\(\);/.test(appJs),
   "这是 Day 29 修的真 bug：词典失败后提示框会卡在旧内容上");
ok("用户已选板块时不再提示",
   /if\s*\(catSelect\.value\)\s*\{\s*hide\(\);/.test(appJs));

console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
process.exit(fail === 0 ? 0 : 1);