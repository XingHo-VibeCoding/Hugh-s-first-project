/**
 * scripts/make-section-sheet.js —— 把校对表整理成「一页看完」的操作单
 *
 * 【为什么要有这个】
 * checklist.tsv 是机器输出，人看很费劲：
 * ① 组名会串（两段文字拼一起）
 * ② 有些「课程名」根本不是课程名，是培养方案里的说明文字
 *    （实测：「循序渐进培养学生的科学素养，提高科研能力。」被当成课名）
 * ③ 有的段一个候选都没有（组名没读到）
 *
 * 这个脚本把每段的**候选板块全列出来**（不猜、不做启发式判断），
 * 你看一眼就能定。同时把明显不是课名的行标出来。
 *
 * 用法：node scripts/make-section-sheet.js <checklist.tsv> <输出.csv>
 */
const fs = require("fs");

const IN = process.argv[2] || "C:/Users/w3224/Desktop/deploy/checklist.tsv";
const OUT = process.argv[3] || "C:/Users/w3224/Desktop/deploy/板块归属对照表.csv";

// 培养方案里出现过的板块名（照抄 PDF，不自己编）
const KNOWN = [
  "（大类）学科基础必修课程",
  "专业核心课程",
  "通识教育必修课程组（一）",
  "通识教育必修课程组（二）",
  "通识教育选择性必修课程组",
  "通识教育选修课程",
  "新生研讨课程",
  "综合实践课程",
  "拓展教育课程",
  "专业选修课程（天文数据处理方向）",
  "专业选修课程（天文实验与实践方向）",
  "专业选修课程（天体物理与理论方向）",
];

// 判断「这行是不是真的课程」—— 课程名不会有这些
// ⚠️ 只用来「提示需要看一眼」，不自动删除：宁可多标也不误删
const NOT_COURSE = /[，。；、]|以及|能力|学生|培养|了解|相关|研究前沿|过程中|同时|能够|领域|意义|目的/;

function parse(path) {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  const segs = [];
  let cur = null;
  lines.forEach((l) => {
    const p = l.split("\t");
    if (p[0] && p[0] !== "段" && p[1]) {
      cur = { page: p[1], h: p[2], n: Number(p[3]), raw: p[4] || "", mod: p[5] || "", courses: [] };
      segs.push(cur);
    } else if (cur && p[6] && p[6].trim()) {
      cur.courses.push(p[6].trim().replace(/\s+/g, " "));
    }
  });
  return segs;
}

const segs = parse(IN);
const rows = [];
let fakeCount = 0;

segs.forEach((s, i) => {
  // 候选 = 原文里出现过的已知板块名（**全部列出，不挑一个**）
  const cands = KNOWN.filter((k) => s.raw.indexOf(k) >= 0);
  // 明显不是课名的行
  const fakes = s.courses.filter((c) => c.length > 24 || NOT_COURSE.test(c));
  fakeCount += fakes.length;

  rows.push({
    no: i + 1,
    page: s.page,
    n: s.n,
    cands,
    fakes,
    courses: s.courses,
    raw: s.raw,
  });
});

const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';

const out = [];
out.push(["段", "页", "门数", "候选板块（自己挑一个；只有一个就直接用）", "该段课程（/ 分隔）", "要留意的行"].map(q).join(","));
rows.forEach((r) => {
  out.push([
    r.no,
    r.page,
    r.n,
    q(r.cands.length ? r.cands.join("  |  ") : "⚠ 原文读不出，请看 PDF"),
    q(r.courses.join(" / ")),
    q(r.fakes.length ? "⚠ 有 " + r.fakes.length + " 行不像课名：" + r.fakes.map((f) => f.slice(0, 26)).join(" ／ ") : ""),
  ].join(","));
});

fs.writeFileSync(OUT, "﻿" + out.join("\n"), "utf8");

console.log("已写出 " + OUT);
console.log("段数 " + rows.length + "，课程 " + rows.reduce((a, r) => a + r.courses.length, 0));
console.log("需要留意的非课名行：" + fakeCount);
console.log("");
console.log("=== 逐段一览 ===");
rows.forEach((r) => {
  const c = r.cands.length ? r.cands.join(" | ") : "⚠ 读不出";
  const flag = r.fakes.length ? "  ⚠" + r.fakes.length + "行非课名" : "";
  console.log(
    "  段" + String(r.no).padStart(2) +
    "｜" + r.page + "页｜" + String(r.n).padStart(2) + "门｜" +
    c.slice(0, 58) + flag
  );
});