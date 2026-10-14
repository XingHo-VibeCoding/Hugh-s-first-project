/* 导出云数据库备份（Day 27 第 4 项要求）
 *
 * 为什么需要这个脚本：
 *   快照表 courses_bak_20261013 在**数据库里**，
 *   环境真没了它跟着一起没 —— 它不是备份，只是「同一台机器上的另一份拷贝」。
 *   11-01 环境到期、已决定不续费 → 真正能救命的只有**导出到本地的文件**。
 *
 * 这个脚本做什么：
 *   1. 调线上接口把 courses / categories 全量拉下来
 *   2. 落成 3 种格式：JSON（完整，恢复用）、CSV（人可读，给同学看）、SQL（可直接灌回数据库）
 *   3. 自检：条数、学分总额、字段完整性，并搜索密钥特征词
 *
 * 用法：node scripts/export-db-backup.js
 */

const fs = require("fs");
const https = require("https");
const path = require("path");

const BASE = process.env.API_BASE ||
  "https://my-first-project-d2epfvu0373796b.service.tcloudbase.com";
const OUT_DIR = process.env.OUT_DIR ||
  path.join(__dirname, "..", "db", "export-20261014");

function req(route) {
  return new Promise(function (resolve, reject) {
    const url = new URL(BASE + "/api/" + route + "?limit=500");
    https.get(url, function (res) {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { raw += c; });
      res.on("end", function () {
        if (res.statusCode !== 200) {
          return reject(new Error(route + " → HTTP " + res.statusCode + " " + raw.slice(0, 120)));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(route + " 响应不是 JSON：" + raw.slice(0, 120))); }
      });
    }).on("error", reject);
  });
}

// CSV 的字段顺序固定，便于人和 Excel 都能读
const COURSE_COLS = ["id", "name", "credits", "categoryId", "status", "score"];
const CAT_COLS = ["id", "name", "requiredCredits", "note"];

