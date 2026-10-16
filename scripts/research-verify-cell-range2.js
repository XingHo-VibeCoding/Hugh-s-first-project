/* 研究（修正版）：按内容识别列，而不是按列号
 *
 * 【为什么必须改】
 *   上一版用「第7/10/12/14列」这种固定列号，结果：
 *     · 第 4 页 33 条竖线（含页眉杂线），第 5~9 页 23 条 —— 列号对不上
 *     · 第 5 页把「课程号列」当成了组名列
 *   → **列数每页不同，固定列号必然出错。**
 *
 * 【修正思路】
 *   不认「第几列」，改认「表头说它是什么」：
 *     表头出现「课程模块」→ 记下那列的 x 区间
 *     表头出现「课程类别」→ 记下那列的 x 区间
 *     ...
 *   但只有第 4 页有表头（其他页是续页）→ 表头可以**沿用到所有页**。
 *
 * 【真值】
 *   表格真实列（5~9 页一致）：
 *     0,35,42,49,56,77,85,120,197,254,339,388,431,473,516,551,587,622,658,693,729,764,799
 *   → 组名列 = [120~197]，课程名列 = [197~254]
 *   （第4页多出的 141/142/176/253/318/338/339 是页眉杂线，要滤掉）
 *
 * ⚠️ 只读，不改生产代码。
 */

const fs = require("fs");
const path = require("path");

const g = JSON.parse(fs.readFileSync(
  path.join(__dirname, "research-cell-grid.json"), "utf8"));
const TRUTH = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "db", "truth-curriculum.json"), "utf8"));

function norm(s) {
  return String(s || "").replace(/\s+/g, "")
    .replace(/[（]/g, "(").replace(/[）]/g, ")")
    .replace(/“|”/g, '"').replace(/：/g, ":").trim();
}
const truthNames = TRUTH.cats.map((c) => c.name);
const truthOf = new Map();
TRUTH.cats.forEach((c) => (c.courses || []).forEach((n) => truthOf.set(norm(n), c.name)));

// ---------- 找所有页共有的竖线（真列） ----------
// ⚠️ 要**排除列数异常的页**：第 3 页只有 6 条竖线（表格刚开头），
//   拿它求交集会把结果压成 1 条。判据：竖线数 < 15 的页不算表格页。
const TABLE_PAGES = g.pages.filter((p) => p.vLines.length >= 15);
console.log("=== 各页竖线数（<15 的不计入，可能不是完整表格页）===");
g.pages.forEach((p) => {
  const ok = p.vLines.length >= 15;
  console.log("  第" + String(p.pageNo).padStart(2) + " 页: " +
    String(p.vLines.length).padStart(3) + " 条 " + (ok ? "✓ 计入" : "✗ 排除"));
});

const perPage = TABLE_PAGES.map((p) => p.vLines.map((c) => c.x));
const common = perPage.reduce((acc, cur) =>
  acc.filter((x) => cur.some((y) => Math.abs(x - y) <= 1)), perPage[0] || []);
console.log("\n=== " + TABLE_PAGES.length + " 个表格页共有的竖线（= 表格真实列边界）===");
console.log("  数量: " + common.length);
console.log("  " + common.join(", ") + "\n");

if (common.length < 10) { console.log("共有的列太少，这页 PDF 结构异常"); process.exit(0); }

// ---------- 按表头认列（第4页有表头） ----------
const pg4 = g.pages.find((p) => p.pageNo === 4);
const bounds = common;
function colOf(x) {
  for (let i = 0; i < bounds.length - 1; i++) {
    if (x >= bounds[i] - 1 && x < bounds[i + 1]) return i;
  }
  return -1;
}
console.log("=== 第4页表头 → 列位置 ===");
const headerCols = {};
pg4.texts.filter((t) => t.y > 400 && t.y < 430).forEach((t) => {
  const ci = colOf(t.x);
  headerCols[norm(t.s)] = ci;
  console.log("  " + t.s.padEnd(10) + " x=" + String(t.x).padStart(6) +
    " → 第" + (ci + 1) + "列 [" + bounds[ci] + "~" + bounds[ci + 1] + "]");
});

