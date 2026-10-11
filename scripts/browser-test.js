// 在真实 Chromium 里跑 pdf.js + 我们的解析器，把结果读出来
// 为什么需要这个：pdf.js 完整实现了 PDF 规范（坐标变换、字体编码、
// CID 字体映射等），手写的替身拿不到真实坐标，只有真浏览器里的结果才可信。
//
// 用法：
//   set NODE_PATH=<puppeteer-core 所在目录>
//   node scripts/browser-test.js <培养方案.pdf>

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

// agent-browser 已下载的 Chromium，不必再下一份
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const PAGE_URL = "http://127.0.0.1:8899/importer-lab.html";

const FILE = process.argv[2];
if (!FILE) {
  console.log("用法：node scripts/browser-test.js <培养方案.pdf 或 .docx>");
  process.exit(1);
}
if (!fs.existsSync(CHROME)) {
  console.error("找不到 Chromium：" + CHROME);
  process.exit(1);
}

// 明显可疑的课程名
//
// 【判据说明】不能只看长度 —— 这份培养方案里真的有「党史」（2 个字）、
// 「哲学」（2 个字）这种短课名，按长度判会误报。
// 真正可疑的是这两种：
//   1) 括号没闭合 → 说明折行时被截断了（真实名字是「人工智能通识（理工农医类）」）
//   2) 是新课程名的一部分（如「业指导」本该是「创新能力提升与就业指导」）
function isSuspicious(name) {
  const n = String(name);
  // 括号没闭合
  if (/[（(][^）)]*$/.test(n)) return true;
  if (/^[）)]/.test(n)) return true;
  // 残留的半截词
  if (/^(业指导|处理|讲座|类）|物理学|理论$|查$|涯规划)/.test(n)) return true;
  // 明显过长（课程名一般不超过 30 字）
  if (n.length > 30) return true;
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.log("[页面报错]", e.message));

    await page.goto(PAGE_URL, { waitUntil: "networkidle0" });

    const libs = await page.evaluate(() => ({
      pdfjs: !!window.pdfjsLib,
      zip: !!window.JSZip,
      reader: !!window.PDFReader,
      docx: !!window.DocxReader,
      extractor: !!window.CourseExtractor
    }));
    console.log("依赖库：", JSON.stringify(libs));
    if (!libs.reader || !libs.extractor) {
      console.error("解析器没加载成功");
      process.exit(1);
    }

    const b64 = fs.readFileSync(FILE).toString("base64");
    const ext = path.extname(FILE).toLowerCase();

    const out = await page.evaluate(async (b64, ext) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], "plan" + ext);

      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

      const isPdf = ext === ".pdf";
      const res = isPdf ? await window.PDFReader.parse(file) : await window.DocxReader.parse(file);
      const ex = window.CourseExtractor.extractCourses(res.matrix);

      return {
        pages: res.pages,
        matrixLen: res.matrix.length,
        headerFound: ex.stats.headerFound,
        colMap: ex.stats.colMap,
        sections: ex.sections,
        rows: ex.rows,
        warnings: ex.warnings
      };
    }, b64, ext);

    console.log("\n=== 解析结果 ===");
    console.log("页数：" + out.pages + "｜矩阵行数：" + out.matrixLen);
    console.log("表头：" + (out.headerFound ? "已找到" : "未找到"));
    console.log("列映射：" + JSON.stringify(out.colMap));
    console.log("认出课程：" + out.rows.length + " 门");

    if (out.sections && out.sections.length) {
      console.log("\n--- 文档写明的板块要求 ---");
      out.sections.forEach((s) => console.log("  " + s.name + "：要求 " + s.required + " 学分"));
    }

    const sum = out.rows.reduce((a, r) => a + r.credits, 0);
    console.log("\n学分合计：" + sum.toFixed(1));

console.log("\n--- 课程 ---");
    out.rows.forEach((r, i) => {
      const bad = isSuspicious(r.name);
      console.log(
        String(i + 1).padStart(3) + ". " +
 String(r.name).padEnd(34, " ") + " " +
        String(r.credits).padStart(5) + "  " +
        ("第" + (r.term || "—") + "学期").padEnd(8) +
        (r.section || "（未归类）") +
        (bad ? "?" : "")
   );
    });

    const suspicious = out.rows.filter((r) => isSuspicious(r.name));
    const unclassified = out.rows.filter((r) => !r.section);
    console.log("\n=== 质量统计 ===");
    console.log("  总课程数：" + out.rows.length);
    console.log("  学分合计：" + sum.toFixed(1));
    console.log("  名字可信率：" +
      (out.rows.length ? Math.round((out.rows.length - suspicious.length) / out.rows.length * 100) : 0) + "%");
    console.log("  已归类：" +
      (out.rows.length ? Math.round((out.rows.length - unclassified.length) / out.rows.length * 100) : 0) + "%");

    if (suspicious.length) {
      console.log("\n--- 可疑的课程名 ---");
      suspicious.slice(0, 20).forEach((r) => console.log("  ! " + r.name + "  " + r.credits));
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});