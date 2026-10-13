// 生成「板块校对表」：按 PDF 的表格框线把 100 门课切成段，
// 让人一眼能看出哪门课应该属于哪一段。
//
// 【为什么需要这个】
// Day 28 发现：自动识别的板块归属是错的（合并单元格的组名既不在段首也不在段尾）。
// 既然自动归不可信，就给人一份可核对的清单 ——
// 人在待确认表格里按下拉框，只需要知道「哪门课属于第几段」。
//
// 【怎么切段（用框线，不靠猜）】
// pdf.js 能拿到表格的框线（Day 28 已验证：每页 400+ 条横线、580+ 条竖线）。
// 类别列的**每一段框**就是一个「课程组」：
//   · 上边线 + 下边线之间 = 这一组
//   · 框内类别列的文字 = 组名
//   · 落在这个框里的所有课程行 = 这一组的课
//
// 所以：先按框把页面切成「段」，再把课程行归到所在的段。
// 这跟「按组名文字的 y 找最近的」是**结构信息 vs 文字位置**的区别，
// 后者才是错的那个（组名在段内位置不固定）。
//
// 用法：
//   node scripts/build-section-checklist.js <培养方案.pdf> > checklist.tsv

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const FILE = process.argv[2];
const PAGE_URL = "http://127.0.0.1:8899/importer-lab.html";

