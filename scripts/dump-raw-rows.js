// 导出 PDF 课程表的原始行（不做任何合并猜测），供人工核对
// 用法：node scripts/dump-raw-rows.js <培养方案.pdf> [起始行] [行数]

const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const FILE = process.argv[2];
const FROM = parseInt(process.argv[3] || "0", 10);
const COUNT = parseInt(process.argv[4] || "200", 10);

if (!FILE || !fs.existsSync(CHROME)) {
  console.log("用法：node scripts/dump-raw-rows.js <培养方案.pdf> [from] [count]");
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  await page.goto("http://127.0.0.1:8899/importer-lab.html", { waitUntil: "networkidle0" });

  const b64 = fs.readFileSync(FILE).toString("base64");
  const data = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const res = await window.PDFReader.parse(new File([a], "p.pdf"));

    // 拿到表头列名，方便对照
    const cols = res.header ? res.header.cols.map((c) => c.name) : [];

    // 重新按列归位（不合并、不填充），这是最原始的表格视图
    const rows = [];
    const ci = window.CourseExtractor.colIndexes(res.matrix[0]);
    for (let i = 1; i < res.matrix.length; i++) {
      const r = res.matrix[i] || [];
      if (!r.length) continue;
      rows.push({
        page: r[0] ? (r[0].items && r[0].items[0] ? r[0].items[0].page : null) : null,
        cells: r.map((c) => (c && c.text ? c.text : ""))
      });
    }
    return { cols: cols, rows: rows, matrix: res.matrix };
  }, b64);

  await browser.close();

  console.log("表头列：" + data.cols.join(" | "));
  console.log("行数：" + data.rows.length + "\n");

  const ci = {};
  data.cols.forEach((n, i) => {
    const t = n.replace(/\s+/g, "");
    if (ci.name === undefined && /课程名/.test(t)) ci.name = i;
    if (ci.credits === undefined && /学分/.test(t)) ci.credits = i;
  });

  data.rows.slice(FROM, FROM + COUNT).forEach((r, i) => {
    const name = r.cells[ci.name] || "";
    const credit = r.cells[ci.credits] || "";
    // 只打印「有课程名或有学分」的行，过滤纯噪声
    if (!name && !credit) return;
    const idx = FROM + i;
    console.log(
      String(idx).padStart(3) +
      " | " + name.padEnd(26, " ") +
      " | " + credit.padStart(6) +
      " | " + r.cells.slice(0, 2).join(" / ")
    );
  });
})().catch((e) => { console.error("失败：", e.message); process.exit(1); });