// 查清：为什么表格页只认出第 4 页，第 5~9 页被跳过？
//
// 【背景】
// build-section-checklist.js 里有一段：
//   const heads = items.filter(i => /^(课程模块|课程类别|课程号|课程名|总学分)$/.test(i.s));
//   if (hx["课程类别"] == null || hx["课程号"] == null) continue;   // ← 这里 continue 掉了
//
// 实测结果：表格在第 4~9 页，但只有第 4 页产出，课程数 9/100。
// 原因不明 —— **先查清是表头文字变了、列位置变了，还是这段正则太严**。
// 别猜。
//
// 用法：
//   node scripts/diag-table-pages.js <培养方案.pdf>

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const FILE = process.argv[2];
const PAGE_URL = "http://127.0.0.1:8899/importer-lab.html";

(async () => {
  if (!FILE) {
    console.error("用法：node scripts/diag-table-pages.js <培养方案.pdf>");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(PAGE_URL, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2500));
    const b64 = fs.readFileSync(FILE).toString("base64");

    const res = await page.evaluate(async (d) => {
      const bin = atob(d);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;

      const out = [];
      for (let pno = 1; pno <= doc.numPages; pno++) {
        const pg = await doc.getPage(pno);
        const H = pg.getViewport({ scale: 1 }).height;
        const tc = await pg.getTextContent();
        const items = tc.items
          .map((t) => ({ s: t.str.trim(), x: Math.round(t.transform[4]), y: Math.round(H - t.transform[5]) }))
          .filter((i) => i.s);

        const hasCode = items.some((i) => /^YN25/.test(i.s));
        if (!hasCode) continue;

        // 找所有可能像表头的文字（放宽：只要含「课程」「学分」「学期」）
        const loose = items.filter((i) => /课程|学分|学期|学时|模块|类别/.test(i.s) && i.s.length < 12);
        // 严格按当前脚本的正则
        const strict = items.filter((i) => /^(课程模块|课程类别|课程号|课程名|总学分)$/.test(i.s));
        const codes = items.filter((i) => /^YN25/.test(i.s));

        out.push({
          pno,
          codeCount: codes.length,
          strictHeads: strict.map((h) => ({ x: h.x, y: h.y, s: h.s })),
          looseHeads: loose.slice(0, 14).map((h) => ({ x: h.x, y: h.y, s: h.s })),
        });
      }
      return out;
    }, b64);

    console.log("找到含课程号的表格页：" + res.map((r) => "第" + r.pno + "页").join("、"));
    console.log("");
    res.forEach((r) => {
      console.log("=== 第 " + r.pno + " 页（课程号 " + r.codeCount + " 个）===");
      console.log("  严格匹配的表头（当前脚本用的正则）：" +
        (r.strictHeads.length ? r.strictHeads.map((h) => h.s + "@x=" + h.x).join("、") : "**无** ← 会被 continue 跳过"));
      console.log("  放宽后像表头的（供参考）：");
      if (r.looseHeads.length) {
        r.looseHeads.forEach((h) => console.log("x=" + String(h.x).padStart(4) + "  " + h.s));
      } else {
        console.log("    （一个都没有 —— 这页可能不是表格，或者表头被当成图形了）");
      }
      console.log("");
    });
  } catch (e) {
    console.error("错误：" + e.message.slice(0, 200));
  } finally {
    await browser.close();
  }
})();