// 诊断脚本：查清「PDF 合并单元格」里板块归属错配的根因。
//
// 【Day 28 发现的真bug】
// 用户导出后发现：「大学英语听说」被归到了综合实践板块、
// 「量子力学A」被归到了新生研讨课程 —— 板块归属全乱了。
//
// 【实测拿到的关键证据（这份脚本跑出来的）】
// 表格在第 4~9 页（用「课程号 YN25…」定位，正文里没有这个）。
// 以量子力学那一段为例（左列 = 课程类别，中列 = 课程名）：
//
//     y   | 左列（类别列）             | 中列
//   ------+----------------------------+-----------------
//    246  | 新生研讨课程 ( 要求学      |                ← 组名在这
//    237  | 分 :2 ）                   |
//    231  |                            | YN2530081      ← 课程号
//    222  |                            | 60006          ← 悦读计划?（上一组）
//    198  |                            | 量子力学        ← ★要查的课
//    174  |                            | YN2530081
//    159  | 专业教育( / 专业核心课程(  | YN2530081      ← 真正的组名在这
//    150  | 学分:59 / 分 :27 ）       |
//
// ★★★ 结论 ★★★
//   「专业核心课程」这个组名的 y=159，**比量子力学的 y=198 还要小（更低）**。
//   也就是说：**组名被画在这一段的末尾，不是开头。**
//
//   而原代码 nearestOf() 是「向上找最近的组名」，
//   量子力学(y=198) 向上找，只能找到 y=246 的「新生研讨课程」
//   → 于是认领了上一个组，板块归属全错。
//
// 【所以正确的解法】
//   不是「把向上找改成向下找」那么简单（那样又会踩新的坑），
//   而是：**每门课归它「段尾最近的下一个组名」**，
//   即从课程所在位置往下找**第一个组名**，那才是它所属的组。
//   因为组名画在段尾，所以「往下第一个组名」= 本段的组名。
//
// 用法：
//   node scripts/diag-merged-cells.js <培养方案.pdf>

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const FILE = process.argv[2];
const PAGE_URL = "http://127.0.0.1:8899/importer-lab.html";

(async () => {
  if (!FILE) {
    console.log("用法：node scripts/diag-merged-cells.js <培养方案.pdf>");
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();
    await page.goto(PAGE_URL, { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2500));

    const b64 = fs.readFileSync(FILE).toString("base64");

    const TARGET = process.env.TARGET_COURSE || "量子力学";
    const res = await page.evaluate(async (d, target) => {
      const bin = atob(d);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;

      const hits = [];
      for (let pno = 1; pno <= doc.numPages; pno++) {
        const pg = await doc.getPage(pno);
        const tc = await pg.getTextContent();
        const items = tc.items
          .map((t) => ({ s: t.str.trim(), x: Math.round(t.transform[4]), y: Math.round(t.transform[5]) }))
          .filter((i) => i.s);
        // 表格页才有「课程号」，正文没有 —— 这是最可靠的定位方式
        if (items.some((i) => /^YN25/.test(i.s))) hits.push({ pno, items });
      }
      if (!hits.length) return { none: true };

      const t = hits[0];
      const byY = {};
      t.items.forEach((i) => {
        const k = Math.round(i.y / 3) * 3;
        (byY[k] = byY[k] || []).push(i);
      });
      const ys = Object.keys(byY).map(Number).sort((a, b) => b - a);
      const idx = ys.findIndex((y) => (byY[y] || []).some((i) => i.s.indexOf(target) >= 0));

      return {
        pages: hits.map((h) => h.pno),
        pno: t.pno,
        idx,
        win: ys
          .slice(Math.max(0, idx - 10), idx + 12)
          .map((y) => ({ y, items: byY[y].sort((a, b) => a.x - b.x) })),
      };
    }, b64, TARGET);

    if (res.none) {
      console.log("没找到表格页（找课程号 YN25… 失败）");
      return;
    }

    console.log("表格页码：" + res.pages.join(", "));
    console.log("以下为「" + (process.env.TARGET_COURSE || "量子力学") + "」所在位置前后：");
    console.log("");
    console.log("    y   | 类别列(x<130)                        | 中列(x 130-300)");
    console.log("--------+--------------------------------------+-------------------------");
    res.win.forEach((r) => {
      const L = r.items.filter((i) => i.x < 130).map((i) => i.s).join("").slice(0, 34);
      const M = r.items.filter((i) => i.x >= 130 && i.x < 300).map((i) => i.s).join(" ").slice(0, 26);
      const target = process.env.TARGET_COURSE || "量子力学";
      const mk = r.items.some((i) => i.s.indexOf(target) >= 0) ? "  <<< " + target : "";
      console.log(String(r.y).padStart(5) + " | " + L.padEnd(34) + " | " + M + mk);
    });
    console.log("");
    console.log("★ 看「类别列」出现的y —— 如果它在课程名的**下面**（y 更小），");
    console.log("  就证明组名画在段尾，「向上找最近组名」必然认错上一个组。");
  } catch (e) {
    console.log("错误：" + e.message.slice(0, 200));
  } finally {
    await browser.close();
  }
})();