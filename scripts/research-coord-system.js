/* 研究：把难点③彻底查清 —— 文字 x 到底怎么和列边界对应
 *
 * 【为什么先做这个】
 *   难点③是核心：文字 x 压在列边界上（课程名多在 320~360，边界是 338/339），
 *   导致 `x >= b[i] && x < b[i+1]` 随机分错列，归属判断 0%。
 *
 *   但**我还没验证一个更基本的问题**：
 *   **PDF 坐标系和框线坐标系是同一个吗？**
 *   pdf.js 的文字用 transform[4]/transform[5]（视口坐标，已翻转 y），
 *   而构造路径(constructPath)的坐标是 **PDF 用户空间坐标（y 向上）**。
 *   **如果两者差一个变换，我拿文字坐标去比框线坐标就必然全错。**
 *
 *   这可能就是 0% 的真正原因，而不是「漂移」。
 *
 * 这个脚本只回答：
 *   文字坐标体系和框线坐标体系是什么关系？差多少？怎么对齐？
 *
 * ⚠️ 只读，不改生产代码。
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
if (!PDF) { console.error("用法：node scripts/research-coord-system.js <pdf>"); process.exit(1); }

(async function () {
  console.log("=== 研究：文字坐标 vs 框线坐标 ===\n");
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
      for (let pn = 4; pn <= 6; pn++) {
        const page = await doc.getPage(pn);
        const viewport = page.getViewport({ scale: 1 });

        // 框线坐标
        const ops = await page.getOperatorList();
        const segs = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== OPS.constructPath) continue;
          const args = ops.argsArray[i];
          if (!Array.isArray(args)) continue;
          const sub = args[0] || [], co = args[1] || [];
          let cur = null;
          for (let k = 0; k < sub.length; k++) {
            const idx = k * 2;
            if (sub[k] === OPS.moveTo) cur = { x: co[idx], y: co[idx + 1] };
            else if (sub[k] === OPS.lineTo && cur) {
              segs.push({ x0: cur.x, y0: cur.y, x1: co[idx], y1: co[idx + 1] });
              cur = { x: co[idx], y: co[idx + 1] };
            }
          }
        }

        // 文字坐标（两种取法）
        const tc = await page.getTextContent();
        const textsA = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
          x: it.transform[4], y: it.transform[5], s: it.str.trim(),
        }));
        // 取法 B：把 y 用 viewport 高度翻转（PDF y 向上 → 视口 y 向下）
        const textsB = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
          x: it.transform[4], y: viewport.height - it.transform[5], s: it.str.trim(),
        }));

        out.push({
          pageNo: pn,
          pageWidth: viewport.width, pageHeight: viewport.height,
          view: viewport.viewBox,
          segs: segs,
          textsA: textsA, textsB: textsB,
        });
      }
      return { pages: out };
    }, b64);

    result.pages.forEach(function (pg) {
      console.log("════ 第" + pg.pageNo + " 页 ════");
      console.log("  视口尺寸: " + pg.pageWidth.toFixed(1) + " × " + pg.pageHeight.toFixed(1));
      console.log("  viewBox: " + JSON.stringify(pg.view));
      console.log("");

      // 框线坐标范围
      let hx0 = Infinity, hx1 = -Infinity, hy0 = Infinity, hy1 = -Infinity;
      pg.segs.forEach(function (g) {
        hx0 = Math.min(hx0, g.x0, g.x1); hx1 = Math.max(hx1, g.x0, g.x1);
        hy0 = Math.min(hy0, g.y0, g.y1); hy1 = Math.max(hy1, g.y0, g.y1);
      });
      console.log("  框线坐标范围: x [" + hx0.toFixed(1) + " ~ " + hx1.toFixed(1) +
        "]  y [" + hy0.toFixed(1) + " ~ " + hy1.toFixed(1) + "]");

      // 文字坐标范围（两种取法）
      function rangeOf(arr) {
        let a = Infinity, b = -Infinity;
        arr.forEach(function (t) { a = Math.min(a, t.y); b = Math.max(b, t.y); });
        return [a, b];
      }
      const ra = rangeOf(pg.textsA), rb = rangeOf(pg.textsB);
      console.log("  文字 y 范围（取法A 直接用transform[5]）: [" +
        ra[0].toFixed(1) + " ~ " + ra[1].toFixed(1) + "]");
      console.log("  文字 y 范围（取法B 翻转后）: [" +
        rb[0].toFixed(1) + " ~ " + rb[1].toFixed(1) + "]");

      // x 范围对比（x 应该两套一样，不需要翻转）
      let tx0 = Infinity, tx1 = -Infinity;
      pg.textsA.forEach(function (t) { tx0 = Math.min(tx0, t.x); tx1 = Math.max(tx1, t.x); });
      console.log("  文字 x 范围: [" + tx0.toFixed(1) + " ~ " + tx1.toFixed(1) + "]");
      console.log("");

      // 关键对比：同一个字「课程名」在文字里的 x，和表头附近框线的 x
      const headerTexts = pg.textsA.filter((t) => /课程名|课程模块|课程类别|课程号/.test(t.s));
      if (headerTexts.length) {
        console.log("  表头文字 x（取法A）:");
        headerTexts.forEach(function (t) {
          console.log("    " + t.s.padEnd(8) + " x=" + t.x.toFixed(1) + " y=" + t.y.toFixed(1));
        });
        // 表头那一带附近的竖线
        const hy = headerTexts[0].y;
        const near = pg.segs.filter(function (g) {
          return Math.abs(g.y0 - hy) < 3 || Math.abs(g.y1 - hy) < 3;
        }).map(function (g) { return Math.round(g.x0 * 10) / 10; });
        console.log("    表头所在高度附近的竖线 x: " + near.join(", "));
        console.log("    → 若表头 x 不在附近竖线之间，说明**两套坐标系不是同一个**");
      }
      console.log("");
    });

    fs.writeFileSync(path.join(__dirname, "research-coord-system.json"),
      JSON.stringify(result, null, 2), "utf8");
    console.log("数据已存：scripts/research-coord-system.json");
  } finally {
    await b.close();
  }
})();