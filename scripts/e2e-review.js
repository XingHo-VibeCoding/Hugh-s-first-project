// 凭记忆确认已修 · 端到端测试（Day 26）
// 用法：node scripts/e2e-review.js <培养方案.pdf> [截图路径]
//
// 覆盖的场景：
// 1. 导入培养方案 → 课程全是「计划修」
// 2. 打开清单页 → 默认全部「还没决定」，数据一个字节都没动
// 3. 键盘一路 y / n 标记 → 顶部统计跟着变
// 4. 填一个成绩
// 5. 完成 → 只有标「修过」的变成已修，没确认的保持计划修
// 6. 二次打开清单 → 已修的不再出现（因为清单只列计划修）

const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer-core");

const CHROME =
  "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const BASE = "http://127.0.0.1:8899";
const FILE = process.argv[2];
const SHOT = process.argv[3] || "";
const KEY = "creditPlanner.v1";

if (!FILE) {
  console.log("用法：node scripts/e2e-review.js <培养方案.pdf> [截图路径]");
  process.exit(1);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"]
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 1000 });

  console.log("1. 打开首页，清掉历史数据");
  await page.goto(BASE + "/index.html", { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500));
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 1500));

  console.log("2. 导入培养方案");
  const b64 = fs.readFileSync(FILE).toString("base64");
  await page.evaluate(() => { location.hash = "#/courses"; });
  await new Promise((r) => setTimeout(r, 700));
  await page.evaluate(async (d) => {
    const bin = atob(d);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    const f = new File([a], "培养方案.pdf", { type: "application/pdf" });
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
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate(() => document.querySelector('[data-act="confirm"]').click());
  await new Promise((r) => setTimeout(r, 2500));
  const afterImport = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("creditPlanner.v1"));
    return {
      courses: d.courses.length,
      done: d.courses.filter((c) => c.status === "done").length,
      withTerm: d.courses.filter((c) => c.term).length
    };
  });
  console.log("   导入后：" + JSON.stringify(afterImport));

  console.log("3. 打开清单页（此时不该有任何写入）");
  await page.evaluate(() => document.getElementById("review-open").click());
  await new Promise((r) => setTimeout(r, 500));
  const opened = await page.evaluate(() => ({
    overlayHidden: document.getElementById("review-overlay").hidden,
    rows: document.querySelectorAll(".rv-row").length,
    doneRows: document.querySelectorAll(".rv-row.is-done").length,
    bar: document.getElementById("review-bar").innerText.replace(/\n/g, " "),
    firstRow: document.querySelector(".rv-row") ? document.querySelector(".rv-row").innerText.replace(/\n/g, " ") : ""
  }));
  console.log("   清单行数：" + opened.rows + "（已标记：" + opened.doneRows + "）");
  console.log("   顶部：" + opened.bar);
  console.log("   第一行：" + opened.firstRow);
  const untouched = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("creditPlanner.v1"));
    return d.courses.filter((c) => c.status === "done").length;
  });
  console.log("   打开清单后本地数据里已修门数（应为 0）：" + untouched);

  console.log("4. 键盘标记：前 3 门 y，第 4 门 n，第 5 门 y 并填成绩 88");
  await page.evaluate(() => document.getElementById("review-list").focus());
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("y");
    await new Promise((r) => setTimeout(r, 120));
  }
  await page.keyboard.press("n");
  await new Promise((r) => setTimeout(r, 120));
  await page.keyboard.press("y");
  await new Promise((r) => setTimeout(r, 150));
  // 回到第 5 门填成绩：往上移 0 位（cursor 在 5，press y 后自动前进到 6）
  await page.keyboard.press("k");
  await new Promise((r) => setTimeout(r, 120));
  await page.evaluate(() => {
    const inputs = document.querySelectorAll(".rv-score");
    const idx = [...document.querySelectorAll(".rv-row")].findIndex((r) => r.classList.contains("is-cursor"));
    const input = inputs[idx];
    input.value = "88";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise((r) => setTimeout(r, 300));
  const marked = await page.evaluate(() => ({
    bar: document.getElementById("review-bar").innerText.replace(/\n/g, " "),
    done: document.querySelectorAll(".rv-row.is-done").length,
    skip: document.querySelectorAll(".rv-row.is-skip").length,
    note: document.getElementById("review-note").hidden
  }));
  console.log("   标记后：" + marked.bar);
  console.log("   标修过 " + marked.done + " 门 / 标没修 " + marked.skip + " 门");

  if (SHOT) {
    await page.screenshot({ path: SHOT });
    console.log("   已截图：" + SHOT);
  }

  console.log("5. 完成保存");
  await page.evaluate(() => document.querySelector('[data-act="confirm"]').click());
  await new Promise((r) => setTimeout(r, 2000));
  const afterConfirm = await page.evaluate(() => {
    const d = JSON.parse(localStorage.getItem("creditPlanner.v1"));
    const done = d.courses.filter((c) => c.status === "done");
    const planned = d.courses.filter((c) => c.status === "planned");
    return {
      overlayHidden: document.getElementById("review-overlay").hidden,
      note: document.getElementById("review-note").textContent.slice(0, 120),
      doneCount: done.length,
      plannedCount: planned.length,
      doneWithScore: done.filter((c) => c.score !== null && c.score !== undefined).length,
      sampleDone: done.map((c) => c.name + "/" + c.credits + "/" + c.score).slice(0, 6),
      statTotal: document.getElementById("stat-total") ? document.getElementById("stat-total").textContent : ""
    };
  });
  console.log("   " + JSON.stringify(afterConfirm, null, 1));

  console.log("6. 再打开清单：已修的不该再出现");
  await page.evaluate(() => document.getElementById("review-open").click());
  await new Promise((r) => setTimeout(r, 500));
  const reopen = await page.evaluate(() => ({
    rows: document.querySelectorAll(".rv-row").length,
    bar: document.getElementById("review-bar").innerText.replace(/\n/g, " ")
  }));
  console.log("   剩余待确认：" + reopen.rows + "（" + reopen.bar + "）");
  await page.evaluate(() => document.querySelector('[data-act="close"]').click());

  console.log("");
  console.log(errors.length ? "JS 错误：" + errors.join(" | ") : "无 JS 错误");
  await browser.close();
})();