function toCsv(rows, cols) {
  const esc = function (v) {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "﻿" + cols.join(",") + "\r\n" +      // BOM：Excel 打开中文不乱码
    rows.map(function (r) { return cols.map(function (c) { return esc(r[c]); }).join(","); }).join("\r\n") +
    "\r\n";
}

function toSql(rows, cols, table) {
  const q = function (v) {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number") return String(v);
    return "'" + String(v).replace(/'/g, "''") + "'";
  };
  const colsSql = cols.join(", ");
  const lines = rows.map(function (r) {
    return "INSERT INTO public." + table + " (" + colsSql + ") VALUES (" +
      cols.map(function (c) { return q(r[c]); }).join(", ") + ");";
  });
  return "-- 由 scripts/export-db-backup.js 自动生成\n" +
    "-- 来源：" + BASE + "\n" +
    "-- 生成时间：" + new Date().toISOString() + "\n" +
    "-- 共 " + rows.length + " 行\n" +
    "-- 用法：先建表（见 db/schema.sql），再执行本文件\n\n" +
    lines.join("\n") + "\n";
}

function round2(n) { return Math.round(n * 100) / 100; }

(async function main() {
  console.log("=== 导出云数据库备份 ===\n");
  console.log("接口：" + BASE + "\n");

  let courses, cats;
  try {
    const c = await req("courses");
    const k = await req("categories");
    courses = c.data || [];
    cats = k.data || [];
  } catch (e) {
    console.error("[FAIL] 拉数据失败：" + e.message);
    console.error("       接口地址可能变了，或网络不通。先确认再跑。");
    process.exit(1);
    return;
  }

  console.log("拉到：课程 " + courses.length + " 门 / 板块 " + cats.length + " 个\n");

  if (courses.length === 0) {
    console.error("[FAIL] 一门课都没拉到 —— 不生成空备份（空文件比没文件更危险）");
    process.exit(1);
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 1. JSON（完整，恢复用）----
  const jsonPath = path.join(OUT_DIR, "data.json");
  const payload = {
    exportedAt: new Date().toISOString(),
    source: BASE,
    note: "学分规划助手 · 云数据库导出。恢复见 db/EXPORT_RESTORE.md",
    counts: { courses: courses.length, categories: cats.length },
    categories: cats,
    courses: courses,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");
  console.log("已写 data.json");

  // ---- 2. CSV（人可读）----
  const cCsv = path.join(OUT_DIR, "courses.csv");
  const kCsv = path.join(OUT_DIR, "categories.csv");
  fs.writeFileSync(cCsv, toCsv(courses, COURSE_COLS), "utf8");
  fs.writeFileSync(kCsv, toCsv(cats, CAT_COLS), "utf8");
  console.log("已写 courses.csv / categories.csv");

  // ---- 3. SQL（可直接灌回）----
  // ⚠️ 顺序必须是 categories 先、courses 后。
  //   因为 schema.sql:60 有 `category_id ... REFERENCES public.categories(id)`，
  //   先插 courses 会撞外键报错，恢复直接失败。
  //   Day 27 的 BACKUP.md 里也写过这条，但这个脚本是新写的，得自己保证。
  const cSql = path.join(OUT_DIR, "restore.sql");
  const sql = toSql(cats, CAT_COLS, "categories") + "\n" +
    toSql(courses, COURSE_COLS, "courses");
  fs.writeFileSync(cSql, sql, "utf8");
  console.log("已写 restore.sql（categories 在前，保证外键顺序正确）");

  // ---- 4. 自检 ----
  console.log("\n=== 自检 ===\n");
  let fail = 0;
  function ok(label, cond, extra) {
    console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
    if (!cond) fail++;
  }

  // ---- 4.0 ⚠️ 最重要的一条：接口返回的条数够不够代表整个库？----
  //
  // 踩过的坑（Day 27 → Day 28）：
  //   接口 coursesRepository.js:36 只返回 `deleted_at IS NULL` 的行。
  //   所以「接口返回 8 门」≠「库里只有 8 门」——
  //   实测库里 185 行，其中 177 行是软删除的，接口一件都不返回。
  //
  //   如果不查这一条，就会把「8 门的备份」当成「159 门的备份」提交，
  //   以为有保险，其实 94% 的数据没备份 —— **这比没备份更危险**。
  //
  // 这里没法从接口知道库里总共多少行（接口不提供 count），
  // 所以改成：把这个数字写进文档，导出结果里显式带上说明，
  // 并在恢复手册里把「软删的行导不出来」写成醒目的已知限制。
  console.log("⚠️ 重要限制：接口只返回 deleted_at IS NULL 的行（软删除的导不出来）");
  console.log("   实测：库内 185 行 = 存活 8 + 软删 177；本次导出只含存活的这 " +
    courses.length + " 门。");
  console.log("   软删的 177 门要另外从控制台用 SQL 导出，见 db/EXPORT_RESTORE.md。\n");

  const round = round2(courses.reduce(function (s, c) { return s + Number(c.credits || 0); }, 0));
  const doneCredits = round2(courses.filter(function (c) { return c.status === "done"; })
    .reduce(function (s, c) { return s + Number(c.credits || 0); }, 0));
  const noCat = courses.filter(function (c) { return !c.categoryId; }).length;

  console.log("课程 " + courses.length + " 门（其中已修 " +
    courses.filter(function (c) { return c.status === "done"; }).length + " 门）");
  console.log("学分总额 " + round + "（已修部分 " + doneCredits + "）");
  console.log("未归板块 " + noCat + " 门\n");

  ok("课程条数 > 0", courses.length > 0, courses.length + " 门");
  ok("JSON 里条数和拉取数一致",
     JSON.parse(fs.readFileSync(jsonPath, "utf8")).courses.length === courses.length);
  ok("CSV 行数 = 课程数 + 1 行表头",
     toCsv(courses, COURSE_COLS).trim().split(/\r\n/).length === courses.length + 1);
  ok("SQL 里 INSERT 语句数 = 课程数 + 板块数",
     (sql.match(/INSERT INTO/g) || []).length === courses.length + cats.length);

  // 恢复能不能真的跑通，关键在顺序：categories 必须排在 courses 前面
  // （schema.sql 里 category_id 有 REFERENCES public.categories(id)）
  const firstCat = sql.indexOf("INSERT INTO public.categories");
  const firstCourse = sql.indexOf("INSERT INTO public.courses");
  ok("SQL 里 categories 排在 courses 前面（外键顺序，不排会恢复失败）",
     firstCat !== -1 && firstCourse !== -1 && firstCat < firstCourse);
  ok("每门课都有名字", courses.every(function (c) { return !!c.name; }));
  ok("每门课都有学分", courses.every(function (c) { return c.credits !== null && c.credits !== undefined; }));

  // ---- 门数对不对：这是人工在控制台实测过的数字 ----
  //
  // 环境事实（2026-10-14 控制台实测）：
  //   courses 表共 185 行 = 存活 8 + 软删 177
  //   courses_bak_20261013 快照表 159 行
  // 所以接口最多只能返回 8 行。哪天突然返回几十上百行，
  // 要么软删机制变了、要么查错了表 —— 都要重新核实，不能默认是对的。
  const KNOWN_LIVE = Number(process.env.KNOWN_LIVE || 8);
  ok("导出条数与控制台实测存活数一致（应 " + KNOWN_LIVE + "）",
     courses.length === KNOWN_LIVE,
     "实际 " + courses.length + " 门");
  if (courses.length !== KNOWN_LIVE) {
    console.log("    ⚠️ 与实测不符。**不要直接把这份当完整备份**，");
    console.log("       先查清库里现在多少行、软删策略是否变了。");
    fail++;
  }

  // 关键安全项：文件里不能出现密钥
  const SECRET = /secret|password|token|api_key|access_key|private_key|AKID/i;
  const files = ["data.json", "courses.csv", "categories.csv", "restore.sql"];
  let secretHit = 0;
  files.forEach(function (f) {
    const txt = fs.readFileSync(path.join(OUT_DIR, f), "utf8");
    if (SECRET.test(txt)) { secretHit++; console.log("    ⚠️ " + f + " 命中密钥特征词"); }
  });
  ok("4 个文件搜密钥特征词 → 0 命中", secretHit === 0);

  // 隐私：这批数据是课程表，不该出现姓名/学号/手机号
  const PRIVACY = /1[3-9]\d{9}|\d{17}[\dXx]|学号|姓名[:：]/;
  let privacyHit = 0;
  files.forEach(function (f) {
    if (PRIVACY.test(fs.readFileSync(path.join(OUT_DIR, f), "utf8"))) {
      privacyHit++;
      console.log("    ⚠️ " + f + " 疑似含个人信息");
    }
  });
  ok("4 个文件搜手机号/身份证/学号 → 0 命中", privacyHit === 0);

  // ---- 5. 反向测试：把顺序写反，那条检查项必须 FAIL ----
  const reversed = toSql(courses, COURSE_COLS, "courses") + "\n" + toSql(cats, CAT_COLS, "categories");
  const rCat = reversed.indexOf("INSERT INTO public.categories");
  const rCourse = reversed.indexOf("INSERT INTO public.courses");
  ok("反向测试：顺序写反时会被上面那条检查项抓住",
     rCat !== -1 && rCourse !== -1 && !(rCat < rCourse));

  console.log("\n输出目录：" + OUT_DIR);
  files.forEach(function (f) {
    const st = fs.statSync(path.join(OUT_DIR, f));
    console.log("  " + f + "　" + st.size + " 字节");
  });

  console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
  process.exit(fail === 0 ? 0 : 1);
})();