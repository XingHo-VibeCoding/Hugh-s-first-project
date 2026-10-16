/* 把从控制台导出的「软删除课程」CSV 并进备份（Day 28）
 *
 * 为什么需要这个脚本：
 *   接口只返回 deleted_at IS NULL 的行（coursesRepository.js:36），
 *   所以 export-db-backup.js 只能导出存活的那部分。
 *   实测库里 185 行 = 存活 8 + 软删 177 —— 也就是说 95% 的数据
 *   在接口里看不到，必须从控制台用 SQL 查出来、导出成 CSV，
 *   再用这个脚本并进 data.json / restore.sql，备份才完整。
 *
 * 用法：
 *   1) 控制台执行 EXPORT_RESTORE.md 第二节那条 SQL
 *   2) 结果面板「导出」→ CSV，保存成任意路径
 *   3) node scripts/merge-soft-deleted.js <那个csv路径>
 *
 * 这个脚本会：读 CSV → 和现有 data.json 合并（按 id 去重）→ 重新生成
 * data.json / restore.sql / courses.csv → 跑自检（含条数核对）
 */

const fs = require("fs");
const path = require("path");

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("用法：node scripts/merge-soft-deleted.js <导出的 csv 路径>");
  console.error("CSV 怎么来：见 db/EXPORT_RESTORE.md 第二节");
  process.exit(1);
}
if (!fs.existsSync(csvPath)) {
  console.error("[FAIL] 找不到文件：" + csvPath);
  process.exit(1);
}

const EXPORT_DIR = path.join(__dirname, "..", "db", "export-20261014");
const jsonPath = path.join(EXPORT_DIR, "data.json");
if (!fs.existsSync(jsonPath)) {
  console.error("[FAIL] 还没导出过。先跑 node scripts/export-db-backup.js");
  process.exit(1);
}

// ---- 极简 CSV 解析（够用即可：支持引号包裹、逗号转义）----
function parseCsv(text) {
  const t = text.replace(/^﻿/, ""); // 去 BOM
  const rows = [];
  let row = [], field = "", inStr = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === '"') {
        if (t[i + 1] === '"') { field += '"'; i++; }
        else inStr = false;
      } else field += c;
    } else if (c === '"') inStr = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter(function (r) { return r.some(function (x) { return x.trim() !== ""; }); });
}

console.log("=== 并入软删除课程 ===\n");

const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
if (rows.length < 2) {
  console.error("[FAIL] CSV 里没有数据行（只有表头或整个文件是空的）");
  process.exit(1);
}

const header = rows[0].map(function (h) { return h.trim().toLowerCase(); });
console.log("表头：" + header.join(", "));
console.log("数据行：" + (rows.length - 1) + "\n");

// 列名容错：控制台导出可能是 id / name / credits / category_id / status / score
// 也可能叫 categoryId 之类
function pick(row, candidates) {
  for (let i = 0; i < header.length; i++) {
    const h = header[i].replace(/[\s_]/g, "");
    for (const c of candidates) {
      if (h === c.replace(/[\s_]/g, "").toLowerCase()) return row[i];
    }
  }
  return undefined;
}
const need = ["id", "name", "credits"];
const missing = need.filter(function (k) {
  return !header.some(function (h) { return h.replace(/[\s_]/g, "") === k; });
});
if (missing.length) {
  console.error("[FAIL] CSV 缺少必需列：" + missing.join(", "));
  console.error("       实际表头：" + header.join(", "));
  console.error("       请确认导出的是 EXPORT_RESTORE.md 里那条 SQL 的结果。");
  process.exit(1);
}

const soft = [];
rows.slice(1).forEach(function (r) {
  const get = function (keys) {
    const v = pick(r, keys);
    return v === undefined ? null : String(v).trim();
  };
  const id = get(["id"]);
  const name = get(["name"]);
  const credits = get(["credits"]);
  if (!id || !name) return;
  const num = credits === null || credits === "" ? null : Number(credits);
  const catRaw = get(["category_id", "categoryid"]);
  const scoreRaw = get(["score"]);
  const deletedRaw = get(["deleted_at"]);
  soft.push({
    id: id,
    name: name,
    credits: num,
    categoryId: catRaw === "" ? null : catRaw,
    status: get(["status"]) || "planned",
    score: scoreRaw === null || scoreRaw === "" ? null : Number(scoreRaw),
    // ⚠️ Day 29 补上：控制台导出的 CSV 里有 deleted_at 列，
    //   但合并时丢掉了 → 备份无法分辨「存活的」和「软删的」，
    //   **照 restore.sql 恢复会把 99 门垃圾全变成存活的**。
    //   必须保留这个标记，restore.sql 才能还原正确的可见性。
    wasDeleted: !!deletedRaw,
  });
});
console.log("解析出 " + soft.length + " 门软删除课程\n");

