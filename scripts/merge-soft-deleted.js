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
  soft.push({
    id: id,
    name: name,
    credits: num,
    categoryId: catRaw === "" ? null : catRaw,
    status: get(["status"]) || "planned",
    score: scoreRaw === null || scoreRaw === "" ? null : Number(scoreRaw),
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
// ⚠️ categories 必须在前：schema.sql:60 有外键 REFERENCES public.categories(id)
fs.writeFileSync(path.join(EXPORT_DIR, "restore.sql"),
  toSql(payload.categories, CAT_COLS, "categories") + "\n" +
  toSql(merged, COURSE_COLS, "courses"), "utf8");

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