const secCol = headerCols["课程类别"];
const nameCol = headerCols["课程名"];
console.log("\n组名列 = 第" + (secCol + 1) + "列 [" + bounds[secCol] + "~" + bounds[secCol + 1] + "]");
console.log("课程名列 = 第" + (nameCol + 1) + "列 [" + bounds[nameCol] + "~" + bounds[nameCol + 1] + "]\n");

if (secCol === undefined || nameCol === undefined) {
  console.log("表头没认出课程类别/课程名列，用 x 兜底");
}

// ---------- 逐页：用组名列的横线切出 y 区间 ----------
console.log("=== 每页：组名单元格 → 区间内课程 ===\n");

let total = 0, right = 0;
const perSection = {};

g.pages.forEach(function (pg) {
  const L = bounds[secCol], R = bounds[secCol + 1];
  const NL = bounds[nameCol], NR = bounds[nameCol + 1];

  // 组名列的横线：x 范围覆盖 [L,R]
  const secH = pg.hLines.filter((r) =>
    r.xs.some((s) => s[0] <= L + 1 && s[1] >= R - 1)).map((r) => r.y);
  // 课程名列的横线
  const nameH = pg.hLines.filter((r) =>
    r.xs.some((s) => s[0] <= NL + 1 && s[1] >= NR - 1)).map((r) => r.y);

  const secTexts = pg.texts.filter((t) => t.x >= L && t.x < R && t.s.length >= 3);
  const nameTexts = pg.texts.filter((t) => t.x >= NL && t.x < NR);

  if (!secTexts.length) { console.log("第" + pg.pageNo + " 页：组名列无文字\n"); return; }

  const hSorted = secH.slice().sort((a, b) => b - a); // y 递减 = 从上到下
  const nhSorted = nameH.slice().sort((a, b) => b - a);

  console.log("第" + pg.pageNo + " 页：组名列 " + secTexts.length +
    " 段文字，横线 " + hSorted.length + " 条，课程 " + nameTexts.length + " 条");

  // 逐个课程行：找它上下最近的横线 → 得到行区间 → 再找哪个组名文字在同一行区间
  nameTexts.forEach(function (n) {
    const nm = norm(n.s);
    if (!nm) return;
    const truth = truthOf.get(nm);
    if (!truth) return;
    total++;

    // 该课程行所在的行区间
    const above = nhSorted.filter((y) => y > n.y + 0.5);
    const below = nhSorted.filter((y) => y < n.y - 0.5);
    const rowTop = above.length ? Math.min.apply(null, above) : null;
    const rowBot = below.length ? Math.max.apply(null, below) : null;
    if (rowTop === null || rowBot === null) return;

    // 找与该行区间「重叠最多」的组名单元格
    let best = null, bestOv = -1;
    secTexts.forEach(function (t) {
      const a = hSorted.filter((y) => y > t.y + 0.5);
      const b = hSorted.filter((y) => y < t.y - 0.5);
      if (!a.length || !b.length) return;
      const top = Math.min.apply(null, a), bot = Math.max.apply(null, b);
      const ov = Math.min(top, rowTop) - Math.max(bot, rowBot);
      if (ov > bestOv) { bestOv = ov; best = { t: t, top: top, bot: bot }; }
    });

    if (best && bestOv > 0) {
      const cand = truthNames.filter((tn) => norm(tn).indexOf(norm(best.t.s)) === 0)
        .sort((a, b) => norm(b).length - norm(a).length)[0];
      if (cand) {
        perSection[cand] = (perSection[cand] || 0) + 1;
        if (norm(cand) === norm(truth)) {
          right++;
        }
      }
    }
  });
  console.log("");
});

console.log("=== 对照真值 ===");
console.log("  " + right + " / " + total + " 正确 = " +
  (total ? Math.round(right / total * 100) : 0) + "%");
console.log("  当前基线 65.3%");
console.log("\n各板块命中次数：");
Object.keys(perSection).sort().forEach((k) => {
  console.log("  " + String(perSection[k]).padStart(3) + " 次  " + k);
});