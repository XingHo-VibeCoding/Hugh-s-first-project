// 校验 truth-2025.js：查重名、学分总和、分组要求学分是否对得上
const T = require("./truth-2025.js");

const ALL = [];
Object.keys(T).forEach((g) => {
  T[g].forEach(([name, credits]) => ALL.push({ g, name, credits }));
});

console.log("课程总数：" + ALL.length + "（不含通识选修与个性发展）\n");

// 1) 查重复
const seen = new Map();
const dup = [];
ALL.forEach((c) => {
  if (seen.has(c.name)) dup.push(c.name + "（" + seen.get(c.name) + " 与 " + c.g + "）");
  else seen.set(c.name, c.g);
});
console.log("重复课程：" + (dup.length ? "\n  " + dup.join("\n  ") : "无"));

// 2) 各组学分合计 vs 文档要求
const REQUIRED = { g1: 38, g2: 3.5, g3: 8, g4: 2, m1: 36, m2: 27, m3: 18, m4: 14 };
console.log("\n各组学分合计 vs 文档要求：");
Object.keys(REQUIRED).forEach((g) => {
  const sum = T[g].reduce((a, [, c]) => a + c, 0);
  const req = REQUIRED[g];
  const mark = Math.abs(sum - req) < 0.01 ? "一致" : "不一致";
  console.log("  " + g + "：" + sum.toFixed(2) + " / 要求 " + req + "  → " + mark +
    (Math.abs(sum - req) >= 0.01 ? "（差 " + (sum - req).toFixed(2) + "）" : ""));
});

// 3) 总学分
const total = ALL.reduce((a, c) => a + c.credits, 0);
console.log("\n总学分：" + total.toFixed(2) + "｜文档声明 148.5 → 差 " + (total - 148.5).toFixed(2));