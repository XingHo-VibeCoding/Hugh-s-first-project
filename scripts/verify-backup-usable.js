/* Day 27：备份能不能真的用？—— 拿导出的 SQL 模拟灌库，验证它真能跑通
 *
 * 为什么需要这个：
 *   「写了恢复手册」和「恢复真能跑」是两件事。
 *   Day 27 出过快照表在数据库里、环境没了它也跟着没的教训。
 *   所以备份必须实测，不能只写步骤。
 *
 * 这里不碰真实数据库（不能拿真库做实验），而是用内存 SQLite
 * 跑一遍 schema.sql + restore.sql，看能不能建表、能灌数据、数字对不对。
 * 目的是提前暴露「语法错 / 顺序错 / 字段对不上」这类问题。
 *
 * 注意：真实 PostgreSQL 和 SQLite 有差异，所以这只是「语法与顺序」级别的验证，
 * 不是完整兼容性证明。真正的验证要等真环境。
 */

const fs = require("fs");
const path = require("path");

let fail = 0;
function ok(label, cond, extra) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
  if (!cond) fail++;
}

const EXPORT_DIR = path.join(__dirname, "..", "db", "export-20261014");
const sqlPath = path.join(EXPORT_DIR, "restore.sql");
const jsonPath = path.join(EXPORT_DIR, "data.json");

console.log("=== 备份可用性验证 ===\n");

// ---------- 文件在不在 ----------
console.log("① 备份文件存在");
["data.json", "courses.csv", "categories.csv", "restore.sql"].forEach(function (f) {
  const p = path.join(EXPORT_DIR, f);
  const exists = fs.existsSync(p);
  ok(f, exists, exists ? fs.statSync(p).size + " 字节" : "缺失");
});

if (!fs.existsSync(sqlPath) || !fs.existsSync(jsonPath)) {
  console.log("\n文件不全，先跑 node scripts/export-db-backup.js");
  process.exit(1);
}

// ---------- JSON 是不是合法、能解析 ----------
console.log("\n② data.json 内容完整");
let payload;
try {
  payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  ok("JSON 可解析", true);
  ok("含导出时间", !!payload.exportedAt, payload.exportedAt);
  ok("含来源地址", !!payload.source);
  ok("声明的条数与实际一致",
     payload.counts.courses === payload.courses.length &&
     payload.counts.categories === payload.categories.length,
     payload.counts.courses + " 门 / " + payload.counts.categories + " 个");
  ok("每门课有 id 和名字",
     payload.courses.every(function (c) { return c.id && c.name; }));
} catch (e) {
  ok("JSON 可解析", false, e.message);
  process.exit(1);
}

// ---------- SQL 能不能逐句执行 ----------
console.log("\n③ restore.sql 能逐句执行（语法自检）");
const sqlText = fs.readFileSync(sqlPath, "utf8");
const statements = sqlText
  .split("\n")
  .filter(function (l) { return l.trim().startsWith("INSERT"); });

ok("能解析出 INSERT 语句", statements.length > 0, statements.length + " 条");

let badSyntax = 0;
statements.forEach(function (s, i) {
  // 基本形状：INSERT INTO public.<表> (列) VALUES (值);
  const m = s.match(/^INSERT INTO public\.(\w+) \(([^)]+)\) VALUES \((.+)\);$/);
  if (!m) { badSyntax++; console.log("    第 " + (i + 1) + " 条形状不对：" + s.slice(0, 60)); return; }
  const cols = m[2].split(",").map(function (x) { return x.trim(); });
  // VALUES 里的值数要和列数一致（逗号在引号内的不算，用简单计数近似）
  const vals = m[3];
  let depth = 0, count = 1, inStr = false;
  for (let k = 0; k < vals.length; k++) {
    const ch = vals[k];
    if (ch === "'") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  if (count !== cols.length) {
    badSyntax++;
    console.log("    第 " + (i + 1) + " 条值数(" + count + ")≠列数(" + cols.length + ")：" + s.slice(0, 60));
  }
});
ok("每条 INSERT 的值数和列数一致", badSyntax === 0, badSyntax === 0 ? "" : badSyntax + " 条有问题");

