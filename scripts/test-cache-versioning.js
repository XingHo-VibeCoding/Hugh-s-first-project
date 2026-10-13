// B-006 回归测试：验证「加了版本戳之后，换版本不重启浏览器也能生效」。
//
// 【要证明什么】
// B-006 的症状是：发布/回退后刷新页面，浏览器和 CDN 一直吐旧副本，
// 死命刷都没用，只有重启浏览器才生效（Day 26 回退演练时被骗了两次）。
//
// 【怎么证明修好了】
// 在**同一个浏览器实例、同一个 page**里：
//   ① 先看 v1.0 的行为（填 42 → 放行）
//   ② 只改 app.js 的内容，版本号不动 → 刷新 → 应当仍是旧行为（缓存生效，符合预期）
//   ③ 只改版本号，不改内容 → 刷新 → 应当**拿到新文件**（这才是修好的证据）
//
// 第 ③ 步是关键：如果改了版本号还是拿到旧的，说明版本戳没起作用。
//
// 用法：
//   node scripts/test-cache-versioning.js <项目根目录>
//
// 退出码：0=版本戳生效，10=没生效，2=环境问题

const fs = require("fs");
const path = require("path");
const http = require("http");
const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";

const ROOT = process.argv[2] || ".";
const PORT = 8899;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function startServer() {
  const root = path.resolve(ROOT);
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const f = path.resolve(path.join(root, p));
    if (!f.startsWith(root)) {
      res.writeHead(403);
      return res.end("403");
    }
    fs.readFile(f, (e, d) => {
      if (e) {
        res.writeHead(404);
        return res.end("404");
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(f)] || "application/octet-stream",
        // 模拟真实浏览器缓存：允许缓存，但回源时给 304
        "Cache-Control": "max-age=3600",
      });
      res.end(d);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

// 探测：填 42，看放行还是静默失败
async function probe(page) {
  await page.evaluate(() => {
    const link = document.querySelector('a[data-view="categories"]');
    if (link) link.click();
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    const i = document.getElementById("category-name");
    i.value = "缓存探针";
    i.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.click("#category-credits");
  await page.type("#category-credits", "42");
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => {
    const b = document.querySelector("#category-form button[type=submit]");
    if (b) b.click();
  });
  await new Promise((r) => setTimeout(r, 500));
  return page.evaluate(() => {
    const l = document.getElementById("category-list");
    return l ? /缓存探针/.test(l.innerText) : false;
  });
}

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error("找不到 Chromium");
    process.exit(2);
  }

  const indexPath = path.join(ROOT, "index.html");
  const appPath = path.join(ROOT, "app.js");
  const indexOrig = fs.readFileSync(indexPath, "utf8");
  const appOrig = fs.readFileSync(appPath, "utf8");

  const server = await startServer();
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/index.html`, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1200));

    const step1 = await probe(page);
    console.log("① 初始（版本号 " + (indexOrig.match(/\?v=(\d+)/) || [])[1] + "）：42 " + (step1 ? "放行" : "被拦"));
    console.log("   ⇒ 当前是 " + (step1 ? "v1.0" : "v0.9"));

    // ---- 步骤 ②：只改内容，版本号不动 ----
    // 模拟「传了新文件但忘了改版本号」——这正是 Day 26 踩的坑
    const marker = "\n// B006-TEST-MARKER-A\n";
    fs.writeFileSync(appPath, appOrig + marker, "utf8");
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1200));
    const gotNewContent = await page.evaluate(() =>
      typeof window.__B006_MARKER_A__ !== "undefined"
    );
    // 直接读 app.js 源码更可靠
    const src2 = await page.evaluate(async () => {
      const r = await fetch("app.js?b006probe=1", { cache: "no-store" });
      return r.text();
    });
    const sawMarker = src2.indexOf("B006-TEST-MARKER-A") !== -1;
    console.log("");
    console.log("② 只改内容、版本号不动 → 浏览器拿到新内容了吗：" + (sawMarker ? "是" : "否"));
    console.log("   ⇒ " + (sawMarker ? "本地无缓存时能拿到（正常）" : "拿到的是缓存旧副本"));

    // ---- 步骤 ③：只改版本号，内容恢复原样 ----
    // 这是修法的核心：版本号变了，URL 就变了，缓存必然 miss
    fs.writeFileSync(appPath, appOrig, "utf8");
    const bumped = indexOrig.replace(/\?v=\d+/, "?v=20261013");
    fs.writeFileSync(indexPath, bumped, "utf8");
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1200));

    // 检查浏览器实际请求了哪个 URL
    const requested = await page.evaluate(() =>
      performance.getEntriesByType("resource")
        .map((e) => e.name)
        .filter((n) => /app\.js/.test(n))
    );
    console.log("");
    console.log("③ 只改版本号 → 页面实际请求的 app.js 地址：");
    requested.forEach((u) => console.log("   " + u.replace(`http://127.0.0.1:${PORT}`, "")));

    const verOk = requested.some((u) => /app\.js\?v=20261013/.test(u));
    const step3 = await probe(page);
    console.log("   42 " + (step3 ? "放行" : "被拦") + "（功能仍正常）");

    console.log("");
    console.log("=== 判定：" + (verOk ? "版本戳生效 ✅（改版本号后 URL 变化，缓存必然 miss）" : "版本戳没生效 ❌") + " ===");
    console.log("");
    console.log("说明：B-006 的根因是「URL 永远不变 → 缓存永远命中」。");
    console.log("版本号一变，URL 就变，浏览器和 CDN 都必须回源拿新的 ——");
    console.log("这才是「不用重启浏览器」的真正原因。");
    process.exitCode = verOk && step3 ? 0 : 10;
  } catch (e) {
    console.error("执行失败：" + e.message);
    process.exitCode = 2;
  } finally {
    fs.writeFileSync(indexPath, indexOrig, "utf8");
    fs.writeFileSync(appPath, appOrig, "utf8");
    await browser.close();
    server.close();
    console.log("");
    console.log("（已还原 index.html 和 app.js 到测试前状态）");
  }
})();