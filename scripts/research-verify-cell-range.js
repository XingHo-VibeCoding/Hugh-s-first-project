/* 研究：组名单元格的纵向范围能不能圈出属于它的课程行？
 *
 * 【这是「框线路线」的决定性验证】
 *   前面已确认：
 *     · 列边界能从框线拿到（第7列=模块、第10列=组名、第12列=课程名、第14列=课程号）
 *     · 第10列（组名列）的竖线 x=141/142 和 x=176 是它的左右边界
 *
 *   现在要验证最后一环：
 *     **在第10列里，每个组名文字被哪些横线夹住？**
 *     夹住它的上边线+下边线之间，就是这个合并单元格覆盖的 y 范围；
 *     课程行落在哪个区间，就属于哪个组。
 *
 *   这一步能成 → 方法成立；不能 → 这条路也封死。
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

// 第4页的列边界（从上次分析得出），后续页可能不同 → 每页都重新算
console.log("=== 逐步验证：每页的列结构 + 组名单元格范围 ===\n");

const COL = { module: 6, section: 9, name: 11 }; // 0-based 列序号（第7/10/12列）

let totalChecked = 0, totalRight = 0;

g.pages.forEach(function (pg) {
  const bounds = pg.vLines.map((c) => c.x);
  if (bounds.length < 15) {
    console.log("第" + pg.pageNo + " 页：竖线不足（" + bounds.length + " 条），跳过\n");
    return;
  }

  // --- 1. 找出第10列（组名列）里的横线：只有覆盖该列 x 范围的才算 ---
  const secL = bounds[COL.section], secR = bounds[COL.section + 1];
  const secH = pg.hLines.filter(function (r) {
    return r.xs.some(function (s) { return s[0] <= secL + 1 && s[1] >= secR - 1; });
  });

  // --- 2. 第12列（课程名列）里的横线 ---
  const nameL = bounds[COL.name], nameR = bounds[COL.name + 1];
  const nameH = pg.hLines.filter(function (r) {
    return r.xs.some(function (s) { return s[0] <= nameL + 1 && s[1] >= nameR - 1; });
  });

  // --- 3. 组名列里的文字 ---
  const secTexts = pg.texts.filter(function (t) {
    return t.x >= secL && t.x < secR && t.s.length >= 3;
  });
  const nameTexts = pg.texts.filter(function (t) {
    return t.x >= nameL && t.x < nameR;
  });

  console.log("第" + pg.pageNo + " 页：列边界[" + secL + "~" + secR + "]=" + secTexts.length +
    " 段组名文字 / [" + nameL + "~" + nameR + "]=" + nameTexts.length + " 条课程名" +
    " | 该列横线 " + secH.length + " 条");

  if (!secTexts.length || !nameH.length) {
    console.log("  （该页组名列没有文字，跳过）\n");
    return;
  }

  // --- 4. 每个组名文字：被哪两条横线夹住 ---
  //      y 递减 = 从上往下，所以上边线 = y 更大的那条
  const sortedH = secH.map((r) => r.y).sort((a, b) => b - a);
  console.log("  组名 → 所属 y 区间（由横线夹逼）:");
  secTexts.forEach(function (t) {
    const above = sortedH.filter((y) => y > t.y + 0.5);
    const below = sortedH.filter((y) => y < t.y - 0.5);
    const top = above.length ? Math.min.apply(null, above) : null;   // 上边线
    const bot = below.length ? Math.max.apply(null, below) : null;   // 下边线
    // 区间内的课程行数
    const inRange = nameTexts.filter(function (n) {
      return top !== null && bot !== null && n.y <= top && n.y >= bot;
    });
    console.log("    " + t.s.slice(0, 22).padEnd(24) +
      " y=" + String(t.y).padStart(6) +
      "  区间[" + String(top).padStart(6) + " ~ " + String(bot).padStart(6) + "]" +
      "  区间内课程 " + inRange.length + " 门");
  });

  // --- 5. 拿这个区间去判定课程归属，对照真值 ---
  const rule = secTexts.map(function (t) {
    const above = sortedH.filter((y) => y > t.y + 0.5);
    const below = sortedH.filter((y) => y < t.y - 0.5);
    return {
      text: t.s, y: t.y,
      top: above.length ? Math.min.apply(null, above) : null,
      bot: below.length ? Math.max.apply(null, below) : null,
    };
  });
  // 组名本身可能是一格多段，取匹配真值最长的那段
  const named = rule.filter(function (r) {
    return truthNames.some(function (t) { return norm(t).indexOf(norm(r.text)) === 0; });
  });

  let right = 0, checked = 0;
  nameTexts.forEach(function (n) {
    const nm = norm(n.s);
    if (!nm) return;
    const truth = truthOf.get(nm);
    if (!truth) return;      // 只评真值里有的课
    checked++;
    // 规则：从上往下，最后一个「区间包含这行」且名字匹配的组名
    let hit = null;
    for (const r of named) {
      if (r.top === null || r.bot === null) continue;
      if (n.y <= r.top + 0.5 && n.y >= r.bot - 0.5) hit = r;
    }
    if (hit) {
      const cn = named.reduce(function (acc, r) {
        const m = truthNames.filter(function (t) { return norm(t).indexOf(norm(r.text)) === 0; })
          .sort(function (a, b) { return norm(b).length - norm(a).length; })[0];
        return m || acc;
      }, "");
      if (norm(cn) === norm(truth)) right++;
    }
  });
  if (checked) {
    console.log("  → 本页对照真值：" + right + " / " + checked +
      " 正确（" + (checked ? Math.round(right / checked * 100) : 0) + "%）");
    totalChecked += checked; totalRight += right;
  }
  console.log("");
});

console.log("=== 总计 ===");
console.log("  " + totalRight + " / " + totalChecked +
  " 正确 = " + (totalChecked ? Math.round(totalRight / totalChecked * 100) : 0) + "%");
console.log("  （当前基线 65.3%，真值法 100%）");