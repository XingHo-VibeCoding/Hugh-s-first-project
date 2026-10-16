/* 研究：把 PDF 表格的原始坐标全部 dump 出来
 *
 * 【为什么必须先看原始数据】
 *   之前失败 8 次，每次都是「凭猜测设计算法」：
 *   向上取组名（8%）→ 向下继承（8%）→ gridIndex 相差≤2（串组）……
 *   根子是**没先看清楚 PDF 里的组名到底出现在哪个位置、和课程行的空间关系是什么**。
 *
 *   这一步只做一件事：**把事实摆出来**。不做任何猜测、不设计算法。
 *   看清楚之后，方法自然就出来了；看不清，就再想别的路。
 *
 * 用法：node scripts/research-dump-coords.js <pdf路径>
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

const PORT = process.env.PORT || "8903";
const SITE = "http://127.0.0.1:" + PORT;
const PDF = process.argv[2];
if (!PDF) { console.error("用法：node scripts/research-dump-coords.js <pdf>"); process.exit(1); }

(async function () {
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });
    await p.goto(SITE + "/index.html", { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1500));
    await p.evaluate(() => { localStorage.clear(); location.hash = "#/courses"; });
    await new Promise((r) => setTimeout(r, 700));
    await p.evaluate(() => { const x = document.getElementById("import-open"); if (x) x.click(); });
    await new Promise((r) => setTimeout(r, 400));

    const b64 = fs.readFileSync(PDF).toString("base64");
    await p.evaluate(async (d) => {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], "x.pdf", { type: "application/pdf" });
      const dt = new DataTransfer();
      dt.items.add(file);
      const inp = document.getElementById("import-file");
      if (inp) { inp.files = dt.files; inp.dispatchEvent(new Event("change", { bubbles: true })); }
    }, b64);

    await new Promise((r) => setTimeout(r, 6000));

    // 直接调 PDFReader 的内部：它读文件后应该有页面数据。
    // 先探一下它暴露了什么。
    const api = await p.evaluate(() => {
      const keys = Object.keys(window.PDFReader || {});
      const pr = window.PDFReader;
      const inner = {};
      // 试着用它自己的 API 重新读一遍，拿到带坐标的原始数据
      return { keys: keys, hasInner: !!(pr && pr.__dumpRaw) };
    });
    console.log("PDFReader 暴露的方法：" + api.keys.join(", ") + "\n");

    // 用 PDF.js 直接读，拿最原始的 text items（含 x,y）
    const raw = await p.evaluate(async (d) => {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const pdfjsLib = window.pdfjsLib;
      if (!pdfjsLib) return { err: "pdf.js 没加载" };
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;
      const pages = [];
      // 读**全部页**：学员指出表格被换页截断，只读前 6 页验证不了这一点
      for (let pn = 1; pn <= doc.numPages; pn++) {
        const page = await doc.getPage(pn);
        const tc = await page.getTextContent();
        const items = tc.items
          .filter((it) => it.str && it.str.trim())
          .map((it) => ({
            x: Math.round(it.transform[4] * 10) / 10,
            y: Math.round(it.transform[5] * 10) / 10,
            s: it.str.trim(),
          }));
        pages.push({ pageNo: pn, items: items });
      }
      return { numPages: doc.numPages, pages: pages };
    }, b64);

    if (raw.err) { console.log("[失败] " + raw.err); return; }
    console.log("PDF 共 " + raw.numPages + " 页\n");

    // 找表头所在页
    const target = raw.pages.find((pg) =>
      pg.items.some((it) => /课程模块/.test(it.s)));
    if (!target) {
      console.log("前 6 页没找到「课程模块」表头，改 dump 前 6 页所有文字");
      raw.pages.forEach((pg) => {
        console.log("\n--- 第 " + pg.pageNo + " 页（前 25 条）---");
        pg.items.slice(0, 25).forEach((it) => {
          console.log("  x=" + String(it.x).padStart(6) + " y=" + String(it.y).padStart(6) + "  " + it.s);
        });
      });
      return;
    }

    console.log("表头在第 " + target.pageNo + " 页\n");
    console.log("=== 该页全部文字项（按 y 降序 = 从上往下）===");
    const sorted = target.items.slice().sort((a, c) => c.y - a.y || a.x - c.x);
    sorted.forEach((it) => {
      const tag = /课程模块|课程类别|课程名|学分|学期|课程号/.test(it.s) ? " ←表头" : "";
      console.log("  x=" + String(it.x).padStart(6) + " y=" + String(it.y).padStart(6) + "  " + it.s + tag);
    });

    fs.writeFileSync(
      path.join(__dirname, "research-coords-dump.json"),
      JSON.stringify(raw, null, 2), "utf8");
    console.log("\n原始坐标已存：scripts/research-coords-dump.json");
  } finally {
    await b.close();
  }
})();