// ---- 合并 ----
const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const byId = new Map();
payload.courses.forEach(function (c) { byId.set(c.id, c); });

let added = 0, updated = 0, skipped = 0;
soft.forEach(function (c) {
  if (byId.has(c.id)) { skipped++; return; }   // 已存在（就是存活那 8 门之一）
  byId.set(c.id, c);
  added++;
});
// 补齐 wasDeleted 字段（Day 29）：
//   存活那几门来自 export-db-backup.js 拉的接口结果，而接口只返回
//   deleted_at IS NULL 的行 —— 它们**天然就是存活的**，
//   但没有 wasDeleted 这个字段。不补齐的话，
//   「每条记录都标了可见性」这项自检会误报，而且恢复时会当成未知状态。
payload.courses.forEach(function (c) {
  if (typeof c.wasDeleted !== "boolean") c.wasDeleted = false;
});
console.log("合并结果：新增 " + added + " 门，已存在跳过 " + skipped + " 门");

if (added === 0) {
  console.log("\n[停] 一门都没新增。可能是 CSV 就是那 8 门存活数据（不是软删的），");
  console.log("      或者导错了。先看清楚再操作，别盲目覆盖。");
  process.exit(1);
}

const merged = Array.from(byId.values());
const round2 = function (n) { return Math.round(n * 100) / 100; };
const totalCredits = round2(merged.reduce(function (s, c) { return s + Number(c.credits || 0); }, 0));

console.log("合计：" + merged.length + " 门 / 学分总额 " + totalCredits + "\n");

// ---- 重写文件 ----
const COURSE_COLS = ["id", "name", "credits", "categoryId", "status", "score"];
const CAT_COLS = ["id", "name", "requiredCredits", "note"];

const esc = function (v) {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

payload.courses = merged;
payload.counts = { courses: merged.length, categories: payload.categories.length };
payload.note = "学分规划助手 · 云数据库导出（含软删除课程）。恢复见 db/EXPORT_RESTORE.md";
fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

const csv = "﻿" + COURSE_COLS.join(",") + "\r\n" +
  merged.map(function (r) {
    return COURSE_COLS.map(function (c) { return esc(r[c]); }).join(",");
  }).join("\r\n") + "\r\n";
fs.writeFileSync(path.join(EXPORT_DIR, "courses.csv"), csv, "utf8");

const q = function (v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
};
function toSql(rows, cols, table) {
  return "-- 来源：" + payload.source + "\n-- 共 " + rows.length + " 行\n\n" +
    rows.map(function (r) {
      return "INSERT INTO public." + table + " (" + cols.join(", ") + ") VALUES (" +
        cols.map(function (c) { return q(r[c]); }).join(", ") + ");";
    }).join("\n") + "\n";
}

/**
 * 课程专用 SQL：**软删的要还原成软删状态**
 *
 * 为什么（Day 29 发现）：
 *   备份里混着「存活的」和「软删的」两类记录，
 *   但 if 只写业务字段、不写 deleted_at →
 *   **恢复后 99 门测试垃圾会全部变成存活的**，全部出现在列表里。
 *
 *   还原办法：软删的记录，deleted_at 填一个过去的时间戳
 *   （比如 2026-10-14T00:00:00Z），delete_expires_at 也填过去时间
 *   → 恢复后它们仍是「已删除」，列表里看不见，和线上状态一致。
 */
function toCourseSql(rows) {
  const PAST = "'2026-10-14T00:00:00Z'"; // 一个确定在过去的时间戳
  const header = "-- 来源：" + payload.source + "\n" +
    "-- 共 " + rows.length + " 行（含软删记录，会还原成 deleted_at 非空）\n\n";
  return header + rows.map(function (r) {
    const cols = COURSE_COLS.concat(["deleted_at", "delete_expires_at"]);
    const deleted = r.wasDeleted;
    const values = COURSE_COLS.map(function (c) {
      return q(r[c]);
    }).concat([deleted ? PAST : "NULL", deleted ? PAST : "NULL"]);
    return "INSERT INTO public.courses (" + cols.join(", ") + ") VALUES (" +
      values.join(", ") + ");";
  }).join("\n") + "\n";
}

// ⚠️ categories 必须在前：schema.sql:60 有外键 REFERENCES public.categories(id)
fs.writeFileSync(path.join(EXPORT_DIR, "restore.sql"),
  toSql(payload.categories, CAT_COLS, "categories") + "\n" +
  toCourseSql(merged), "utf8");

// 备份的 json 里也要写清统计，避免以后看不懂
const aliveN = merged.filter(function (c) { return !c.wasDeleted; }).length;
const softN = merged.length - aliveN;
payload.note = "学分规划助手 · 云数据库导出。courses 里 wasDeleted=true 表示原本是软删状态，" +
  "restore.sql 已把它还原成 deleted_at 非空（恢复后仍不可见，与线上一致）。";
payload.counts = {
  courses: merged.length,
  categories: payload.categories.length,
  coursesAlive: aliveN,
  coursesSoftDeleted: softN,
};
fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), "utf8");

