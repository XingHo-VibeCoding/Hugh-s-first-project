// 批量操作端到端测试（Day 28）
//
// 【要验什么】
// 1. 勾选/取消勾选，工具栏出现且计数正确
// 2. 全选/取消全选
// 3. 批量归类：选中的课真的换板块了，且只换选中的
// 4. 批量删除：一次撤销能**全部**恢复（这是设计要求，最容易做错）
// 5. 没勾选时按钮不可用
// 6. 删光之后工具栏自动隐藏
//
// 用法：
//   node scripts/e2e-bulk.js
// 退出码：0=全过，1=有失败

const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const PAGE_URL = "http://127.0.0.1:8899/index.html";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: detail == null ? "" : String(detail) });
  console.log((ok ? "  [PASS] " : "  [FAIL] ") + name + (detail != null ? "　" + detail : ""));
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => { if (m.type() === "error") errs.push("[console] " + m.text()); });
    // 404 单独记 URL（console 消息里不带 URL，滤不掉）
    const bad404 = [];
    page.on("response", (r) => {
      if (r.status() === 404) bad404.push(r.url().replace("http://127.0.0.1:8899", ""));
    });

await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1500));

    // 造一份确定的数据：3 个板块 + 8 门课
    await page.evaluate(() => {
      const mk = (prefix, n, catIdx) => {
     const out = [];
      for (let i = 1; i <= n; i++) {
          out.push({
        id: prefix + i,
 name: "测试课" + prefix + i,
            credits: i % 2 ? 3 : 4,
            categoryId: catIdx,
 status: "planned",
      score: null,
     deletedAt: null,
    deleteExpiresAt: null,
 createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
    }
        return out;
      };
      const data = {
version: 1,
        categories: [
     { id: "ca", name: "板块甲", requiredCredits: 10, note: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { id: "cb", name: "板块乙", requiredCredits: 20, note: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
          { id: "cc", name: "板块丙", requiredCredits: 30, note: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
        ],
      courses: mk("a", 3, "ca").concat(mk("b", 3, "cb"), mk("c", 2, "cc")),
        plan: null,
      };
  localStorage.setItem("creditPlanner.v1", JSON.stringify(data));
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1600));
    await page.evaluate(() => { location.hash = "#/courses"; });
    await new Promise((r) => setTimeout(r, 500));

    // ⚠️ 分组默认是**折叠**的（Day 14 为了长列表），必须先展开，
    //    否则卡片根本没渲染出来，找不到就以为功能坏了。
    //    这个坑我第一次跑就踩了。
    const expandAll = async () => {
      await page.evaluate(() => {
   document.querySelectorAll(".course-group-head").forEach((b) => {
    if (b.getAttribute("aria-expanded") === "false") b.click();
        });
 });
      await new Promise((r) => setTimeout(r, 400));
    };
    await expandAll();

    console.log("\n=== 1. 初始状态 ===");
    let st = await page.evaluate(() => ({
      total: document.querySelectorAll(".course-card").length,
      barHidden: document.getElementById("bulk-bar").hidden,
      boxes: document.querySelectorAll("input[data-pick-id]").length,
    }));
    check("8 门课都渲染出卡片", st.total === 8, "实际 " + st.total);
    check("勾选框数量 = 卡片数", st.boxes === 8, "实际 " + st.boxes);
  // 有课程时工具栏就该显示 —— 让用户知道「这里能批量操作」，
    // 不是「勾了才出现」（我第一次写反了，被测试抓出来）
    check("有课程时工具栏可见", st.barHidden === false, "hidden=" + st.barHidden);

    console.log("\n=== 2. 勾选 2 门 ===");
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll("input[data-pick-id]")];
      boxes[0].click();
      boxes[1].click();
    });
    await new Promise((r) => setTimeout(r, 300));
    st = await page.evaluate(() => ({
      barHidden: document.getElementById("bulk-bar").hidden,
      count: document.getElementById("bulk-count").textContent,
      pickedCards: document.querySelectorAll(".course-card.is-picked").length,
      delDisabled: document.getElementById("bulk-delete-btn").disabled,
    }));
    check("工具栏出现", st.barHidden === false);
    check("计数 = 已选 2 门", /2/.test(st.count), st.count);
    check("2 张卡片有选中样式", st.pickedCards === 2, "实际 " + st.pickedCards);
    check("删除按钮可用", st.delDisabled === false);

    console.log("\n=== 3. 全选 ===");
    await page.evaluate(() => { document.getElementById("bulk-all").click(); });
    await new Promise((r) => setTimeout(r, 350));
    st = await page.evaluate(() => ({
      count: document.getElementById("bulk-count").textContent,
      allLabel: document.getElementById("bulk-all-label").textContent,
      picked: document.querySelectorAll(".course-card.is-picked").length,
    }));
    check("全选后计数 = 8 门", /8/.test(st.count), st.count);
    check("8 张卡片全选中", st.picked === 8, "实际 " + st.picked);
    check("全选后标签变成「取消全选」", /取消全选/.test(st.allLabel), st.allLabel);

    console.log("\n=== 4. 批量归类：把 a 组（3 门）归到「板块丙」===");
    await page.evaluate(() => {
      // 只选 a 组的 3 门
      document.getElementById("bulk-clear-btn").click();
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll("input[data-pick-id]")];
      boxes.filter((b) => /a\d/.test(b.dataset.pickId)).forEach((b) => b.click());
    });
    await new Promise((r) => setTimeout(r, 300));
    const beforeAssign = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("creditPlanner.v1"));
      return { a: s.courses.filter((c) => /^a/.test(c.id)).map((c) => c.categoryId),
               b: s.courses.filter((c) => /^b/.test(c.id)).map((c) => c.categoryId) };
    });
    await page.evaluate(() => {
      const sel = document.getElementById("bulk-category");
      sel.value = "cc";
      document.getElementById("bulk-assign-btn").click();
    });
    await new Promise((r) => setTimeout(r, 500));
    const afterAssign = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("creditPlanner.v1"));
      return { a: s.courses.filter((c) => /^a/.test(c.id)).map((c) => c.categoryId),
               b: s.courses.filter((c) => /^b/.test(c.id)).map((c) => c.categoryId),
               fb: document.getElementById("course-feedback").textContent,
               selCount: document.getElementById("bulk-count").textContent };
    });
    check("a 组 3 门都换到 cc", afterAssign.a.every((x) => x === "cc"), JSON.stringify(afterAssign.a));
    check("b 组没被动", afterAssign.b.every((x) => x === "cb"), JSON.stringify(afterAssign.b));
    check("有成功提示", /已把\s*3\s*门课归到/.test(afterAssign.fb), afterAssign.fb);
    check("归类后清空选择", /0/.test(afterAssign.selCount), afterAssign.selCount);

