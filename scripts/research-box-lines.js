/* 研究：PDF 表格的框线（矢量图形）能不能提取到？
 *
 * 【这是唯一还没排除的方向】
 *   前面证明「按文字位置推断板块」在原理上不成立。
 *   剩下唯一可能：**读表格的框线结构** ——
 *   合并单元格的上下边界会直接圈出「哪几行属于同一个组」，
 *   这是 PDF 里**客观存在**的结构，不需要推断。
 *
 * 这个脚本只回答一个问题：**能不能拿到框线？**
 * 拿到 → 值得继续研究；拿不到 → 这条路也封死，安心停在人工选择。
 *
 * 不改任何生产代码。
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
if (!PDF) { console.error("用法：node scripts/research-box-lines.js <pdf>"); process.exit(1); }

(async function () {
  console.log("=== 研究：表格框线能不能提取 ===\n");
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });

    // ⚠️ pdf.js 是从 CDN **动态加载**的（importer-ui.js:15），页面上并没有 script 标签，
    //   点开导入面板也只是在真正选文件时才注入。
    //   研究脚本不等它，直接自己注入一份（同一个 CDN、同一版本）。
    await p.goto(SITE, { waitUntil: "domcontentloaded" });
    await p.addScriptTag({
      url: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    });
    await new Promise((r) => setTimeout(r, 1500));
    const hasLib = await p.evaluate(() => !!window.pdfjsLib);
    console.log("pdf.js 是否已加载：" + (hasLib ? "是" : "否"));
    if (!hasLib) {
      console.log("[失败] pdf.js 注入后仍不可用");
      return;
    }

    const b64 = fs.readFileSync(PDF).toString("base64");
    const result = await p.evaluate(async (d) => {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const pdfjsLib = window.pdfjsLib;
      if (!pdfjsLib) return { err: "pdf.js 没加载" };
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;

      const out = [];
      for (let pn = 3; pn <= Math.min(doc.numPages, 9); pn++) {
        const page = await doc.getPage(pn);
        const ops = await page.getOperatorList();

        // 在操作列表里找矩形绘制指令
        // pdf.js 的 OPS 里：constructPath 会带 [ops.lineTo/rectangleTo/curveTo] 序列
        const OPS = pdfjsLib.OPS || {};
        let paths = 0, rects = 0, lines = 0, moves = 0;
        const samples = [];

        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          if (fn === OPS.constructPath) {
            const args = ops.argsArray[i];
            paths++;
            // args = [opsArray, coordsArray, minMax]
            if (!Array.isArray(args)) continue;
            const sub = args[0] || [];
            sub.forEach(function (o) {
              if (o === OPS.rectangle) rects++;
              else if (o === OPS.lineTo) lines++;
              else if (o === OPS.moveTo) moves++;
            });
            if (samples.length < 8 && Array.isArray(args[1])) {
              const c = args[1].slice(0, 8).map(function (v) { return Math.round(v * 10) / 10; });
              samples.push({ coords: c, minMax: args[2] });
            }
          }
        }
        out.push({ pageNo: pn, paths: paths, rects: rects, lines: lines, moves: moves, samples: samples });
      }
      return { numPages: doc.numPages, pages: out };
    }, b64);

    if (result.err) { console.log("[失败] " + result.err); return; }

    console.log("PDF 共 " + result.numPages + " 页\n");
    console.log("页constructPath  rectangle  lineTo  moveTo  评价");
    let totalUseful = 0;
    result.pages.forEach(function (pg) {
      const useful = pg.rects + pg.lines;
      if (useful > 0) totalUseful += useful;
      let verdict;
      if (pg.rects > 20) verdict = "✅ 大量矩形 = 表格框线可用";
      else if (pg.lines > 30) verdict = "⚠️ 只有直线段，需自己拼线";
      else if (useful === 0) verdict = "❌ 没有框线（这条路封死）";
      else verdict = "? 少量图形";
      console.log(" " + pg.pageNo + "   " + String(pg.paths).padStart(8) +
        String(pg.rects).padStart(10) + String(pg.lines).padStart(8) +
        String(pg.moves).padStart(8) + "  " + verdict);
    });

    console.log("\n=== 图形总数 ===");
    console.log("  可用图形（rectangle + lineTo）合计: " + totalUseful);

    if (totalUseful > 0) {
      console.log("\n=== 坐标样本（前 8 条，判断能不能定位表格范围）===");
      result.pages.forEach(function (pg) {
        pg.samples.slice(0, 3).forEach(function (s) {
          console.log("  第" + pg.pageNo + "页  coords=" + JSON.stringify(s.coords) +
            (s.minMax ? "  minMax=" + JSON.stringify(s.minMax) : ""));
        });
      });
    }

    const verdict = totalUseful > 50
      ? "\n✅ 结论：框线**可以提取**。这条方向值得继续研究。"
      : "\n❌ 结论：框线提取不到，这条路也封死。安心停在「留空人工选」。";
    console.log(verdict);
  } finally {
    await b.close();
  }
})();