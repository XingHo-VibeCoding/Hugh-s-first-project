// 生成 MOCK_DATA_2 的新代码块（课程名与学分取自 PDF 原图核对结果）
// 保持原有的演示意图：已修约 2/3、计划修约 1/3，含不及格、免修、小数学分、未归类
const T = require("./truth-2025.js");

// 每个板块里，已修的门数（用于压页面的真实感）
// g1 通识必修（一）全修；g2 全修；g4 全修；m1/m2 大部分修；m3/m4 部分修
const DONE_COUNT = { g1: -1, g2: -1, g3: 0, g4: -1, m1: 12, m2: 6, m3: 8, m4: 7, x1: 0 };

// 不及格的成绩（原数据里作为「已修但没及格」的测试用例）
const FAIL_SCORES = { g1: ["中国近现代史纲要"], m1: ["高等数学A（1）"], m2: [] };
// 免修/高分
const HIGH_SCORES = new Set(["英语文学赏析", "大学英语读写（4）", "旅游文化交流英语", "体育（1）"]);

function makeScore(name, idx, isDone) {
  if (!isDone) return null;
  const fails = FAIL_SCORES;
  for (const g of Object.keys(fails)) {
    if (fails[g].includes(name)) return 45 + (idx % 3) * 5;   // 45/50/55 → 不及格
  }
  if (HIGH_SCORES.has(name)) return 95 - (idx % 3);
  // 其余在 62~92 之间浮动，看起来像真实分布
  return 62 + ((idx * 7) % 31);
}

const lines = [];
let n = 0;
let doneTotal = 0;
let plannedTotal = 0;

Object.keys(T).forEach((gid) => {
  const list = T[gid];
  const limit = DONE_COUNT[gid];
  list.forEach(([name, credits], i) => {
    let isDone;
    if (limit === -1) isDone = true;
    else isDone = i < limit;
    const score = makeScore(name, i, isDone);
    if (isDone) doneTotal++; else plannedTotal++;
    const catId = gid === "" ? "" : gid;
    const status = isDone ? "done" : "planned";
    lines.push(
      '    { id: "m2-' + n + '", name: "' + name + '", credits: ' + credits +
      ', categoryId: "' + catId + '", status: "' + status + '", score: ' +
      (score === null ? "null" : score) + " },"
    );
    n++;
  });
});

// 两条「原板块已删除」的用例，保留原数据里的设计（测未归类课程的处理）
lines.push('    { id: "m2-' + n + '", name: "通识类讲座（原板块已删除）", credits: 1, categoryId: "", status: "done", score: 82 },');
lines.push('    { id: "m2-' + (n + 1) + '", name: "跨院系研讨课（原板块已删除）", credits: 2, categoryId: "", status: "done", score: 74 }');

console.log("// 生成于 scripts/gen-mock2.js，依据 2025 版培养方案原图核对");
console.log("已修：" + doneTotal + "｜计划修：" + plannedTotal + "｜合计：" + (doneTotal + plannedTotal + 2));
console.log(lines.join("\n"));