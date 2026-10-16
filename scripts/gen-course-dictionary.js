/* 生成课程名词典（Day 29）
 *
 * 【为什么做这个】
 *   自动识别板块 65.3% 已证明做不到（见「板块自动识别-失败根因研究.md」）。
 *   但真值集里本来就有「100 门课 → 14 个板块」的对应关系，
 *   这份数据不该浪费 —— 拿它做**建议**，比让人凭记忆选快得多，也比乱猜准。
 *
 * 【关键设计：为什么只给建议、不自动填】
 *   词典里的板块名（「专业选修课程（天文数据处理方向）」）
 *   和用户数据库里的板块名（「专业选修」）**根本不是一套**。
 *   如果按名字自动填，会把方向信息丢掉 —— 而方向正是用户需要的。
 *   → 所以：**只在匹配得上时给建议，让用户点一下。**
 *
 * 输出：db/course-dictionary.js
 *   —— 直接给浏览器用的 JS 文件（不用 fetch，省一个请求）
 */

const fs = require("fs");
const path = require("path");

const TRUTH_PATH = path.join(__dirname, "..", "db", "truth-curriculum.json");
const OUT_PATH = path.join(__dirname, "..", "db", "course-dictionary.js");

const truth = JSON.parse(fs.readFileSync(TRUTH_PATH, "utf8"));

// ---------- 归一化：让「大学物理A：热学」和「大学物理A：热学 」也能对上 ----------
function norm(s) {
  return String(s || "")
    .replace(/\s+/g, "")
    .replace(/[（]/g, "(").replace(/[）]/g, ")")
    .replace(/[【]/g, "[").replace(/[】]/g, "]")
    .replace(/[：]/g, ":")
    .replace(/[“]/g, '"').replace(/[”]/g, '"')
    .replace(/[，]/g, ",").replace(/[、]/g, ",")
    .replace(/[。]/g, ".")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
    })
    .toLowerCase()
    .trim();
}

// ---------- 建词典 ----------
// 结构： { 归一化课程名: [板块名, 板块名...] }   （数组是因为可能同名多板块）
const dict = {};
const nameToSections = {};
let dupName = 0;

truth.cats.forEach(function (cat) {
  nameToSections[cat.name] = (cat.courses || []).length;
  (cat.courses || []).forEach(function (courseName) {
    const k = norm(courseName);
    if (!k) return;
    if (!dict[k]) { dict[k] = []; dupName = 0; }
    if (dict[k].indexOf(cat.name) === -1) dict[k].push(cat.name);
  });
});

// 统计同名出现在多个板块的情况（要在界面上提示歧义）
let ambiguous = 0;
Object.keys(dict).forEach(function (k) {
  if (dict[k].length > 1) ambiguous++;
});

const totalNames = Object.keys(dict).length;
const totalCourses = Object.values(dict).reduce((s, a) => s + a.length, 0);

console.log("=== 生成课程名词典 ===\n");
console.log("来源：" + path.basename(TRUTH_PATH));
console.log("板块数：" + truth.cats.length);
console.log("课程条目（去重后）：" + totalNames);
console.log("课程-板块关系数：" + totalCourses);
console.log("同名多板块（歧义）：" + ambiguous + " 条\n");

