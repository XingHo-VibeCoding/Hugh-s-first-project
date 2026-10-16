/* 实测：浏览器里输入课程名，建议提示真的出现吗？
 *
 * 逻辑测试通过 ≠ 界面能用（元素 id 拼错、CSS 塌了、事件没绑上…）
 * 这一步用无头浏览器走一遍真实交互。
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

const PORT = process.env.PORT || "8905";
const SITE = "http://127.0.0.1:" + PORT;

(async function () {
  console.log("=== 实测：浏览器里的词典建议 ===\n");
  const b = await puppeteer.launch({
    executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
  });
  let fail = 0;
  function ok(label, cond, extra) {
    console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
    if (!cond) fail++;
  }
  try {
    const p = await b.newPage();
    await p.setViewport({ width: 1400, height: 900 });
    await p.goto(SITE + "/index.html", { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 1800));

    // 词典加载了吗
    const hasDict = await p.evaluate(() => !!(window.CourseDictionary && window.CourseDictionary.size));
    ok("词典已在浏览器里加载", hasDict,
       hasDict ? await p.evaluate(() => window.CourseDictionary.size + " 门") : "");

    // 进课程页
    await p.evaluate(() => { location.hash = "#/courses"; });
    await new Promise((r) => setTimeout(r, 900));

    const hintExists = await p.evaluate(() => !!document.getElementById("dict-hint"));
    ok("页面里有 dict-hint 元素", hintExists);

    // ---------- 前置：先建几个板块 ----------
    // ⚠️ 必须先建板块！建议功能的「不瞎填」分支是：
    //    词典建议的板块名，用户没建 → 拒绝并提示去建。
    //    没建板块就测，会误判成「功能坏了」（Day 29 第一次实测就踩了这个）。
    //
    // ⚠️ 还要**一个一个建并等它完成** —— 提交是异步的，
    //    同步循环连着提交 3 次，只有第 1 个生效。
    console.log("\n  前置：先建 3 个板块（模拟真实用户）");
    for (const catName of ["通识必修", "专业核心", "专业选修"]) {
      await p.evaluate(function (n) {
        const inp = document.getElementById("category-name");
        inp.value = n;
        document.getElementById("category-form")
          .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      }, catName);
      await new Promise((r) => setTimeout(r, 900));
    }
    const catCount = await p.evaluate(() => document.getElementById("course-category").options.length);
    const catNames = await p.evaluate(() =>
      Array.from(document.querySelectorAll("#course-category option"))
        .map((o) => o.textContent).join(", "));
    ok("板块已建好 3 个", catCount >= 4, catCount + " 个选项：" + catNames);

    // ---------- 用例 1：输入词典里的课 → 应该出现建议 ----------
    console.log("\n  用例 1：输入「量子力学A」（词典里有，专业核心课程）");
    await p.evaluate(() => {
      const el = document.getElementById("course-name");
      el.value = "量子力学A";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 500));

    let r1 = await p.evaluate(() => {
      const h = document.getElementById("dict-hint");
      return { hidden: h.hidden, text: h.textContent.trim(),
               btns: h.querySelectorAll(".dict-hint-btn").length,
               btnText: h.querySelector(".dict-hint-btn") ? h.querySelector(".dict-hint-btn").textContent : "" };
    });
    ok("提示框显示出来了", r1.hidden === false, r1.text.slice(0, 50));
    ok("有可点的建议按钮", r1.btns > 0, r1.btns + " 个：" + r1.btnText);

    // ---------- 用例 2：点建议 → 板块下拉框应该被选中 ----------
    console.log("\n  用例 2：点建议按钮 → 下拉框应被选中");
    const before = await p.evaluate(() => document.getElementById("course-category").value);
    await p.evaluate(() => {
      const b = document.querySelector("#dict-hint .dict-hint-btn");
      if (b) b.click();
    });
    await new Promise((r) => setTimeout(r, 400));
    const after = await p.evaluate(() => ({
      val: document.getElementById("course-category").value,
      text: document.getElementById("dict-hint").textContent.trim(),
      disabled: document.querySelector("#dict-hint .dict-hint-btn") ? document.querySelector("#dict-hint .dict-hint-btn").disabled : null,
    }));
    ok("点之前下拉框是空的", before === "", "值=" + JSON.stringify(before));
    ok("点之后下拉框有选了", after.val !== "", "值=" + after.val);
    ok("提示文字改成「已按建议选了…」", /已按建议选了/.test(after.text), after.text.slice(0, 40));
    ok("按钮变成 disabled（不能重复点）", after.disabled === true);

    // ---------- 用例 3：词典里没有的课 → 不该有任何提示 ----------
    console.log("\n  用例 3：输入词典里没有的课 → 不该提示");
    await p.evaluate(() => {
      const cat = document.getElementById("course-category");
      cat.value = ""; cat.dispatchEvent(new Event("change", { bubbles: true }));
      const el = document.getElementById("course-name");
      el.value = "这门课词典里肯定没有xyz123";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 400));
    const r3 = await p.evaluate(() => {
      const h = document.getElementById("dict-hint");
      return { hidden: h.hidden, text: h.textContent.trim() };
    });
    ok("提示框是隐藏的（不打扰）", r3.hidden === true, "内容：" + JSON.stringify(r3.text));

    // ---------- 用例 4：全角括号能不能匹配 ----------
    console.log("\n  用例 4：全角括号课程名（大学英语听说（3））");
    await p.evaluate(() => {
      const el = document.getElementById("course-name");
      el.value = "大学英语听说（3）";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 400));
    const r4 = await p.evaluate(() => {
      const h = document.getElementById("dict-hint");
      return { hidden: h.hidden, text: h.textContent.trim() };
    });
    ok("全角括号也能匹配到", r4.hidden === false, r4.text.slice(0, 50));

    // ---------- 用例 5：样式真的生效吗 ----------
    console.log("\n  用例 5：提示框的样式");
    const css = await p.evaluate(() => {
      const h = document.getElementById("dict-hint");
      h.hidden = false;
      const s = getComputedStyle(h);
      return { display: s.display, bg: s.backgroundColor, border: s.borderTopWidth };
    });
    ok("不是 hidden 时 display 正常", css.display !== "none", css.display);
    ok("有背景色（视觉上和表单区分得开）", css.bg !== "rgba(0, 0, 0, 0)", css.bg);
    ok("有边框", parseFloat(css.border) > 0, css.border);

    // ---------- 用例 6：词典被破坏时页面不崩 ----------
    console.log("\n  用例 6：词典坏了页面不能崩");
    await p.evaluate(() => { delete window.CourseDictionary; });
    await p.evaluate(() => {
      const el = document.getElementById("course-name");
      el.value = "量子力学A";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await new Promise((r) => setTimeout(r, 300));
    const alive = await p.evaluate(() => {
      return { ok: document.querySelectorAll("form").length > 0,
               hintHidden: document.getElementById("dict-hint").hidden };
    });
    ok("词典被删后页面仍然正常", alive.ok);
    ok("词典被删后提示框保持隐藏", alive.hintHidden === true);

    console.log("\n=== 结果：" + (fail === 0 ? "全部通过（功能真的能用）" : fail + " 项失败") + " ===");
    process.exit(fail === 0 ? 0 : 1);
  } finally {
    await b.close();
  }
})();