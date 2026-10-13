/**
 * scripts/make-import-plan.js —— 生成「照着填」的导入操作单
 *
 * 【为什么要有这个】
 * 最终清单是「一行一门课」的表，94 行。
 * 但导入时要做两件事：**建 13 个板块** + **给 94 门课各选一个板块**。
 * 前者要板块名单，后者要「这个板块下有哪几门课」——
 * 一行一门课的表回答不了第二个问题，得来回翻。
 *
 * 所以这里按板块分组输出，一屏一个板块，照着抄。
 *
 * ⚠️ 顺带修一个**会让人填错**的坑：板块名里的「（大类）」是 PDF 原文的一部分，
 *   但建板块时如果手打成「学科基础必修课程」（少了前缀），
 *   后面 94 门课都会归错 —— **名字必须逐字照抄**。
 *   所以这份单里每个板块名旁边标了字数，方便核对。
 *
 * 用法：node scripts/make-import-plan.js
 */
const fs = require("fs");

const SRC = "C:/Users/w3224/Desktop/deploy/最终板块归属清单.tsv";
const OUT = "C:/Users/w3224/Desktop/deploy/导入操作单.txt";

const rows = fs.readFileSync(SRC, "utf8")
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .slice(1)
  .filter((l) => l.trim())
  .map((l) => l.split("\t"))
  .filter((r) => r[3] && r[3] !== "（丢弃）" && r[3] !== "（合并）");

// 按板块分组，课名去重
const groups = {};
rows.forEach((r) => {
  if (!groups[r[3]]) groups[r[3]] = [];
  const nm = r[4].trim();
  if (groups[r[3]].indexOf(nm) < 0) groups[r[3]].push(nm);
});

const names = Object.keys(groups).sort((a, b) => groups[b].length - groups[a].length);
const total = names.reduce((a, n) => a + groups[n].length, 0);

const L = [];
L.push("=".repeat(62));
L.push("  导入操作单 —— 按这个填，填 100% 对");
L.push("=".repeat(62));
L.push("");
L.push("总计 " + names.length + " 个板块 / " + total + " 门课");
L.push("");
L.push("⚠️ 板块名**逐字照抄**，包括括号里的字：");
L.push("   「（大类）学科基础必修课程」不能打成「学科基础必修课程」");
L.push("   「专业选修课程（天文数据处理方向）」的括号不能省");
L.push("   名字差一点，94 门课会全部归错板块。");
L.push("");
L.push("-".repeat(62));
L.push("  第一步：建这 " + names.length + " 个板块");
L.push("-".repeat(62));
L.push("");
L.push("板块页 → 添加板块 → 板块名填下面这个 → 要求学分先留空");
L.push("（要求学分那 13 个数字在最后一节，可选填）");
L.push("");
names.forEach((n, i) => {
  L.push("  " + String(i + 1).padStart(2) + ". " + n);
  L.push("      " + n.length + " 个字　共 " + groups[n].length + " 门课");
});
L.push("");
L.push("-".repeat(62));
L.push("  第二步：导入 PDF，在待确认表格里选板块");
L.push("-".repeat(62));
L.push("");
L.push("课程页 → 导入培养方案 → 拖入那个 PDF → 等表格出来");
L.push("表格每行都有「板块」下拉框，按下面各板块列出的课名对号入座。");
L.push("");
L.push("⚠️ 表里的课名可能和这里差一两个字（解析时把名字拆行/合并过），");
L.push("   对不上就找最像的那个。");
L.push("");

names.forEach((n, i) => {
  L.push("─".repeat(60));
  L.push("【" + (i + 1) + "/" + names.length + "】" + n + "　（" + groups[n].length + " 门）");
  L.push("─".repeat(60));
  groups[n].forEach((c, j) => {
    L.push("  " + String(j + 1).padStart(2) + ". " + c);
  });
  L.push("");
});

L.push("-".repeat(62));
L.push("  第三步：核对（导入后看这几行）");
L.push("-".repeat(62));
L.push("");
L.push("导入完成提示里应写：");
L.push("  · 「已导入 XX 门课程」 —— XX 应该接近 " + total);
L.push("  · **不该有「跳过 N 门」** —— 有就说明有课名重了或学分不对");
L.push("  · 「其中 N 门没归到板块」 —— N 应该 = 你故意留空的数（一般 0）");
L.push("");
L.push("然后到课程页核对门数：");
names.forEach((n) => {
  L.push("  " + String(groups[n].length).padStart(3) + " 门  " + n);
});
L.push("");
L.push("-".repeat(62));
L.push("  可选：各板块的要求学分（PDF 原文里有的）");
L.push("-".repeat(62));
L.push("");
L.push("培养方案里明确写了要求学分的有：");
L.push("  通识教育必修课程组（一）  …… 38");
L.push("  专业核心课程             …… 27");
L.push("  （大类）学科基础必修课程 …… 32");
L.push("  综合实践课程             …… 14");
L.push("  拓展教育课程             …… 4");
L.push("  新生研讨课程             …… 2");
L.push("");
L.push("其余板块原文写的是范围（如 0-11）或没写，可以留空。");
L.push("留空不影响功能，只是概览页不算缺口。");
L.push("");

fs.writeFileSync(OUT, "﻿" + L.join("\n"), "utf8");
console.log("已写出 " + OUT);
console.log(names.length + " 个板块 / " + total + " 门课");
console.log("\n=== 板块清单（照抄这些名字）===");
names.forEach((n, i) => console.log("  " + (i + 1) + ". " + n + "　" + groups[n].length + " 门"));