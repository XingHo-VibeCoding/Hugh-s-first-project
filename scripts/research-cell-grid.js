/* 研究：把框线拼成表格网格，看能否圈出「哪几行属于同一个单元格」
 *
 * 【这一步决定成败】
 *   前面已经证明「按文字位置推断板块」原理上不成立，
 *   唯一有希望的是框线结构 —— 合并单元格的上下边界会跨多行，
 *   能**直接圈出**归属，不需要推断。
 *
 *   本脚本只回答一个问题：
 *   **把框线拼成单元格后，能不能正确圈出每个文字属于哪个单元格？**
 *
 *   能 → 方法成立，可以动手实现
 *   不能 → 这条路也封死，安心停在人工选择
 *
 * ⚠️ 只读，不改任何生产代码。
 */

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find((p) => fs.existsSync(p));
if (!CHROME) { console.error("找不到 Chrome"); process.exit(1); }

const PORT = process.env.PORT || "8905";
const SITE = "http://127.0.0.1:" + PORT;
const PDF = process.argv[2];
if (!PDF) { console.error("用法：node scripts/research-cell-grid.js <pdf>"); process.exit(1); }

(async function () {
  console.log("=== 研究：框线 → 单元格网格 ===\n");
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });
    await p.goto(SITE, { waitUntil: "domcontentloaded" });
    await p.addScriptTag({
      url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    });
    await new Promise((r) => setTimeout(r, 1500));

    const b64 = fs.readFileSync(PDF).toString("base64");

    const result = await p.evaluate(async (d) => {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const pdfjsLib = window.pdfjsLib;
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;
      const OPS = pdfjsLib.OPS;

      const out = [];
      for (let pn = 3; pn <= Math.min(doc.numPages, 9); pn++) {
        const page = await doc.getPage(pn);
        const ops = await page.getOperatorList();

        // ① 收集所有横线：每条 constructPath 里取 moveTo + lineTo 组成的线段
        const segs = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== OPS.constructPath) continue;
          const args = ops.argsArray[i];
          if (!Array.isArray(args)) continue;
          const sub = args[0] || [];
          const co = args[1] || [];
          let cur = null;
          for (let k = 0; k < sub.length; k++) {
            const op = sub[k];
            const idx = k * 2;
            if (op === OPS.moveTo) {
              cur = { x0: co[idx], y0: co[idx + 1] };
            } else if (op === OPS.lineTo && cur) {
              segs.push({ x0: cur.x0, y0: cur.y0, x1: co[idx], y1: co[idx + 1] });
              cur = { x0: co[idx], y0: co[idx + 1] };
            }
          }
        }

        // ② 文字（含坐标）
        const tc = await page.getTextContent();
        const texts = tc.items.filter((it) => it.str && it.str.trim())
          .map((it) => ({
            x: Math.round(it.transform[4] * 10) / 10,
            y: Math.round(it.transform[5] * 10) / 10,
            s: it.str.trim(),
          }));

        // ③ 把线段分成「横线」和「竖线」
        const H = [], V = [];
        segs.forEach(function (g) {
          const dx = Math.abs(g.x1 - g.x0), dy = Math.abs(g.y1 - g.y0);
          if (dy < 0.6 && dx > 5) H.push(g);
          else if (dx < 0.6 && dy > 5) V.push(g);
        });

        // ④ 横线按 y 聚类（PDF 坐标 y 向下增长，所以取反让它变成"从上往下"）
        const ys = {};
        H.forEach(function (g) {
          const y = Math.round((g.y0 + g.y1) / 2);
          if (!ys[y]) ys[y] = { y: y, xs: [] };
          ys[y].xs.push([Math.min(g.x0, g.x1), Math.max(g.x0, g.x1)]);
        });
        const rows = Object.keys(ys).map(Number).sort(function (a, b) { return b - a; })
          .map(function (y) { return ys[y]; });

        // ⑤ 竖线按 x 聚类
        const xs = {};
        V.forEach(function (g) {
          const x = Math.round((g.x0 + g.x1) / 2);
          if (!xs[x]) xs[x] = [];
          xs[x].push([Math.min(g.y0, g.y1), Math.max(g.y0, g.y1)]);
        });
        const cols = Object.keys(xs).map(Number).sort(function (a, b) { return a - b; })
          .map(function (x) { return { x: x, ys: xs[x] }; });

        out.push({
          pageNo: pn,
          hLines: rows, vLines: cols,
          vCount: V.length, hCount: H.length,
          texts: texts,
        });
      }
      return { numPages: doc.numPages, pages: out };
    }, b64);

    // ---------- 分析第 4 页（有表头，最完整）----------
    console.log("=== 先看第 4 页（唯一有表头的页，结构最完整）===\n");
    const pg4 = result.pages.find((p) => p.pageNo === 4);
    console.log("横线 " + pg4.hCount + " 条（按 y 聚成 " + pg4.hLines.length + " 组）");
    console.log("竖线 " + pg4.vCount + " 条（按 x 聚成 " + pg4.vLines.length + " 组）\n");

    console.log("--- 横线（从上往下，即 y 递减）前 12 组 ---");
    pg4.hLines.slice(0, 12).forEach(function (r, i) {
      const spans = r.xs.map(function (s) {
        return "[" + s[0] + "~" + s[1] + "]";
      }).join(" ");
      console.log("  " + String(i).padStart(2) + " y=" + String(r.y).padStart(6) +
        "  段数=" + String(r.xs.length).padStart(2) + "  " + spans.slice(0, 110));
    });

    console.log("\n--- 竖线（按 x 排序）前 15 条 ---");
    pg4.vLines.slice(0, 15).forEach(function (c, i) {
      const yr = c.ys.map(function (r) { return r[0] + "~" + r[1]; }).slice(0, 4).join(", ");
      console.log("  " + String(i).padStart(2) + " x=" + String(c.x).padStart(6) +
        "  段数=" + String(c.ys.length).padStart(3) + "  y范围: " + yr);
    });

    // ---------- 关键：文字落在哪个竖线区间 ----------
    console.log("\n=== 关键验证：课程名文字落在哪个「竖线区间」里 ===\n");
    if (pg4.vLines.length >= 2) {
      const bounds = pg4.vLines.map((c) => c.x);
      console.log("竖线 x 坐标（作为列边界）：");
      console.log("  " + bounds.slice(0, 20).join(", ") + "\n");

      const courseTexts = pg4.texts.filter((t) => Math.abs(t.x - 226.5) < 4);
      console.log("课程名列（x≈226.5）的 " + courseTexts.length + " 条文字，各自落在第几列：");
      courseTexts.slice(0, 15).forEach(function (t) {
        let ci = -1;
        for (let i = 0; i < bounds.length - 1; i++) {
          if (t.x >= bounds[i] && t.x < bounds[i + 1]) { ci = i; break; }
        }
        console.log("  x=" + String(t.x).padStart(6) + " y=" + String(t.y).padStart(6) +
          "  第" + (ci + 1) + "列  " + t.s);
      });
    } else {
      console.log("竖线太少，构不成列");
    }

    // ---------- 各页概览 ----------
    console.log("\n=== 各页框线概览 ===");
    console.log("页  横线组  竖线组  文字数");
    result.pages.forEach(function (pg) {
      console.log(" " + pg.pageNo + "   " + String(pg.hLines.length).padStart(4) +
        "   " + String(pg.vLines.length).padStart(4) + "   " + String(pg.texts.length).padStart(4));
    });

    fs.writeFileSync(path.join(__dirname, "research-cell-grid.json"),
      JSON.stringify(result, null, 2), "utf8");
    console.log("\n网格数据已存：scripts/research-cell-grid.json");
  } finally {
    await b.close();
  }
})();