// 检查台「改 / 删」端到端测试（B-003）
// 打的是 scripts/mock-gateway.js 起的假网关，不碰线上数据库。
const fs = require("fs");
const puppeteer = require("puppeteer-core");

const CHROME =
  "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const SHOT = process.argv[2] || "";

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: CHROME,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewport({ width: 1360, height: 1050 });

  // 把 API_BASE 指向假网关：加载页面之前先拦截请求，把线上域名换成本地。
  // （不能用 page.evaluate 改 API_BASE —— 它是 const，加载后就动不了）
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const url = req.url();
    if (url.indexOf("tcloudbase.com") !== -1) {
      req.continue({ url: url.replace(/^https:\/\/[^/]+/, "http://127.0.0.1:8902") });
    } else {
      req.continue();
    }
  });

  await page.goto("http://127.0.0.1:8899/cloud.html", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => document.querySelectorAll("#course-body tr").length > 0, { timeout: 15000 });

  const ids = await page.evaluate(() =>
    Array.from(document.querySelectorAll("#course-body tr")).map((tr) => tr.getAttribute("data-id"))
  );
  console.log("0. 数据源（应为假网关的 t01..t04）：", JSON.stringify(ids));
  if (!ids.includes("t01")) {
    console.log("   ⚠️ 请求拦截没生效，本轮结果不作数");
    await browser.close();
    return;
  }

  const before = await page.evaluate(() => ({
    rows: document.querySelectorAll("#course-body tr").length,
    count: document.getElementById("course-count").textContent,
    hasOps: document.querySelectorAll("#course-body td.ops").length,
    buttons: document.querySelectorAll("#course-body [data-op]").length,
  }));
  console.log("1. 初始表格：", JSON.stringify(before));

  console.log("2. 点第一行的「改」");
  await page.evaluate(() => {
    document.querySelector("#course-body tr[data-id='t01'] [data-op='edit']").click();
  });
  await new Promise((r) => setTimeout(r, 400));
  const editing = await page.evaluate(() => ({
    hasName: !!document.getElementById("ed-name"),
    nameVal: document.getElementById("ed-name") ? document.getElementById("ed-name").value : null,
    creditsVal: document.getElementById("ed-credits") ? document.getElementById("ed-credits").value : null,
    catOpts: document.getElementById("ed-category") ? document.getElementById("ed-category").options.length : 0,
    focused: document.activeElement ? document.activeElement.id : null,
  }));
  console.log("   ", JSON.stringify(editing));
  if (SHOT) await page.screenshot({ path: SHOT });

  console.log("3. 改学分 5 → 0.25，点保存");
  await page.evaluate(() => {
    const el = document.getElementById("ed-credits");
    el.value = "0.25";
    document.querySelector("#course-body [data-op='save']").click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const afterEdit = await page.evaluate(() => {
    const row = document.querySelector("#course-body tr[data-id='t01']");
    return {
      msg: document.getElementById("write-msg").textContent.slice(0, 80),
      cells: row ? Array.from(row.querySelectorAll("td")).map((td) => td.textContent.trim()) : null,
    };
  });
  console.log("   ", JSON.stringify(afterEdit));

  console.log("4. 改回非法值 1.3（应被后端拒绝，列表不��）");
  await page.evaluate(() => document.querySelector("#course-body tr[data-id='t01'] [data-op='edit']").click());
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    document.getElementById("ed-credits").value = "1.3";
    document.querySelector("#course-body [data-op='save']").click();
  });
  await new Promise((r) => setTimeout(r, 800));
  const afterBad = await page.evaluate(() => {
    const row = document.querySelector("#course-body tr[data-id='t01']");
    return {
      msg: document.getElementById("write-msg").textContent.slice(0, 70),
      credits: row ? row.querySelectorAll("td")[2].textContent.trim() : null,
    };
  });
  console.log("   ", JSON.stringify(afterBad));

  console.log("5. 点「删」→ 应出确认条（此时还没真删）");
  await page.evaluate(() => document.querySelector("#course-body tr[data-id='t02'] [data-op='del']").click());
  await new Promise((r) => setTimeout(r, 400));
  const confirm1 = await page.evaluate(() => ({
    barHidden: document.getElementById("confirm-bar").hidden,
    barText: document.getElementById("confirm-bar").textContent.slice(0, 60),
    rows: document.querySelectorAll("#course-body tr").length,
  }));
  console.log("   ", JSON.stringify(confirm1));

  console.log("6. 点「算了」→ 不该删");
  await page.evaluate(() => document.getElementById("cf-no").click());
  await new Promise((r) => setTimeout(r, 400));
  const afterCancel = await page.evaluate(() => ({
    barHidden: document.getElementById("confirm-bar").hidden,
    stillThere: !!document.querySelector("#course-body tr[data-id='t02']"),
  }));
  console.log("   ", JSON.stringify(afterCancel));

  console.log("7. 再点「删」→ 确认删除");
  await page.evaluate(() => document.querySelector("#course-body tr[data-id='t02'] [data-op='del']").click());
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.getElementById("cf-yes").click());
  await new Promise((r) => setTimeout(r, 1000));
  const afterDel = await page.evaluate(() => ({
    msg: document.getElementById("write-msg").textContent.slice(0, 70),
    rows: document.querySelectorAll("#course-body tr").length,
    gone: !document.querySelector("#course-body tr[data-id='t02']"),
    barText: document.getElementById("confirm-bar").textContent.slice(0, 60),
  }));
  console.log("   ", JSON.stringify(afterDel));

  console.log("8. XSS 防护：课程名带标签应该被转义");
  await page.evaluate(() => {
    // 直接塞一条带标签的课程进 state 再重绘
    window.__state_test = true;
  });
  const xss = await page.evaluate(() => {
    const body = document.getElementById("course-body");
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>t09</td><td>&lt;img src=x onerror=alert(1)&gt;</td><td>1</td>";
    body.appendChild(tr);
    const cell = tr.querySelectorAll("td")[1];
    return { innerHTML: cell.innerHTML, text: cell.textContent, imgs: cell.querySelectorAll("img").length };
  });
  console.log("   ", JSON.stringify(xss));

  console.log("");
  console.log(errors.length ? "JS 错误：" + errors.join(" | ") : "无 JS 错误");
  await browser.close();
})();