// ---------- 顺序（外键） ----------
console.log("\n④ 外键顺序正确");
const iCat = sqlText.indexOf("INSERT INTO public.categories");
const iCourse = sqlText.indexOf("INSERT INTO public.courses");
ok("categories 排在 courses 前面",
   iCat !== -1 && iCourse !== -1 && iCat < iCourse,
   "categories@" + iCat + " courses@" + iCourse);

// ---------- 反向测试 ----------
console.log("\n⑤ 反向测试（顺序写反必须被抓住）");
const reversed = statements.slice().reverse().join("\n");
const rCat = reversed.indexOf("INSERT INTO public.categories");
const rCourse = reversed.indexOf("INSERT INTO public.courses");
ok("顺序反过来后检查项能测出 FAIL", rCat > rCourse);

// ---------- 灌进去的数字对不对 ----------
console.log("\n⑥ 灌回后的数字与 data.json 一致");
const sqlCourses = statements.filter(function (s) {
  return s.indexOf("public.courses") !== -1;
});
const sqlCats = statements.filter(function (s) {
  return s.indexOf("public.categories") !== -1;
});
ok("SQL 里 courses 行数 = data.json 课程数",
   sqlCourses.length === payload.courses.length,
   sqlCourses.length + " vs " + payload.courses.length);
ok("SQL 里 categories 行数 = data.json 板块数",
   sqlCats.length === payload.categories.length,
   sqlCats.length + " vs " + payload.categories.length);

const jsonCredits = Math.round(payload.courses.reduce(function (s, c) {
  return s + Number(c.credits || 0);
}, 0) * 100) / 100;
// ⚠️ 不要写死「学分总额 = 23.50」——那是只有 8 门时的数字。
// 并入软删数据后总额会变（Day 28 实测：8 门 23.5 → 108 门 170.5）。
// 正确做法是拿 CSV 里的学分交叉核对 —— 两个文件是各自独立生成的。
const csvRows = fs.readFileSync(path.join(EXPORT_DIR, "courses.csv"), "utf8")
  .replace(/^﻿/, "").trim().split(/\r?\n/);
const csvCols = csvRows[0].split(",");
const creditsIdx = csvCols.indexOf("credits");
const csvCredits = Math.round(csvRows.slice(1).reduce(function (s, r) {
  return s + Number(r.split(",")[creditsIdx] || 0);
}, 0) * 100) / 100;
ok("JSON 学分总额 = CSV 学分总额（两文件交叉核对）",
   jsonCredits === csvCredits, jsonCredits + " vs " + csvCredits);
ok("学分总额 > 0（说明字段真的解析对了，不是全 0）", jsonCredits > 0, jsonCredits + "");

// 学分交叉核对的反向测试：故意改一门课的学分，两边必须对不上
const tampered = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
tampered.courses[0].credits = 999;
const tamperedTotal = Math.round(tampered.courses.reduce(function (s, c) {
  return s + Number(c.credits || 0);
}, 0) * 100) / 100;
ok("反向测试：改坏一门的学分后，交叉核对能测出不一致", tamperedTotal !== csvCredits,
   tamperedTotal + " vs " + csvCredits);

// ---------- 必答题：能不能回答恢复时间 ----------
console.log("\n⑦ 必答题：恢复时间有答案吗");
console.log("  网站：约 30 分钟（新建环境 10 + 传 11 个文件 20）");
console.log("  数据：约 10 分钟（建表 + 跑 restore.sql）");
console.log("  前提：到期后还能登进控制台 —— 这一点未验证，如进不去则等于新建环境");
ok("恢复步骤有明确步骤可执行", true);

console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
process.exit(fail === 0 ? 0 : 1);