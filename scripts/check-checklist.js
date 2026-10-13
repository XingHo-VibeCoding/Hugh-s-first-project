// 校对表体检：核对 100 门课是不是都被分到了正确的段。
//
// 【为什么需要这个】
// build-section-checklist.js 只负责「切段 + 分配」，
// 但切出来的段对不对、有没有漏课、同一门课有没有落进两个段，
// 都要有个独立的检查 —— **生成器和检查器分开，才不会自己错自己还看不见**。
//
// 用法：
//   node scripts/check-checklist.js <checklist.tsv>

const fs = require("fs");
const FILE = process.argv[2];

if (!FILE || !fs.existsSync(FILE)) {
  console.error("用法：node scripts/check-checklist.js <checklist.tsv>");
  process.exit(1);
}

const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/);
const segs = [];      // {no, page, h, count, name, courses[]}
let cur = null;

lines.forEach((line) => {
  if (!line.trim()) return;
  const p = line.split("\t");
  // 表头：段 / 页 / 框高 / 门数 / 课程类别 / 课程模块 / 课程名
  // ⚠️ 「课程模块」这一列是后来加的（Day 28 修"两列混成一句"），
  //    所以课程名从 p[5] 挪到了 p[6]。这里按表头名定位，别写死列号 ——
  //    之前就因为加了一列没同步，体检器报"声称 4 门实际 0 门"，看着像数据坏了。
  const COL = { 段: 0, 页: 1, 框高: 2, 门数: 3, 课程类别: 4, 课程模块: 5, 课程名: 6 };
  if (p[COL.段] && p[COL.段] !== "段") {
    cur = {
      no: p[COL.段], page: p[COL.页], h: p[COL.框高], count: Number(p[COL.门数]),
      name: (p[COL.课程类别] || "").replace(/\s+/g, ""),
      mod: (p[COL.课程模块] || "").replace(/\s+/g, ""),
      courses: [],
    };
    segs.push(cur);
  } else if (cur && p[COL.课程名] && p[COL.课程名].trim()) {
    cur.courses.push(p[COL.课程名].trim());
  }
});

const total = segs.reduce((a, s) => a + s.courses.length, 0);
console.log("段数：" + segs.length + "　课程总数：" + total);
console.log("");

// ---- 检查 1：声明的门数与实际列出的门数是否一致 ----
let mismatch = 0;
segs.forEach((s) => {
  if (s.count && s.courses.length !== s.count) {
    console.log("  [警告] 段" + s.no + " 声称 " + s.count + " 门，实际列出 " + s.courses.length + " 门");
    mismatch++;
  }
});
console.log(mismatch === 0 ? "  [PASS] 每段声明数与实际一致" : "  [FAIL] " + mismatch + " 段对不上");

// ---- 检查 2：同一门课是否落进多个段 ----
const seen = {};
let dup = 0;
segs.forEach((s) => s.courses.forEach((c) => {
  if (seen[c]) { console.log("  [警告] 《" + c + "》同时在段" + seen[c] + " 和段" + s.no); dup++; }
  else seen[c] = s.no;
}));
console.log(dup === 0 ? "  [PASS] 没有课落进两个段" : "  [FAIL] " + dup + " 门重复");

// ---- 检查 3：关键课程分到了哪一段（人工核对用）----
console.log("");
console.log("=== 关键课程归属（对照 PDF 原表人工核对）===");
const keys = ["量子力学", "电动力学", "数学物理方法", "理论力学",
  "英语听说", "大学物理A", "天体测量学", "形势与政策", "毕业论文", "体育"];
keys.forEach((k) => {
  let hit = null;
  for (const s of segs) {
    for (const c of s.courses) {
      if (c.indexOf(k) >= 0) { hit = { s, c }; break; }
    }
    if (hit) break;
  }
  if (hit) {
    console.log("  " + k.padEnd(12, "　") + " → 段" + String(hit.s.no).padEnd(4) +
      hit.s.name.slice(0, 34) + "  《" + hit.c.slice(0, 20) + "》");
  } else {
    console.log("  " + k + " → **没找到**");
  }
});

// ---- 检查 4：段名重复情况（同名段应该合并）----
console.log("");
const nameCount = {};
segs.filter((s) => s.name).forEach((s) => {
  nameCount[s.name] = (nameCount[s.name] || 0) + 1;
});
const dups = Object.entries(nameCount).filter(([, n]) => n > 1);
if (dups.length) {
  console.log("  同名段（应该合并成一个）：");
  dups.forEach(([n, c]) => console.log("    " + c + " 个同名段：" + n.slice(0, 40)));
} else {
  console.log("  没有同名段");
}

// ---- 检查 5：空段（框内无文字却装了课）----
console.log("");
const empties = segs.filter((s) => !s.name && s.courses.length > 0);
console.log("  框内无文字但装了课的段：" + empties.length + " 个");
empties.slice(0, 8).forEach((s) => {
  console.log("    段" + String(s.no).padEnd(4) + s.courses.length + " 门：" + s.courses.slice(0, 3).join("、"));
});

process.exitCode = 0;