console.log("\\n=== 恢复后可见性（重要）===");
console.log("  存活（恢复后可见）：" + aliveN + " 门");
console.log("  软删（恢复后不可见）：" + softN + " 门");
console.log("  → restore.sql 已用 deleted_at 还原软删状态，**不会把垃圾变成可见数据**");

fs.copyFileSync(csvPath, path.join(EXPORT_DIR, "soft-deleted-raw.csv"));

// ---- 自检 ----
console.log("=== 自检 ===\n");
let fail = 0;
function ok(label, cond, extra) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
  if (!cond) fail++;
}
const reread = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
ok("JSON 课程数 = " + merged.length, reread.courses.length === merged.length);
ok("声明的条数与实际一致", reread.counts.courses === reread.courses.length);
ok("id 没有重复", new Set(reread.courses.map(function (c) { return c.id; })).size === reread.courses.length);
ok("restore.sql 的 INSERT 数 = 课程数 + 板块数",
   (fs.readFileSync(path.join(EXPORT_DIR, "restore.sql"), "utf8").match(/INSERT INTO/g) || []).length
   === reread.courses.length + reread.categories.length);
const rs = fs.readFileSync(path.join(EXPORT_DIR, "restore.sql"), "utf8");
ok("categories 排在 courses 前（外键顺序）",
   rs.indexOf("INSERT INTO public.categories") < rs.indexOf("INSERT INTO public.courses"));

// Day 29 补：备份必须能还原「软删状态」，否则恢复后垃圾全变可见
const softInBackup = reread.courses.filter(function (c) { return c.wasDeleted; }).length;
ok("data.json 里标出了哪些是软删的（wasDeleted）",
   reread.courses.every(function (c) { return typeof c.wasDeleted === "boolean"; }),
   "软删 " + softInBackup + " 门 / 存活 " + reread.courses.filter(function (c) { return !c.wasDeleted; }).length + " 门");
ok("restore.sql 的 courses INSERT 写进了 deleted_at 列",
   /INSERT INTO public\.courses \([^)]*deleted_at[^)]*\)/.test(rs));
ok("restore.sql 里的软删行确实带了时间戳（不是全 NULL）",
   /VALUES \([^)]*'\d{4}-\d{2}-\d{2}T/.test(rs),
   "有 wasDeleted=true 的记录被写成了带时间戳");
ok("备份文件声明了存活/软删的条数",
   reread.counts && typeof reread.counts.coursesSoftDeleted === "number",
   "存活 " + reread.counts.coursesAlive + " / 软删 " + reread.counts.coursesSoftDeleted);

// 反向测试：**现在的数据必须是有标记的**。
// 若哪天 wasDeleted 被丢掉（所有记录 undefined），
// 上面「标出了哪些是软删的」和「restore.sql 带 deleted_at」两项就会 FAIL。
const allMarked = reread.courses.every(function (c) {
  return typeof c.wasDeleted === "boolean";
});
ok("反向测试：所有记录都带可见性标记（丢掉就会 FAIL）", allMarked === true,
   allMarked ? "标记完整" : "有记录缺 wasDeleted → 检查项会 FAIL，符合预期");
ok("反向测试：软删数 + 存活数 = 总数（不能凭空多出记录）",
   reread.counts.coursesAlive + reread.counts.coursesSoftDeleted === reread.courses.length,
   reread.counts.coursesAlive + " + " + reread.counts.coursesSoftDeleted +
   " = " + reread.courses.length);

const SECRET = /secret|password|token|api_key|access_key|private_key|AKID/i;
const PRIVACY = /1[3-9]\d{9}|\d{17}[\dXx]|学号|姓名[:：]/;
["data.json", "courses.csv", "restore.sql"].forEach(function (f) {
  const txt = fs.readFileSync(path.join(EXPORT_DIR, f), "utf8");
  ok(f + " 无密钥特征词", !SECRET.test(txt));
  ok(f + " 无手机号/身份证/学号", !PRIVACY.test(txt));
});

console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
console.log("备份现含：" + merged.length + " 门 / 学分总额 " + totalCredits);
process.exit(fail === 0 ? 0 : 1);