// ---------- 生成 JS 文件 ----------
const js = `/* 课程名词典（自动生成，勿手改）
 *
 * 数据来源：db/truth-curriculum.json（${truth.generatedFrom || "学员亲手整理"}）
 * 生成脚本：scripts/gen-course-dictionary.js
 * 生成时间：${new Date().toISOString()}
 *
 * 【怎么用】
 *   1. 用户在课程表单输入课程名
 *   2. 用 CourseDictionary.suggest(输入的课程名) 查
 *   3. 命中就显示建议板块名，**由用户点一下采纳**，不自动填
 *
 * 【为什么不自动填】
 *   词典里的板块名是培养方案原文（如「专业选修课程（天文数据处理方向）」），
 *   用户自己建的板块名可能不同（如「专业选修」）。
 *   自动填会把方向信息丢掉 —— 而方向恰恰是用户需要的。
 *   → 只给建议，不猜。
 *
 * 数据量：${totalNames} 条课程 / ${truth.cats.length} 个板块
 */
window.CourseDictionary = (function () {
  var MAP = ${JSON.stringify(dict, null, 0)};
  var SECTIONS = ${JSON.stringify(nameToSections, null, 0)};

  function norm(s) {
    return String(s || "")
      .replace(/\\s+/g, "")
      .replace(/（/g, "(").replace(/）/g, ")")
      .replace(/【/g, "[").replace(/】/g, "]")
      .replace(/：/g, ":")
      .replace(/“/g, '"').replace(/”/g, '"')
      .replace(/，/g, ",").replace(/、/g, ",")
      .replace(/。/g, ".")
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) {
        return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
      })
      .toLowerCase()
      .trim();
  }

  /**
   * 按课程名查建议板块。
   * @returns {{hit:boolean, sections:string[], ambiguous:boolean}}
   *   hit=false 表示词典里没有这门课 —— 界面上什么都不显示
   */
  function suggest(courseName) {
    var key = norm(courseName);
    if (!key) return { hit: false, sections: [], ambiguous: false };
    var found = MAP[key];
    if (!found) return { hit: false, sections: [], ambiguous: false };
    return { hit: true, sections: found, ambiguous: found.length > 1 };
  }

  return {
    suggest: suggest,
    norm: norm,
    size: Object.keys(MAP).length,
    sections: SECTIONS,
  };
})();
`;

fs.writeFileSync(OUT_PATH, js, "utf8");
console.log("已生成：" + OUT_PATH);
console.log("大小：" + fs.statSync(OUT_PATH).size + " 字节");

// ---------- 自检 ----------
console.log("\n=== 自检 ===\n");
let fail = 0;
function ok(label, cond, extra) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
  if (!cond) fail++;
}

// 用 vm 跑一遍生成的 JS，验证它真的能用
const vm = require("vm");
const sandbox = { window: {} };
vm.createContext(sandbox);
vm.runInContext(js, sandbox);
const CD = sandbox.window.CourseDictionary;

ok("生成的 JS 能加载", !!CD);
ok("size 与词典条目数一致", CD && CD.size === totalNames, CD ? CD.size + "" : "无");
ok("sections 覆盖所有板块", CD && Object.keys(CD.sections).length === truth.cats.length,
   CD ? Object.keys(CD.sections).length + " 个" : "");

// 拿真值集里的课程名去查，必须都能查到
let miss = 0;
const samples = [];
truth.cats.forEach(function (cat) {
  (cat.courses || []).forEach(function (n) {
    const r = CD.suggest(n);
    if (!r.hit) { miss++; if (samples.length < 3) samples.push(n); }
    else if (r.sections.indexOf(cat.name) === -1 && !r.ambiguous) {
      miss++; if (samples.length < 3) samples.push(n + " → " + r.sections.join("/"));
    }
  });
});
ok("真值集里全部 100 门课都能查到，且能查到对应板块", miss === 0,
   miss === 0 ? "" : "查不到 " + miss + " 门：" + samples.join(" | "));

// 容错测试
ok("输入空字符串 → 不命中（不报错）", CD.suggest("").hit === false);
ok("输入不存在的课 → 不命中", CD.suggest("这门课词典里没有xyz").hit === false);
ok("输入 null → 不命中（不崩）", CD.suggest(null).hit === false);

// 归一化测试：加空格、换全角括号、加空格，都应该能对上
const probe = "  量子力学A  ";
ok("归一化：带空格的课程名也能查到", CD.suggest(probe).hit, probe);

console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
process.exit(fail === 0 ? 0 : 1);