(async () => {
  if (!FILE) {
    console.error("用法：node scripts/build-section-checklist.js <培养方案.pdf>");
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

    const res = await page.evaluate(async (d) => {
      const bin = atob(d);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;
      const OPS = pdfjsLib.OPS;
      const apply = (m, n) => [
        m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
      ];

      const pages = [];
      // 列位置：**整张表共用**，只在第一张表格页读一次表头，之后各页沿用。
      // 见下面那段注释的详细原因（表头只在第 4 页印一次）。
      let COLS = null;
      for (let pno = 1; pno <= doc.numPages; pno++) {
        const pg = await doc.getPage(pno);
        const H = pg.getViewport({ scale: 1 }).height;
        const tc = await pg.getTextContent();
        const items = tc.items
          .map((t) => ({ s: t.str.trim(), x: t.transform[4], y: H - t.transform[5] }))
          .filter((i) => i.s);
        if (!items.some((i) => /^YN25/.test(i.s))) continue;

        // ---- 抽框线 ----
        const ops = await pg.getOperatorList();
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        const segs = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i], a = ops.argsArray[i];
          if (fn === OPS.save) stack.push(ctm.slice());
          else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
          else if (fn === OPS.transform) ctm = apply(ctm, Array.from(a).slice(0, 6));
          else if (fn === OPS.constructPath) {
            const cmds = a[0], coords = a[1];
            if (!Array.isArray(cmds) || !Array.isArray(coords)) continue;
            let ci = 0, cx = 0, cy = 0, sx = 0, sy = 0;
            const take = () => {
              const x = coords[ci++], y = coords[ci++];
              return apply(ctm, [1, 0, 0, 1, x, y]);
            };
            for (let k = 0; k < cmds.length; k++) {
              const c = cmds[k];
              if (c === OPS.moveTo) { const q = take(); cx = q[4]; cy = q[5]; sx = cx; sy = cy; }
              else if (c === OPS.lineTo) { const q = take(); segs.push({ x1: cx, y1: cy, x2: q[4], y2: q[5] }); cx = q[4]; cy = q[5]; }
              else if (c === OPS.closePath) { if (cx !== sx || cy !== sy) segs.push({ x1: cx, y1: cy, x2: sx, y2: sy }); cx = sx; cy = sy; }
            }
          }
        }
        const hLines = [], vLines = [];
        segs.forEach((s) => {
          const dx = Math.abs(s.x2 - s.x1), dy = Math.abs(s.y2 - s.y1);
          if (dy < 1.0 && dx > 20) hLines.push({ y: (s.y1 + s.y2) / 2, x1: Math.min(s.x1, s.x2), x2: Math.max(s.x1, s.x2) });
          else if (dx < 1.0 && dy > 3) vLines.push({ x: (s.x1 + s.x2) / 2, y1: Math.min(s.y1, s.y2), y2: Math.max(s.y1, s.y2) });
        });

// ---- 列位置：只用**第一张表格页**的表头，其余页沿用 ----
    //
    // 【关键发现（diag-table-pages.js 实测）】
    // 表头只印在第 4 页（第一张表格页），第 5~9 页**没有表头**——
    // 跨页表格的常态，表头不会每页重复。
    //
    // 之前每页各自去找表头，第 5~9 页找不到就 `continue` 跳过，
    // 结果 100 门课只处理了 9 门（只剩第 4 页）。
    //
    // 正确做法：列位置是**整张表共用的**，取第一页的表头定下来，
    // 后面所有页都套用同一套 x 边界。
    if (!COLS) {
      const heads = items.filter((i) => /^(课程模块|课程类别|课程号|课程名|总学分)$/.test(i.s));
      const hx = {};
      heads.forEach((h) => { if (!(h.s in hx)) hx[h.s] = h.x; });
      if (hx["课程类别"] == null || hx["课程号"] == null) {
        // 不是第一张表格页 —— 用上一页定好的列位置
        pages.push({ pno, items, hLines, vLines, courses: [], segs: [] });
        continue;
      }
      COLS = {
        catL: (hx["课程模块"] + hx["课程类别"]) / 2,
        catR: (hx["课程类别"] + hx["课程号"]) / 2,
        codeL: (hx["课程类别"] + hx["课程号"]) / 2,
        codeR: hx["课程名"],
        nameL: (hx["课程类别"] + hx["课程号"]) / 2,
        nameR: hx["总学分"] + 40,
        creditL: hx["总学分"] - 15,
        creditR: hx["总学分"] + 45,
        fromPage: pno,
      };
    }
    const { catL, catR, codeL, codeR, nameL, nameR, creditL, creditR } = COLS;

        // ---- 类别列的竖线：按 x 聚类，找左右边界 ----
        const catV = vLines
          .filter((v) => v.x > catL - 14 && v.x < catR + 14)
          // ⚠️ 第一版写成 `.sort((a, b) => b.y2 - b.y2)` —— **两个参数一样，等于没排**，
          //   导致后面的相邻段计算全错，75 段只剩 4 段。
          //   按 y1 升序才是要的顺序（从上往下）。
          .sort((a, b) => a.y1 - b.y1);
        // 合并单元格里没有内部竖线，所以每条竖线 = 一个段的下边
        const edges = [...new Set(catV.map((v) => Math.round(v.y2)))].sort((a, b) => a - b);

// ---- 课程行 ----
        // 列范围用上面定好的 COLS（来自第一页表头），不写死魔法数字 ——
        // 页间列宽可能变，但列的**相对位置**不变。
        const courses = items
          .filter((i) => /^YN25/.test(i.s) && i.x > codeL && i.x < codeR)
          .map((code) => {
            const name = items
              .filter((i) => i.x > nameL && i.x < nameR && /[一-龥]/.test(i.s))
              .sort((a, b) => Math.abs(a.y - code.y) - Math.abs(b.y - code.y))[0];
            const cr = items
              .filter((i) => i.x > creditL && i.x < creditR &&
                            /^[\d.]+$/.test(i.s) && i.s.indexOf(".") > 0)
              .sort((a, b) => Math.abs(a.y - code.y) - Math.abs(b.y - code.y))[0];
            return { code: code.s, y: code.y, name: name ? name.s : "", credits: cr ? cr.s : "" };
          })
          .filter((c) => c.name);

        // ---- 切段：用**横线**，不是竖线 ----
        //
        // ⚠️ 这条走过弯路，记下来别再走：
        // ① 第一版用「每条竖线各自成段」→ 同一门课落进多个段（270 门 vs 实际 100）
        // ② 改成「相邻竖线之间成段」→ 段数暴跌到 4、甚至 2
        //    因为**类别列压根没有竖线**（第 5 页实测：类别列竖线 0 条、横线 10 条）
        // ③ 又发现竖线排序写成 `.sort((a,b) => b.y2 - b.y2)`（两个参数一样=没排）
        //
        // ✅ 正确依据：**横线**。合并单元格的上下边界是横线，
        //    「上下最近的两条横线之间」= 一个组 —— 这跟竖线完全无关。
        //    实测第 5 页 22 门课干净地分成 3 段（高 115 / 201 / …），边界不重叠。
        const segsOut = [];
        // 类别列范围内的横线（x 跨过类别列），去重后按 y 排
        const catHs = [...new Set(
          hLines
            .filter((l) => l.x1 < catR + 20 && l.x2 > catL - 20)
            .map((l) => Math.round(l.y))
        )].sort((a, b) => b - a);

        // 相邻两条横线之间 = 一段
        for (let i = 0; i < catHs.length - 1; i++) {
          const hi = catHs[i];      // 上边（y 大 = 靠上）
          const lo = catHs[i + 1];  // 下边
          if (hi - lo < 8) continue;      // 太矮的是表头行/分隔细线
          const texts = items
            .filter((it) => it.x > catL && it.x < catR && it.y > lo && it.y <= hi &&
                              /[一-龥（）()：:]/.test(it.s))
            .sort((a2, b2) => a2.y - b2.y).map((it) => it.s).join("");
          const inside = courses.filter((c) => c.y > lo && c.y <= hi);
          if (inside.length === 0 && !texts) continue;   // 空段不要
          segsOut.push({ lo, hi, h: Math.round(hi - lo), name: texts, courses: inside });
        }

        pages.push({ pno, items, hLines, vLines, courses, segs: segsOut, catL, catR });
      }
      return pages;
    }, b64);

    // ---- 输出 ----
    const allSegs = [];
    res.forEach((p) => p.segs.forEach((s) => allSegs.push({ pno: p.pno, ...s })));
    const withCourses = allSegs.filter((s) => s.courses.length > 0);

    console.error("表格页：" + res.map((p) => p.pno).join(","));
    console.error("课程总数：" + res.reduce((a, p) => a + p.courses.length, 0));
    console.error("框线切出的段（总）：" + allSegs.length + "，其中含课程的：" + withCourses.length);
    console.error("");
    console.error("=== 每段一览 ===");
    withCourses.forEach((s, i) => {
      const nm = s.name.replace(/\s+/g, "").slice(0, 30) || "(框内无文字)";
      console.error(
        "  段" + String(i + 1).padStart(2) + " 页" + s.pno +
        " 高" + String(s.h).padStart(4) +
        " " + String(s.courses.length).padStart(3) + " 门  " + nm
      );
    });

    const lines = ["段\t页\t框高\t门数\t组名(框内文字)\t课程名", "别"];
    let idx = 0;
    withCourses.forEach((s) => {
      idx++;
      lines.push(idx + "\t" + s.pno + "\t" + s.h + "\t" + s.courses.length + "\t" +
        s.name.replace(/\s+/g, "") + "\t（段首）");
      s.courses.forEach((c) => {
        lines.push("\t\t\t\t\t" + c.name + "  " + c.credits);
      });
    });
    process.stdout.write(lines.join("\n") + "\n");
  } catch (e) {
    console.error("错误：" + e.message.slice(0, 300));
    process.exit(1);
  } finally {
    await browser.close();
  }
})();