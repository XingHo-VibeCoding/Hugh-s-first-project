/* 研究：第4页框线的真实 y 分布 —— 定位「表头为什么在框线之外」
 *
 * 【要查的问题】
 *   实测：表头文字在 y=418.4，但框线 y 范围只到 351 → **表头不在框线覆盖范围内**。
 *   为什么？是框线没画到表头那？还是框线坐标又需要某种变换？
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

      for (let pn = 4; pn <= 6; pn++) {
        const page = await doc.getPage(pn);
        const ops = await page.getOperatorList();
        const H = [], V = [], other = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          if (ops.fnArray[i] !== OPS.constructPath) continue;
          const a = ops.argsArray[i];
          if (!Array.isArray(a)) continue;
          const sub = a[0] || [], co = a[1] || [];
          let cur = null;
          for (let k = 0; k < sub.length; k++) {
            const idx = k * 2;
            if (sub[k] === OPS.moveTo) { cur = { x: co[idx], y: co[idx + 1] }; }
            else if (sub[k] === OPS.lineTo && cur) {
              const dx = Math.abs(co[idx] - cur.x), dy = Math.abs(co[idx + 1] - cur.y);
              const g = { x0: cur.x, y0: cur.y, x1: co[idx], y1: co[idx + 1] };
              if (dy < 0.6 && dx > 5) H.push(g);
              else if (dx < 0.6 && dy > 5) V.push(g);
              else other.push(g);
              cur = { x: co[idx], y: co[idx + 1] };
            }
          }
        }
        const tc = await page.getTextContent();
        const texts = tc.items.filter((it) => it.str && it.str.trim())
          .map((it) => ({ x: it.transform[4], y: it.transform[5], s: it.str.trim() }));
        res.push({ pn: pn, H: H, V: V, other: other, texts: texts });
      }
      return res;
    }, b64);

    out.forEach(function (pg) {
      console.log("════ 第" + pg.pn + " 页 ════");
      const hy = [...new Set(pg.H.map((g) => Math.round((g.y0 + g.y1) / 2)))].sort((a, c) => c - a);
      const vx = [...new Set(pg.V.map((g) => Math.round(g.x0)))].sort((a, c) => a - c);
      const oy = [...new Set(pg.other.map((g) => Math.round((g.y0 + g.y1) / 2)))].sort((a, c) => c - a);

      console.log("  横线 " + pg.H.length + " 条，y: " + (hy[0]) + " ~ " + (hy[hy.length - 1]));
      console.log("  纵线 " + pg.V.length + " 条，x: " + (vx[0]) + " ~ " + (vx[vx.length - 1]));
      if (pg.other.length) {
        console.log("  斜线/短段 " + pg.other.length + " 条，y: " + oy.slice(0, 12).join(", "));
      }
      console.log("  文字 y: " + Math.min(...pg.texts.map((t) => t.y)).toFixed(0) +
        " ~ " + Math.max(...pg.texts.map((t) => t.y)).toFixed(0));
      console.log("");

      console.log("  横线 y 全部值（从大到小）:");
      console.log("    " + hy.join(", "));
      console.log("");

      // 关键：表头 y 附近有没有横线？
      const hdr = pg.texts.filter((t) => /课程名/.test(t.s));
      if (hdr.length) {
        const hy0 = hdr[0].y;
        console.log("  表头「课程名」y=" + hy0.toFixed(1));
        const near = hy.filter((y) => Math.abs(y - hy0) < 25);
        console.log("    附近 ±25 的横线 y: " + (near.length ? near.join(", ") : "无"));
        const above = hy.filter((y) => y > hy0).length;
        const below = hy.filter((y) => y < hy0).length;
        console.log("    高于表头的横线: " + above + " 条，低于: " + below + " 条");
        if (below === 0) {
          console.log("    ⚠️ 表头下方一条横线都没有 → 框线只覆盖表格**数据区**，不含表头");
        }
      }
      console.log("");
    });
  } finally {
    await b.close();
  }
})();