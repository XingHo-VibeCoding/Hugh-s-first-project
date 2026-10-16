/* 研究：框线 y 与文字 y 的偏移量是多少？能不能算出来？
 *
 * 【刚发现的关键事实】
 *   第5页横线 y：635, 606, 577, 548, 520, 491, 462, 433, 404, 375, 346, 318,
 *               289, 260, 231, 202, 173, 145, 116, 87, 58, 29, 1
 *               → **等差数列，步长约 29 = 表格行高**
 *
 *   但框线 y 只到 635，文字 y 到 725 —— 差 90。
 *   第4页：框线到 351，文字到 727 —— 差 376。
 *   **偏移量每页不同**，说明不能写死。
 *
 * 【要查的】
 *   每页的偏移量是多少？能不能从数据里**算**出来（而不是猜）？
 *   如果能算出来 → 难点③（文字压列边界）就能解决。
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
    const out = await p.evaluate(async function (d) {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const L = window.pdfjsLib;
      const doc = await L.getDocument({ data: arr }).promise;
      const OPS = L.OPS;
      const res = [];

      for (let pn = 3; pn <= doc.numPages; pn++) {
        const page = await doc.getPage(pn);
        const vp = page.getViewport({ scale: 1 });
        const ops = await page.getOperatorList();
        const segs = [];
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
              segs.push({ x0: cur.x, y0: cur.y, x1: co[idx], y1: co[idx + 1] });
              cur = { x: co[idx], y: co[idx + 1] };
            }
          }
        }
        const tc = await page.getTextContent();
        const texts = tc.items.filter((it) => it.str && it.str.trim())
          .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }));
        res.push({
          pn: pn, segs: segs, texts: texts,
          pageH: vp.height, pageW: vp.width,
        });
      }
      return res;
    }, b64);

    console.log("=== 每页：框线 y 与文字 y 的关系 ===\n");
    console.log("页  页面高  框线y范围        文字y范围        差(文字max-框线max)");

    const table = [];
    out.forEach(function (pg) {
      const hy = pg.segs.map((g) => (g.y0 + g.y1) / 2);
      const ty = pg.texts.map((t) => t.y);
      if (!hy.length || !ty.length) return;
      const hMin = Math.min(...hy), hMax = Math.max(...hy);
      const tMin = Math.min(...ty), tMax = Math.max(...ty);
      const diff = tMax - hMax;
      console.log(" " + String(pg.pn).padStart(2) + "  " +
        Math.round(pg.pageH).toString().padStart(5) + "   [" +
        String(Math.round(hMin)).padStart(5) + "~" + String(Math.round(hMax)).padStart(5) + "]      [" +
        String(Math.round(tMin)).padStart(5) + "~" + String(Math.round(tMax)).padStart(5) + "]      " +
        String(Math.round(diff)).padStart(5));
      table.push({ pn: pg.pn, pageH: pg.pageH, hMax: hMax, tMax: tMax, diff: diff, hMin: hMin, tMin: tMin });
    });

    // 找规律：diff 和 pageH 有关吗？
    console.log("\n=== 找偏移规律 ===\n");
    console.log("假设1：偏移 = 页面高 - 框线范围");
    table.forEach(function (r) {
      const hSpan = r.hMax - r.hMin;
      console.log("  第" + String(r.pn).padStart(2) + " 页  页面高=" + Math.round(r.pageH) +
        "  框线跨度=" + Math.round(hSpan) +
        "  差值=" + Math.round(r.diff) +
        "  (页面高-框线跨度)=" + Math.round(r.pageH - hSpan) +
        "  匹配=" + (Math.abs((r.pageH - hSpan) - r.diff) < 15 ? "✅" : ""));
    });

    // 逐个偏移试：假设框线 y 需要 +offset 才和文字对齐
    console.log("\n=== 反向验证：框线 y 加多少才能和文字对齐？===");
    table.forEach(function (r) {
      // 文字的 y 值集合（取整）
      const hy = new Set(out.find((x) => x.pn === r.pn).segs
        .map((g) => Math.round((g.y0 + g.y1) / 2)));
      const ty = out.find((x) => x.pn === r.pn).texts.map((t) => Math.round(t.y));

      // 试各个 offset，看有多少文字 y 能落在某条横线上（±2 容差）
      let best = { off: null, hits: 0 };
      for (let off = -500; off <= 500; off += 1) {
        let hits = 0;
        ty.forEach(function (y) {
          if (hy.has(y + off)) hits++;
        });
        if (hits > best.hits) best = { off: off, hits: hits };
      }
      const rate = best.hits / ty.length;
      console.log("  第" + String(r.pn).padStart(2) + " 页：最佳 offset=" +
        best.off + " → " + best.hits + "/" + ty.length +
        " 个文字落在横线上（" + Math.round(rate * 100) + "%）");
    });
  } finally {
    await b.close();
  }
})();