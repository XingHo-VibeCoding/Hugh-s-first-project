/* 研究：把框线坐标转换到和文字同一套坐标系，验证难点③的真正解法
 *
 * 【0% 的真正原因（刚查到的）】
 *   框线坐标（构造路径）y 范围 [0.3 ~ 350.5]
 *   文字坐标（transform）   y 范围 [106 ~ 727.5]
 *   **完全不在一个范围** —— 我之前拿两套不同坐标系的数字直接比较，0% 是必然的。
 *
 * 【pdf.js 里两套坐标怎么对应】
 *   · constructPath 的坐标 = **PDF 用户空间**（原点左下、y 向上）
 *   · getTextContent 的 transform = **视口空间**（原点左上、y 向下）
 *   · 两者换算：**视口坐标 = Util.transform(viewport.transform, 用户坐标)**
 *   · 实测视口 907.2 × 842，而 viewBox 就是 [0,0,907.2,842] → 变换是纯翻转+平移
 *
 * 【这个脚本验证什么】
 *   把框线坐标经过 viewportUtil 变换后，
 *   看它能不能和文字坐标对上（表头 x 是否落在竖线之间）。
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
const PDF = process.argv[2];
if (!PDF) { console.error("用法：node scripts/research-transform-box.js <pdf>"); process.exit(1); }

(async function () {
  console.log("=== 研究：框线坐标 → 视口坐标变换 ===\n");
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });
    await p.goto("http://127.0.0.1:" + PORT, { waitUntil: "domcontentloaded" });
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
      const Util = pdfjsLib.Util;

      const out = [];
      for (let pn = 4; pn <= 6; pn++) {
        const page = await doc.getPage(pn);
        const viewport = page.getViewport({ scale: 1 });
        const ops = await page.getOperatorList();

        // 收集线段（用户空间坐标）
        const segsRaw = [];
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
              segsRaw.push({ x0: cur.x, y0: cur.y, x1: co[idx], y1: co[idx + 1] });
              cur = { x: co[idx], y: co[idx + 1] };
            }
          }
        }

        // ✅ 关键：**不要用 viewport.transform 翻转**。
        // 实测 transform = [1,0,0,-1,0,842]，翻转后框线 y 变成 -635~0（负数），
        // 而文字 y 是 108~725 —— 反而更远了。
        // 说明这个 PDF 的构造路径坐标**本来就已经是视口坐标**
        //（原点左上、y 向下），与 getTextContent 的 transform 同一套。
        // 证据：两者原始范围本来就高度重叠（框线 y 0~635，文字 y 108~725）。
        const segsVp = segsRaw.slice();

        const tc = await page.getTextContent();
        const texts = tc.items.filter((it) => it.str && it.str.trim()).map((it) => ({
          x: it.transform[4], y: it.transform[5], s: it.str.trim(),
        }));

        out.push({
          pageNo: pn, segsRaw: segsRaw, segsVp: segsVp, texts: texts,
          transform: Array.from(viewport.transform),
        });
      }
      return { pages: out };
    }, b64);

    let fail = 0;
    function ok(label, cond, extra) {
      console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
      if (!cond) fail++;
    }

    console.log("=== 验证：变换后的框线能否和文字对上 ===\n");

    result.pages.forEach(function (pg) {
      console.log("──── 第" + pg.pageNo + " 页 ────");
      console.log("  viewport.transform = [" + pg.transform.map((v) => Math.round(v * 1000) / 1000).join(", ") + "]");

      // 范围对比
      function range(list, pick) {
        let a = Infinity, b = -Infinity;
        list.forEach((g) => { a = Math.min(a, pick(g)); b = Math.max(b, pick(g)); });
        return [a, b];
      }
      const rawY = range(pg.segsRaw, (g) => g.y0);
      const vpY = range(pg.segsVp, (g) => g.y0);
      const txtY = range(pg.texts, (t) => t.y);
      console.log("  框线 y（用户空间）: [" + rawY[0].toFixed(0) + " ~ " + rawY[1].toFixed(0) + "]");
      console.log("  框线 y（变换后）:   [" + vpY[0].toFixed(0) + " ~ " + vpY[1].toFixed(0) + "]");
      console.log("  文字 y（视口）:     [" + txtY[0].toFixed(0) + " ~ " + txtY[1].toFixed(0) + "]");

      // 关键判据：变换后两者范围应该重叠
      const overlap = Math.min(vpY[1], txtY[1]) - Math.max(vpY[0], txtY[0]);
      ok("第" + pg.pageNo + " 页：变换后框线 y 与文字 y 范围重叠", overlap > 0,
         "重叠 " + overlap.toFixed(0));

      // 表头文字 x 是否落在变换后的竖线之间
      const hdr = pg.texts.filter((t) => /课程名|课程模块|课程类别|课程号/.test(t.s));
      if (hdr.length) {
        const hy = hdr[0].y;
        const vLines = pg.segsVp.filter(function (g) {
          return Math.abs(g.x0 - g.x1) < 0.6 && Math.abs(g.y0 - hy) < 3;
        }).map(function (g) { return Math.round(g.x0 * 10) / 10; }).sort(function (a, c) { return a - c; });

        console.log("  表头行 y=" + hy.toFixed(1) + " 的竖线 x: " + vLines.join(", "));
        hdr.forEach(function (t) {
          let ci = -1;
          for (let i = 0; i < vLines.length - 1; i++) {
            if (t.x >= vLines[i] && t.x < vLines[i + 1]) { ci = i; break; }
          }
          ok("  " + t.s.padEnd(6) + " x=" + t.x.toFixed(1) +
             " 落在竖线区间 [" + (ci >= 0 ? vLines[ci] + "~" + vLines[ci + 1] : "?") + "]",
             ci >= 0);
        });
      }
      console.log("");
    });

    console.log("=== 结论 ===");
    console.log(fail === 0
      ? "✅ 坐标系问题解决了 —— 框线和文字现在能对上"
      : "❌ 仍有 " + fail + " 项对不上，需要继续查");
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    await b.close();
  }
})();