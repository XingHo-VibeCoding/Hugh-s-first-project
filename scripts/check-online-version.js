// 上线校验：判断一个地址上跑的是哪一版（v0.9 还是 v1.0）。
//
// 【为什么不能用 curl】
// CloudBase 静态托管对非浏览器请求一律回 418（Content-Length: 0），
// 换 UA、加 Referer、强制 HTTP/1.1 都一样。而不存在的路径是连接失败（000），
// 所以 418 只能说明「这个文件在 CloudBase 上存在」，说明不了它是哪一版。
//
// 【为什么直接读 app.js 源码，而不是在页面里取变量】
// app.js 顶层的 const 属于全局词法环境，不同浏览器/上下文对它的可见性不一致
// （第一次写这个脚本时就踩到了：new Function("typeof X") 生成的是表达式语句，
//  没有 return，取出来是 undefined，看着像「不是新版」）。
// 读源码字符串是确定的，两个版本各自有什么标记就找什么标记，不猜。
//
// 用法：
//   set NODE_PATH=C:\Users\w3224\.workbuddy\binaries\node\workspace\node_modules
//   node scripts/check-online-version.js <地址>
//
// 退出码：0=v1.0，10=v0.9 或更早，2=打不开

const fs = require("fs");
const puppeteer = require("puppeteer-core");

// agent-browser 已下载的 Chromium，不必再下一份
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";

const URL = process.argv[2];
if (!URL) {
  console.log("用法：node scripts/check-online-version.js <地址>");
  process.exit(1);
}

// v1.0 独有标记。三个都在，才算 v1.0 —— 少一个都可能是半上传。
const MARKERS_V1 = [
  { key: "MAX_REQUIRED_CREDITS", desc: "板块要求学分上限常量（99.99）" },
  { key: "要求学分不能超过 99.99", desc: "要求学分上限文案已放宽" },
  { key: "MAX_REQUIRED_CREDITS", desc: "实时提示补了上限检查" },
];

// v0.9 独有标记：只要还在，就说明是旧版
const MARKERS_OLD = [
  { key: 'const REQUIRED_CREDIT_OVER_HINT = "要求学分不能超过 9.99"', desc: "旧版：要求学分上限卡 9.99" },
];

(async () => {
  if (!fs.existsSync(CHROME)) {
    console.error("找不到 Chromium：" + CHROME);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    const notFound = [];
    const failed = [];
    page.on("response", (r) => {
      if (r.status() === 404) notFound.push(r.url());
    });
    page.on("requestfailed", (r) => {
      // favicon 之类的无关失败不报
      if (!/favicon/.test(r.url())) failed.push(r.url() + " :: " + (r.failure() || {}).errorText);
    });

    const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = resp ? resp.status() : 0;
    console.log("地址      ：" + URL);
    console.log("HTTP 状态：" + status);
    console.log("页面标题  ：" + (await page.title()));

    if (status >= 400) {
      console.log("");
      console.log("=== 判定：页面打不开，无法判断版本 ===");
      process.exitCode = 2;
      return;
    }

    await new Promise((r) => setTimeout(r, 1200));

    // 关键入口是否真的在 DOM 里
    const ui = await page.evaluate(() => {
      const t = document.body ? document.body.innerText : "";
      const html = document.documentElement.innerHTML;
      return {
        importer: /导入培养方案|导入PDF|导入文件|培养方案导入/.test(t + html),
        review: /凭记忆|确认已修|已修课程清单|凭记忆确认/.test(t + html),
        scripts: Array.from(document.querySelectorAll("script[src]")).map((s) => s.getAttribute("src")),
      };
    });
    console.log("");
    console.log("「导入培养方案」入口：" + (ui.importer ? "有" : "无"));
    console.log("「凭记忆确认已修」入口：" + (ui.review ? "有" : "无"));
    console.log("引用的本地脚本（" + ui.scripts.length + " 个）：");
    ui.scripts.forEach((s) => console.log("  - " + s));

    // 直接读 app.js 源码判版本
    const src = await page.evaluate(async () => {
      const r = await fetch("app.js?ts=" + Date.now(), { cache: "no-store" });
      if (!r.ok) return { ok: false, status: r.status };
      return { ok: true, text: await r.text() };
    });

    console.log("");
    if (!src.ok) {
      console.log("app.js 读取失败：HTTP " + src.status);
      console.log("=== 判定：无法判断版本 ===");
      process.exitCode = 2;
      return;
    }

    console.log("app.js 大小：" + src.text.length + " 字符");
    const has = (k) => src.text.indexOf(k) !== -1;

    const v1Hits = MARKERS_V1.filter((m) => has(m.key));
    const oldHits = MARKERS_OLD.filter((m) => has(m.key));

    console.log("");
    console.log("--- v1.0 标记 ---");
    v1Hits.forEach((m) => console.log("  ✓ " + m.desc));
    const missV1 = MARKERS_V1.filter((m) => !has(m.key));
    missV1.forEach((m) => console.log("  ✗ " + m.desc + "（缺）"));

    console.log("--- 旧版标记 ---");
    if (oldHits.length === 0) console.log("  （无旧版标记）");
    oldHits.forEach((m) => console.log("  ! " + m.desc));

    const isV1 = v1Hits.length === MARKERS_V1.length && oldHits.length === 0;
    console.log("");
    console.log("=== 判定：" + (isV1 ? "v1.0" : "v0.9 或更早") + " ===");

    if (notFound.length) {
      console.log("");
      console.log("404 的资源（线上不存在这些文件）：");
      notFound.forEach((u) => console.log("  ! " + u));
    }
    if (failed.length) {
      console.log("");
      console.log("加载失败：");
      failed.forEach((u) => console.log("  ! " + u));
    }

    process.exitCode = isV1 ? 0 : 10;
  } catch (e) {
    console.error("打开失败：" + e.message);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
