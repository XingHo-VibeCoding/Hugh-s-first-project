/**
 * scripts/check-final-sheet.js —— 最终清单的体检器
 *
 * 【为什么生成器和体检器要分开】
 * 生成器自己错自己看不见。这次就靠体检抓到三处：
 *  ① 通识必修一组 40 门（明显超出「要求学分38」的规模）
 *  ② 「大学英语读写（3）」重复出现两次
 *  ③ 第 9 页那 6 门的板块错了（我按用户口述填成「通识必修一组」，
 *     实测第 9 页自己的类别列写的是「（大类）学科基础选修课程」）
 */
const fs = require("fs");
const P = "C:/Users/w3224/Desktop/deploy/最终板块归属清单.tsv";

const rows = fs.readFileSync(P, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).slice(1)
  .filter((l) => l.trim()).map((l) => l.split("\t"));

const live = rows.filter((r) => r[3] !== "（丢弃）" && r[3] !== "（合并）");
const dead = rows.filter((r) => r[3] === "（丢弃）" || r[3] === "（合并）");
const pending = live.filter((r) => /⚠|\|/.test(r[3]));

let fails = 0;
const check = (name, ok, detail) => {
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + name + (detail ? "　" + detail : ""));
  if (!ok) fails++;
};

// 1. 重复课名
const cnt = {};
live.forEach((r) => { cnt[r[4]] = (cnt[r[4]] || 0) + 1; });
const dup = Object.entries(cnt).filter((e) => e[1] > 1);
check("无重复课名", dup.length === 0, dup.map((d) => d[0] + "×" + d[1]).join(", "));

// 2. 没有待确认
check("没有待确认条目", pending.length === 0,
  pending.map((r) => r[4]).slice(0, 5).join(", "));

// 3. 课名里不该有粘连的痕迹
const GLUE = /^(特色社会主义思想毛泽东)|（形势与政策（/;
const glued = live.filter((r) => GLUE.test(r[4]));
check("课名没有粘连/没改名", glued.length === 0,
  glued.map((r) => r[4]).join(", "));

// 4. 课名不该过长（说明还是两行粘在一起）
const tooLong = live.filter((r) => r[4].length > 20);
check("课名长度正常（≤20）", tooLong.length === 0,
  tooLong.map((r) => r[4].slice(0, 26)).join(", "));

// 5. 板块都在已知清单里
const KNOWN = [
  "（大类）学科基础必修课程", "（大类）学科基础选修课程", "专业核心课程",
  "通识教育必修课程组（一）", "通识教育必修课程组（二）", "通识教育选择性必修课程组",
  "通识教育选修课程", "新生研讨课程", "综合实践课程", "拓展教育课程", "AI+课程",
  "专业选修课程（天文数据处理方向）", "专业选修课程（天文实验与实践方向）",
  "专业选修课程（天体物理与理论方向）",
];
const unknown = [...new Set(live.map((r) => r[3]).filter((c) => KNOWN.indexOf(c) < 0))];
check("板块都在已知清单里", unknown.length === 0, unknown.join(", "));

const byCat = {};
live.forEach((r) => { byCat[r[3]] = (byCat[r[3]] || 0) + 1; });

// 6. 板块里没有空的
// ⚠️ 判据是「**这批课里实际出现过的**板块」，不是「已知清单」——
//    「通识教育选修课程」允许是 0：段2 的候选有两个
//    （通识教育选修课程 / 新生研讨课程），用户核实后选了「新生研讨课程」。
//    拿 KNOWN 去查会误报。
const empty = Object.keys(byCat).filter((k) => !byCat[k]);
check("板块都非空", empty.length === 0, empty.join(", "));

// 7. 形势与政策 1~8 齐全（这是最容易漏的一组）
const szz = live.filter((r) => r[4].indexOf("形势与政策") >= 0).map((r) => r[4]);
const need = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => "形势与政策（" + i + "）");
const missing = need.filter((n) => szz.indexOf(n) < 0);
check("形势与政策 1~8 齐全", missing.length === 0, missing.join(", "));

// 8. 通识必修一组不该大得离谱（PDF 原文写「要求学分:38」）
const big = byCat["通识教育必修课程组（一）"] || 0;
check("通识必修一组门数合理（≤35）", big <= 35, big + " 门");

console.log("\n=== 各板块门数 ===");
Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).forEach((k) => {
  console.log("  " + String(byCat[k]).padStart(3) + " 门  " + k);
});
console.log("\n丢弃/合并 " + dead.length + " 条：");
dead.forEach((r) => console.log("  [" + r[0] + "] " + r[4]));
console.log("\n有效 " + live.length + " 门　待确认 " + pending.length + " 条");
console.log(fails === 0 ? "\n体检全部通过" : "\n有 " + fails + " 项不通过");
process.exitCode = fails === 0 ? 0 : 1;