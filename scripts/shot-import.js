// 拍待确认表格的截图（给人看效果用）
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const PAGE_URL = "http://127.0.0.1:8899/index.html";
const FILE = process.argv[2];
const OUT = process.argv[3] || "shot-import.png";

(async () => {
  const browser = await puppeteer.launch({
    headless: "new", executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1400, deviceScaleFactor: 1 });
    await page.goto(PAGE_URL, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1500));
    await page.evaluate(() => { location.hash = "#/courses"; });
    await new Promise((r) => setTimeout(r, 800));

    const b64 = fs.readFileSync(FILE).toString("base64");
    await page.evaluate(async (d) => {
      const bin = atob(d);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const f = new File([arr], "培养方案.pdf", { type: "application/pdf" });
      const input = document.getElementById("import-file");
      const dt = new DataTransfer();
      dt.items.add(f);
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    }, b64);

    await page.waitForFunction(
      () => document.querySelector("#import-result .import-table"),
      { timeout: 60000 }
    );
    await new Promise((r) => setTimeout(r, 600));

    // 滚到导入面板
    await page.evaluate(() => {
      document.getElementById("import-result").scrollIntoView({ block: "start" });
    });
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: OUT });

    const info = await page.evaluate(() => ({
      summary: document.querySelector(".import-summary")?.innerText.replace(/\n/g, " "),
      warn: document.querySelector(".import-warn")?.innerText.slice(0, 120),
      confirmText: document.querySelector('[data-act="confirm"]')?.innerText
    }));
    console.log("概况：", info.summary);
    console.log("提示：", info.warn);
    console.log("按钮：", info.confirmText);
    console.log("已保存：" + OUT);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error("失败：", e.message); process.exit(1); });