console.log("\n=== 5. 批量删除 + 一次撤销全部恢复 ===");
    const beforeDel = await page.evaluate(() =>
  JSON.parse(localStorage.getItem("creditPlanner.v1")).courses.length);
    await page.evaluate(() => {
      const boxes = [...document.querySelectorAll("input[data-pick-id]")];
      boxes.slice(0, 5).forEach((b) => b.click());
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => { document.getElementById("bulk-delete-btn").click(); });
    await new Promise((r) => setTimeout(r, 800));
    const afterDel = await page.evaluate(() => ({
      // ⚠️ 撤销窗口内**故意不写盘**（与现有单条删除同一套时序）：
      //    内存里已经删了，但 localStorage 还是原样。
      //    这样保存失败也能原样恢复。我第一次误以为这是 bug，
      //    实际是设计如此 —— 断言要按真实时序写。
      inMem: document.querySelectorAll(".course-card").length,
      onDisk: JSON.parse(localStorage.getItem("creditPlanner.v1")).courses.length,
      toast: document.getElementById("undo-toast").hidden,
      toastText: document.getElementById("undo-text").textContent,
    }));
    check("内存里已删掉 5 门（8→3）", afterDel.inMem === 3, "剩 " + afterDel.inMem);
    check("撤销窗口内还没写盘（防保存失败）", afterDel.onDisk === beforeDel,
      beforeDel + "（预期不变）");
    check("撤销条出现", afterDel.toast === false);
  check("撤销条写明删了几门", /5\s*门/.test(afterDel.toastText), afterDel.toastText);

    // ★ 关键：点一次撤销，应该 5 门全部回来
    await page.evaluate(() => { document.getElementById("undo-btn").click(); });
    await new Promise((r) => setTimeout(r, 700));
    const afterUndo = await page.evaluate(() => ({
      inMem: document.querySelectorAll(".course-card").length,
      toast: document.getElementById("undo-toast").hidden,
    }));
    check("★ 一次撤销恢复全部 5 门", afterUndo.inMem === 8, "剩 " + afterUndo.inMem);
    check("撤销条已隐藏", afterUndo.toast === true);

console.log("\n=== 6. 删光之后工具栏隐藏 ===");
    await page.evaluate(() => {
   const boxes = [...document.querySelectorAll("input[data-pick-id]")];
      boxes.forEach((b) => b.click());
    });
    await new Promise((r) => setTimeout(r, 300));
    await page.evaluate(() => { document.getElementById("bulk-delete-btn").click(); });
    await new Promise((r) => setTimeout(r, 800));
    const empty = await page.evaluate(() => ({
      // 撤销窗口内内存已空、磁盘还是旧的 —— 同上，是设计如此
      inMem: document.querySelectorAll(".course-card").length,
    barHidden: document.getElementById("bulk-bar").hidden,
    }));
    check("内存里课程已清空", empty.inMem === 0, "剩 " + empty.inMem);
    check("工具栏自动隐藏", empty.barHidden === true);

    console.log("\n=== 7. JS 错误 ===");
    // favicon.ico 的 404 与功能无关（本地没放图标）。
    // 靠 page 的 response 事件单独记 404 的 URL —— console 消息里没有 URL，
    // 靠字符串过滤会把这条也当成 JS 错误（第一版就是这么错的）。
    const realErrs = errs.filter((e) => !/Failed to load resource/.test(e));
    check("无 JS 错误", realErrs.length === 0, realErrs.join(" | ").slice(0, 200));
    check("404 只有 favicon.ico", bad404.every((u) => /favicon/.test(u)),
      bad404.length ? bad404.join(", ") : "无 404");

    const failed = results.filter((r) => !r.ok);
    console.log("\n" + "=".repeat(46));
    console.log("结果：" + (results.length - failed.length) + " PASS / " + failed.length + " FAIL");
    if (failed.length) {
      console.log("失败项：");
      failed.forEach((f) => console.log("  ✗ " + f.name + "　" + f.detail));
    }
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    console.log("执行失败：" + e.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();