// 板块上限行为探针：用一个只有 v1.0 才会放行的输入，判断页面跑的是哪一版。
//
// 【为什么不能靠 app.js 源码判定】
// CloudBase 默认域名对我的网络出口返回 418，拿不到源码。
// 用户浏览器能打开，但我读不到 —— 所以改成「在页面上做一次真实操作，看结果」。
//
// 【探针原理】
// 板块「要求学分」上限：
//   v0.9 及更早 → 9.99   → 填 42 被拦（提示「要求学分不能超过 9.99」）
//   v1.0        → 99.99  → 填 42 放行
// 线上有真实的 42 学分板块（专业核心），这个输入必须放行才是正确的。
//
// 用法：
//   set NODE_PATH=...\node_modules
//   node scripts/probe-version-by-behavior.js <地址>
// 退出码：0=v1.0，10=v0.9 或更早，2=打不开，3=页面结构不认识

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";

const URL = process.argv[2];
if (!URL) {
  console.log("用法：node scripts/probe-version-by-behavior.js <地址>");
  process.exit(1);
}

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
    const resp = await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    const status = resp ? resp.status() : 0;
    console.log("地址      ：" + URL);
    console.log("HTTP 状态：" + status);
    if (status >= 400) {
      console.log("=== 判定：页面打不开 ===");
      process.exitCode = 2;
      return;
    }
    await new Promise((r) => setTimeout(r, 1200));

    // 切到板块页
    await page.evaluate(() => {
      const link = document.querySelector('a[data-view="categories"]');
      if (link) link.click();
    });
    await new Promise((r) => setTimeout(r, 500));

    const hasForm = await page.$("#category-name");
    if (!hasForm) {
      console.log("找不到 #category-name，页面结构可能变了");
      process.exitCode = 3;
      return;
    }

    // 找「要求学分」输入框
    const creditSel = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll("#view-categories input"));
      // 按 placeholder 里带「学分」且不是「板块名」的那个
      const hit = inputs.find((i) => /学分/.test(i.placeholder || "") && !/板块名/.test(i.placeholder || ""));
      if (!hit) return null;
      return hit.id || null;
    });
    console.log("要求学分输入框 id：" + (creditSel || "(没找到)"));
    if (!creditSel) {
      process.exitCode = 3;
      return;
    }

    // 填一个 v0.9 一定会拦、v1.0 一定会放行的值：42
    await page.evaluate(() => {
      const inp = document.getElementById("category-name");
      inp.value = "版本探针";
      inp.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const creditBox = "#" + creditSel;
    await page.click(creditBox);
    await page.type(creditBox, "42");
    await new Promise((r) => setTimeout(r, 700));

    // 提示在 #category-error（index.html 里 <p class="form-error" id="category-error" hidden>）
    // 实时提示可能在 #category-credits 相邻的元素上，两个都读
    const readHints = async () =>
      page.evaluate(() => {
        const pick = (id) => {
          const e = document.getElementById(id);
          if (!e) return null;
          return { hidden: e.hidden, text: (e.textContent || "").trim() };
        };
        return {
          error: pick("category-error"),
          feedback: pick("category-feedback"),
        };
      });

    // 先读实时提示（还没提交）
    const live = await readHints();
    console.log("实时提示 #category-feedback：" + (live.feedback ? `"${live.feedback.text}" hidden=${live.feedback.hidden}` : "(无此元素)"));
    console.log("实时提示 #category-error  ：" + (live.error ? `"${live.error.text}" hidden=${live.error.hidden}` : "(无此元素)"));

    // 提交，看是否被拦
    await page.evaluate(() => {
      const b = document.querySelector("#category-form button[type=submit]");
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 900));

    const after = await readHints();
    console.log("");
    console.log("--- 提交后 ---");
    console.log("#category-feedback：" + (after.feedback ? `"${after.feedback.text}" hidden=${after.feedback.hidden}` : "(无)"));
    console.log("#category-error  ：" + (after.error ? `"${after.error.text}" hidden=${after.error.hidden}` : "(无)"));

    const allText = [live.error && live.error.text, live.feedback && live.feedback.text,
                     after.error && after.error.text, after.feedback && after.feedback.text]
      .filter(Boolean).join(" ｜ ");
    const blocked = /不能超过\s*9\.99/.test(allText);
    const allowed = /不能超过\s*99\.99/.test(allText);

    // 有没有真的添加成功（能进列表）
    const added = await page.evaluate(() => {
      const l = document.getElementById("category-list");
      return l ? /版本探针/.test(l.innerText) : false;
    });

    console.log("");
    console.log("--- 判定依据 ---");
    console.log("提示含「不能超过 9.99」 ：" + (blocked ? "是" : "否"));
    console.log("提示含「不能超过 99.99」：" + (allowed ? "是" : "否"));
    console.log("板块真的加进列表了：" + (added ? "是（42 被放行）" : "否"));

    // ⚠️ 关键判据：v0.9 提交 42 时是**静默失败** ——
    // 既不提示「不能超过 9.99」，也**不显示任何错误**，板块就是加不进去。
    // 这一点是 B-004 漏检的完整表现（提交校验有、实时提示没有）。
    // 所以「42 有没有加进去」比「提示文案是什么」更可靠：
    // 前者两个版本都有明确结果（加进去 / 没加进去），后者旧版压根没有文案。
    if (added) {
      console.log("");
      console.log("说明：42 放行且提示为「✓ 已添加板块」→ 上限是 99.99 → v1.0");
      console.log("=== 判定：v1.0 ===");
      process.exitCode = 0;
    } else if (blocked) {
      console.log("");
      console.log("说明：42 被拦且提示 9.99 → v0.9 或更早");
      console.log("=== 判定：v0.9 或更早 ===");
      process.exitCode = 10;
    } else {
      console.log("");
      console.log("说明：42 没加进去，但也没任何错误提示 —— **静默失败**");
      console.log("      这是 v0.9 的已知表现（实时提示漏了上限检查）");
      console.log("=== 判定：v0.9 或更早（静默失败） ===");
      process.exitCode = 10;
    }
  } catch (e) {
    console.error("执行失败：" + e.message);
    process.exitCode = 2;
  } finally {
    await browser.close();
  }
})();
