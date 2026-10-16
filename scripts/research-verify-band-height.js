/* 研究（修正判据）：不用「文字落在横线上」，改用「文字落在两个横线之间」
 *
 * 【上一版验证方法错在哪】
 *   我找「最佳 offset 让文字落在横线上」，得到 32~61%，
 *   然后判为「无法对齐」。
 *   **但这个判据本身是错的** ——
 *   文字应该在**格子的中间**，框线在**格子的上下边界**，
 *   文字**本来就不该**落在框线上。
 *
 * 【正确的判据】
 *   对每个文字：找出它上下最近的横线 → 得到它所在的「行区间」。
 *   如果行高都接近 29（观察到的表格行高），说明**框线结构完整可用**。
 *
 * 【另一个更重要的判据】
 *   组名文字所在的「行区间」应该是**很高**的（合并单元格跨多行），
 *   而课程文字所在的是**正常行高**（约 29）。
 *   **如果这个差别能测出来 → 合并单元格就识别到了 → 方法成立。**
 *
 * 只读，不改生产代码。
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter((p) => fs.existsSync(p))[0];
if (!CHROME) { console.error("找不到 Chrome"); process.exit(1); }

const PDF = process.argv[2];
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

(async function () {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });
    await p.goto("http://127.0.0.1:" + (process.env.PORT || "8905"),
      { waitUntil: "domcontentloaded" });
    await p.addScriptTag({
      url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    });
    await new Promise((r) => setTimeout(r, 1500));

    const b64 = fs.readFileSync(PDF).toString("base64");
    const pages = await p.evaluate(async function (d) {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const L = window.pdfjsLib;
      const doc = await L.getDocument({ data: arr }).promise;
      const OPS = L.OPS;
      const res = [];
      for (let pn = 3; pn <= doc.numPages; pn++) {
        const page = await doc.getPage(pn);
        const ops = await page.getOperatorList();
        const H = [], V = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== OPS.constructPath) continue;
          const a = ops.argsArray[i];
          if (!Array.isArray(a)) continue;
          const sub = a[0] || [], co = a[1] || [];
          let cur = null;
          for (let k = 0; k < sub.length; k++) {
            const idx = k * 2;
            if (sub[k] === OPS.moveTo) cur = { x: co[idx], y: co[idx + 1] };
            else if (sub[k] === OPS.lineTo && cur) {
              const dx = Math.abs(co[idx] - cur.x), dy = Math.abs(co[idx + 1] - cur.y);
              const g = { x0: cur.x, y0: cur.y, x1: co[idx], y1: co[idx + 1] };
              if (dy < 0.6 && dx > 5) H.push({ y: (g.y0 + g.y1) / 2, x0: Math.min(g.x0, g.x1), x1: Math.max(g.x0, g.x1) });
              else if (dx < 0.6 && dy > 5) V.push({ x: (g.x0 + g.x1) / 2, y0: Math.min(g.y0, g.y1), y1: Math.max(g.y0, g.y1) });
              cur = { x: co[idx], y: co[idx + 1] };
            }
          }
        }
        const tc = await page.getTextContent();
        const texts = tc.items.filter((it) => it.str && it.str.trim())
          .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }));
        res.push({ pn: pn, H: H, V: V, texts: texts });
      }
      return res;
    }, b64);

    // ---- 找表格真实列 ----
    // ⚠️ 踩过的坑：用「各页共有竖线」求交集，结果只有 1 条。
    //   原因：不同页可能有**额外的**竖线（页眉杂线、续表边界），
    //   交集会把它们全滤掉。
    //   正确做法：**把所有页的竖线并起来，按 x 聚类**（容差 ±1），
    //   取「出现在 ≥3 个页面」的簇 = 表格的公共列。
    const TP = pages.filter((p) => p.V.length >= 15);
    const counter = new Map();
    TP.forEach(function (pg) {
      const seen = new Set();
      pg.V.forEach(function (v) {
        const x = Math.round(v.x);
        if (seen.has(x)) return;
        seen.add(x);
        // 找已有簇里最近的
        let target = null, bestD = 2;
        counter.forEach(function (cnt, k) {
          const d = Math.abs(k - x);
          if (d < bestD) { bestD = d; target = k; }
        });
        if (target === null) counter.set(x, 1);
        else counter.set(target, cnt(target) + 1);
      });
    });
    function cnt(k) { return counter.get(k); }
    const common = [];
    counter.forEach(function (n, x) { if (n >= 3) common.push(x); });
    common.sort((a, c) => a - c);
    console.log("=== 表格真实列（出现在 ≥" + 3 + " 个页面的竖线，共 " +
      common.length + " 条）===");
    console.log("  " + common.join(", ") + "\n");

    if (common.length < 10) {
      console.log("[停止] 聚出来的列太少（" + common.length + " 条），判定方法不对");
      return;
    }

    // ---- 用第4页表头认列 ----
    const p4 = pages.find((p) => p.pn === 4);
    function colOf(x, bounds) {
      for (let i = 0; i < bounds.length - 1; i++) {
        if (x >= bounds[i] - 1 && x < bounds[i + 1]) return i;
      }
      return -1;
    }
    const headerCol = {};
    p4.texts.filter((t) => t.y > 400 && t.y < 430).forEach((t) => {
      headerCol[norm(t.s)] = colOf(t.x, common);
    });
    const secCol = headerCol["课程类别"], nameCol = headerCol["课程名"];
    if (secCol === undefined || nameCol === undefined) {
      console.log("[停止] 没认出表头列");
      return;
    }
    console.log("组名列 = 第" + (secCol + 1) + "列 [" + common[secCol] + "~" + common[secCol + 1] + "]");
    console.log("课程名列 = 第" + (nameCol + 1) + "列 [" + common[nameCol] + "~" + common[nameCol + 1] + "]\n");

    // ---- 核心：每个文字所在的「行区间」----
    let fail = 0;
    function ok(label, cond, extra) {
      console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
      if (!cond) fail++;
    }

    console.log("=== 验证：文字所在行区间的「高度」===");
    console.log("（合并单元格应该明显更高；普通课程行应该≈一个行高）\n");

    const heights = { sec: [], course: [] };
    pages.forEach(function (pg) {
      const secL = common[secCol], secR = common[secCol + 1];
      const nameL = common[nameCol], nameR = common[nameCol + 1];

      const secH = pg.H.filter((h) => h.x0 <= secL + 1 && h.x1 >= secR - 1).map((h) => h.y);
      const nameH = pg.H.filter((h) => h.x0 <= nameL + 1 && h.x1 >= nameR - 1).map((h) => h.y);
      if (!secH.length || !nameH.length) return;

      const secY = secH.slice().sort((a, c) => c - a);
      const nameY = nameH.slice().sort((a, c) => c - a);

      function band(y, sorted) {
        const above = sorted.filter((v) => v > y + 0.5);
        const below = sorted.filter((v) => v < y - 0.5);
        if (!above.length || !below.length) return null;
        return { top: Math.min(...above), bot: Math.max(...below), h: Math.min(...above) - Math.max(...below) };
      }

      pg.texts.forEach(function (t) {
        if (t.x >= secL && t.x < secR && t.s.length >= 3) {
          const b = band(t.y, secY);
          if (b) heights.sec.push({ p: pg.pn, s: t.s, h: b.h });
        }
        if (t.x >= nameL && t.x < nameR) {
          const b = band(t.y, nameY);
          if (b) heights.course.push({ p: pg.pn, s: t.s, h: b.h });
        }
      });
    });

    function stats(arr) {
      if (!arr.length) return null;
      const hs = arr.map((x) => x.h).sort((a, c) => a - c);
      return {
        n: hs.length, min: hs[0], max: hs[hs.length - 1],
        med: hs[Math.floor(hs.length / 2)],
        avg: hs.reduce((a, c) => a + c, 0) / hs.length,
      };
    }
    const sc = stats(heights.sec), co = stats(heights.course);
    console.log("  组名列文字行高: " + (sc ?
      "n=" + sc.n + " 最小=" + sc.min.toFixed(0) + " 中位=" + sc.med.toFixed(0) +
      " 最大=" + sc.max.toFixed(0) + " 均=" + sc.avg.toFixed(0) : "无"));
    console.log("  课程名列文字行高: " + (co ?
      "n=" + co.n + " 最小=" + co.min.toFixed(0) + " 中位=" + co.med.toFixed(0) +
      " 最大=" + co.max.toFixed(0) + " 均=" + co.avg.toFixed(0) : "无"));
    console.log("");

    ok("组名列有行高数据", !!sc);
    ok("课程名列有行高数据", !!co);
    if (sc && co) {
      ok("组名的行高中位 > 课程行高中位（合并单元格更高）", sc.med > co.med,
         sc.med.toFixed(0) + " vs " + co.med.toFixed(0));
      ok("课程行高中位接近一个行高（约 29）", co.med > 10 && co.med < 60,
         co.med.toFixed(0));
    }

    console.log("\n=== 组名列行高最大的 10 个（应该是合并单元格）===");
    heights.sec.sort((a, c) => c.h - a.h).slice(0, 10).forEach((x) => {
      const isName = truthNames.some((t) => norm(t).indexOf(norm(x.s)) === 0);
      console.log("  第" + x.p + " 页  高=" + x.h.toFixed(0) + "  " +
        x.s.slice(0, 26) + (isName ? "  ← 板块名" : ""));
    });

    console.log("\n=== 结果：" + (fail === 0 ? "判据成立（合并单元格可识别）" : fail + " 项不成立") + " ===");
  } finally {
    await b.close();
  }
})();