/* 研究：验证「组名 → 其后连续课程行」这个假设
 *
 * 【关键观察（第4页坐标数据给出的事实）】
 *   y=160.1  x=174.4  专业核心课程     ← 组名
 *   y=160.1  x=228.4  (要求学           ← 同一个 y！同一合并单元格里
 *   课程行 x=226.5（课程名列）：
 *     y=192.5  80002 / y=203.3
 *     y=221.4  60006
 *     ...
 *
 *   也就是说：**组名和「要求学分:xx」在同一行**，
 *   课程行在组名的【下方】连续出现，直到下一个组名。
 *
 * 【但这里有个必须验证的风险】
 *   第4页 y 从 160（专业核心课程）往上到 727（高能天体数据处理）
 *   中间只有 4 个组名：
 *     160.1 专业核心课程
 *     246.6 新生研讨课程
 *     289.9 通识教育选修课程
 *     349.6 通识教育必修课程组（二）
 *   而课程行有 20+ 行（y=192.5 ~ 727.5）。
 *
 *   → 如果「组名管到下一个组名为止」，
 *     专业核心课程 就要管 160→246（只有 3 门），
 *     而 289→349 之间的行归通识教育选修课程（0 门），
 *     349 以下一直到 727 全归「通识教育必修课程组（二）」（20+ 门）——
 *     **这显然不对**。
 *
 *   所以「上下找最近组名」注定错，**必须换思路**。
 *   但在下结论前，先把数据全量算一遍，看看错的规律到底是什么。
 *
 * 这个脚本只做统计，不改生产代码。
 */

const fs = require("fs");
const path = require("path");

const raw = JSON.parse(fs.readFileSync(
  path.join(__dirname, "research-coords-dump.json"), "utf8"));
const TRUTH = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "db", "truth-curriculum.json"), "utf8"));

// 组名表：真值里的板块名
const truthNames = TRUTH.cats.map((c) => c.name);
function norm(s) {
  return String(s || "").replace(/\s+/g, "")
    .replace(/[（]/g, "(").replace(/[）]/g, ")")
    .replace(/“|”/g, '"').replace(/：/g, ":").trim();
}
const truthNorm = new Set(truthNames.map(norm));

// 真值：课程名 → 板块
const truthOf = new Map();
TRUTH.cats.forEach((c) => {
  (c.courses || []).forEach((n) => truthOf.set(norm(n), c.name));
});

console.log("=== 组名在 PDF 里的 x 坐标聚类 ===\n");

// 找所有「含已知板块名」的文字项
const hits = [];
raw.pages.forEach((pg) => {
  pg.items.forEach((it) => {
    const n = norm(it.s);
    if (!n) return;
    // 逐个板块名做包含匹配（PDF 可能把名字拆成多段）
    for (const t of truthNames) {
      const tn = norm(t);
      if (n === tn || (tn.length >= 4 && tn.indexOf(n) === 0 && n.length >= 4)) {
        hits.push({ page: pg.pageNo, x: it.x, y: it.y, s: it.s, truth: t, exact: n === tn });
        break;
      }
    }
  });
});

hits.sort((a, b) => a.page - b.page || a.y - b.y);
console.log("找到 " + hits.length + " 处组名文字：\n");

// 按 x 聚类
const xs = hits.map((h) => h.x).sort((a, b) => a - b);
const clusters = [];
let cur = [xs[0]];
for (let i = 1; i < xs.length; i++) {
  if (xs[i] - cur[cur.length - 1] <= 6) cur.push(xs[i]);
  else { clusters.push(cur); cur = [xs[i]]; }
}
console.log("x 聚类结果（间距≤6 算一簇）：");
clusters.forEach((c) => {
  const avg = (c.reduce((a, b) => a + b, 0) / c.length).toFixed(1);
  const n = hits.filter((h) => c.some((v) => Math.abs(v - h.x) < 7)).length;
  console.log("  x≈" + String(avg).padStart(6) + "　" + n + " 处　范围 " +
    Math.min.apply(null, c) + "~" + Math.max.apply(null, c));
});

console.log("\n=== 组名出现位置（按页+y 排序）===\n");
hits.forEach((h) => {
  console.log("  第" + h.page + "页  y=" + String(h.y).padStart(6) +
    " x=" + String(h.x).padStart(6) + "  " + h.s +
    (h.exact ? "" : "  ← 不完全匹配，真值：" + h.truth));
});

// 统计：每个板块名被找到几次
console.log("\n=== 14 个板块各被 PDF 原文提及几次 ===\n");
truthNames.forEach((t) => {
  const n = hits.filter((h) => h.truth === t).length;
  console.log((n ? "  ✓" : "  ✗") + " " + String(n).padStart(2) + " 次  " + t);
});

const missing = truthNames.filter((t) => hits.filter((h) => h.truth === t).length === 0);
console.log("\n⚠️ 完全没在 PDF 里找到的板块（" + missing.length + " 个）：");
missing.forEach((m) => console.log("  " + m));