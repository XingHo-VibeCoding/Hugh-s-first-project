/* 研究用：把 PDF 表格的「课程类别」列真实内容 dump 出来
 *
 * 目的：搞清楚「课程类别」列到底装的是什么。
 * 现在的解析器把它当板块名去匹配（matchStrict/matchLoose），
 * 而板块名是「通识必修」「专业核心」这类 —— 如果对不上，
 * 说明**这一列本来就不装板块名**，那 65.3% 的根因就找到了。
 *
 * 只读不改，不碰生产代码。
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

(async function () {
  console.log("=== 研究：dump 表格的「课程类别」列 ===\n");
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
  });
  try {
    const p = await b.newPage();
    await page_fixViewport(p);
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

    // 等解析完成
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const done = await p.evaluate(() => {
        const rows = document.querySelectorAll("#import-table tbody tr").length;
        const err = document.querySelector("#import-error");
        return { rows: rows, err: err ? err.textContent.trim() : "" };
      });
      if (done.rows > 0 || done.err) {
        if (done.err) { console.log("[解析报错] " + done.err); return; }
        console.log("解析完成，表格 " + done.rows + " 行\n");
        break;
      }
    }

    // 把表格前 60 行原样 dump 出来
    const dump = await p.evaluate(() => {
      const trs = Array.from(document.querySelectorAll("#import-table tbody tr"));
      return trs.slice(0, 60).map((tr) =>
        Array.from(tr.children).map((td) => (td.innerText || td.textContent || "").trim())
      );
    });

    console.log("=== 表格前 60 行（每行所有单元格）===\n");
    dump.forEach((cells, i) => {
      const nonEmpty = cells.filter((c) => c);
      if (nonEmpty.length === 0) return;
      console.log("行" + String(i + 1).padStart(3) + " | " + nonEmpty.join(" ¦ "));
    });

    // 专门统计「课程类别」列（索引 1）的取值分布
    const catCol = dump.map((r) => (r[1] || "").trim()).filter(Boolean);
    const freq = {};
    catCol.forEach((v) => { freq[v] = (freq[v] || 0) + 1; });
    console.log("\n\n=== 第 2 列（课程类别）的取值分布 ===");
    Object.keys(freq).sort().forEach((k) => {
      console.log("  " + String(freq[k]).padStart(3) + " 次　" + k);
    });

    // 对比：真值板块名
    const TRUTH = JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "db", "truth-curriculum.json"), "utf8"));
    console.log("\n\n=== 真值里的板块名（长什么样）===");
    Object.keys(TRUTH.cats || {}).forEach((k) => {
      console.log("  " + (Array.isArray(TRUTH.cats[k]) ? TRUTH.cats[k].name : k));
    });
  } finally {
    await b.close();
  }
})();

async function page_fixViewport(p) {
  await p.setViewport({ width: 1400, height: 900 });
}
