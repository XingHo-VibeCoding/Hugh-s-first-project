// 端到端测试：在真实 Chromium 里走完「选文件 → 待确认表格 → 确认导入」
// 用法：node scripts/e2e-import.js <培养方案.pdf>

const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const PAGE_URL = "http://127.0.0.1:8899/index.html";
const FILE = process.argv[2];

if (!FILE || !fs.existsSync(CHROME)) {
  console.log("用法：node scripts/e2e-import.js <培养方案.pdf>");
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text()); });

    await page.goto(PAGE_URL, { waitUntil: "networkidle0" });
    // 等过 600ms 的 showRealData 定时器，否则会被 localStorage 空数据覆盖
    await new Promise((r) => setTimeout(r, 1500));

    // 先清空本地数据，从零开始测
    await page.evaluate(() => {
      localStorage.removeItem("creditPlanner.v1");
      localStorage.removeItem("creditPlanner.backup");
    });
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));

    console.log("1. 打开课程页");
    await page.evaluate(() => { location.hash = "#/courses"; });
    await new Promise((r) => setTimeout(r, 900));

    const hasBtn = await page.evaluate(() => !!document.getElementById("import-open"));
    console.log("   导入按钮存在：", hasBtn);

    console.log("2. 喂入 PDF");
    const b64 = fs.readFileSync(FILE).toString("base64");
    await page.evaluate(async (data) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], "培养方案.pdf", { type: "application/pdf" });
      const input = document.getElementById("import-file");
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    }, b64);

    // 等解析完成（pdf.js 要下载）
    await page.waitForFunction(
      () => {
        const box = document.getElementById("import-result");
        return box && box.querySelector(".import-table");
      },
      { timeout: 60000 }
    );

    const table = await page.evaluate(() => {
      const rows = document.querySelectorAll(".import-table tbody tr");
      const summary = document.querySelector(".import-summary")?.innerText.replace(/\n/g, " ");
      const first = rows[0] ? rows[0].innerText.replace(/\t/g, " | ").replace(/\n/g, " ") : "";
      const cols = rows.length ? rows[0].querySelectorAll("td").length : 0;
      return { rowCount: rows.length, summary, first, cols };
    });
    console.log("   表格行数：", table.rowCount, "｜列数：", table.cols);
    console.log("   概况：", table.summary);
    console.log("   第一行：", table.first);

    console.log("3. 点「确认导入」");
    await page.evaluate(() => {
      const b = document.querySelector('#import-result [data-act="confirm"]');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 2500));

    const after = await page.evaluate(() => ({
      status: document.getElementById("import-status")?.textContent,
      counts: document.getElementById("stat-counts")?.textContent,
      total: document.getElementById("stat-total")?.textContent,
      resultEmpty: !document.querySelector("#import-result .import-table"),
      stored: !!localStorage.getItem("creditPlanner.v1")
    }));
    console.log("   提示：", after.status);
    console.log("   统计：", after.counts, "｜已修学分：", after.total);
    console.log("   面板已收起：", after.resultEmpty);
    console.log("   已写入本机存储：", after.stored);

    console.log("4. 检查导入的课程数据");
    const courses = await page.evaluate(() => {
      const raw = localStorage.getItem("creditPlanner.v1");
      if (!raw) return null;
      const d = JSON.parse(raw);
      return {
        cats: d.categories.map((c) => c.name + "(" + (c.requiredCredits === null ? "空" : c.requiredCredits) + ")"),
        sample: d.courses.slice(0, 5).map((c) => c.name + " " + c.credits + " [" + c.categoryId + "] " + c.status),
        total: d.courses.length
      };
    });
    if (courses) {
      console.log("   板块：", courses.cats.join(" / "));
      console.log("   课程总数：", courses.total);
      courses.sample.forEach((s) => console.log("   ", s));
    }

    console.log("\n6. 重复导入（查重）");
    await page.evaluate(async (data) => {
      const bin = atob(data);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], "培养方案.pdf", { type: "application/pdf" });
      const input = document.getElementById("import-file");
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    }, b64);
    await page.waitForFunction(
      () => document.querySelector("#import-result .import-table"),
      { timeout: 60000 }
    );
    await page.evaluate(() => {
      const b = document.querySelector('#import-result [data-act="confirm"]');
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 2000));
    const after2 = await page.evaluate(() => ({
      status: document.getElementById("import-status")?.textContent,
      counts: document.getElementById("stat-counts")?.textContent
    }));
    console.log("   提示：", after2.status);
    console.log("   统计：", after2.counts);

    await page.screenshot({ path: "e2e-result.png", fullPage: false });
    console.log("\nJS 错误：", errs.length ? errs.join(" | ") : "无");
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error("失败：", e.message);
  process.exit(1);
});