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

        // ---- 列位置从表头读 ----
        const heads = items.filter((i) => /^(课程模块|课程类别|课程号|课程名|总学分)$/.test(i.s));
        const hx = {};
        heads.forEach((h) => { if (!(h.s in hx)) hx[h.s] = h.x; });
        if (hx["课程类别"] == null || hx["课程号"] == null) continue;
        const catL = (hx["课程模块"] + hx["课程类别"]) / 2;
        const catR = (hx["课程类别"] + hx["课程号"]) / 2;

        // ---- 类别列的竖线：按 x 聚类，找左右边界 ----
        const catV = vLines
          .filter((v) => v.x > catL - 14 && v.x < catR + 14)
          .sort((a, b) => b.y2 - b.y2);
        // 合并单元格里没有内部竖线，所以每条竖线 = 一个段的下边
        const edges = [...new Set(catV.map((v) => Math.round(v.y2)))].sort((a, b) => a - b);

// ---- 课程行 ----
        // ⚠️ 列范围不能写死数字（实测页间会变）：
        //   第 4 页表头 课程类别x=199 课程号x=292，但靠后的页列宽不一样，
        //   写死 [x-20, x+60] 只抓到 9 门。改成用「类别列右边界 ~ 课程名表头」这个区间，
        //   课程号落在其中即可 —— 靠表头定位，不靠魔法数字。
        const codeL = catR, codeR = hx["课程名"];
        const courses = items
          .filter((i) => /^YN25/.test(i.s) && i.x > codeL && i.x < codeR)
          .map((code) => {
            const name = items
              .filter((i) => i.x > catR && i.x < hx["总学分"] + 40 && /[一-龥]/.test(i.s))
              .sort((a, b) => Math.abs(a.y - code.y) - Math.abs(b.y - code.y))[0];
            const cr = items
              .filter((i) => i.x > hx["总学分"] - 15 && i.x < hx["总学分"] + 45 &&
                            /^[\d.]+$/.test(i.s) && i.s.indexOf(".") > 0)
              .sort((a, b) => Math.abs(a.y - code.y) - Math.abs(b.y - code.y))[0];
            return { code: code.s, y: code.y, name: name ? name.s : "", credits: cr ? cr.s : "" };
          })
          .filter((c) => c.name);

        // ---- 切段：每条竖线的 y2 是一个段的下边 ----
        // 段内文字 = 上下两条竖线之间、类别列 x 范围内的文字
        const segsOut = [];
        const bounds = [Math.min(...catV.map((v) => v.y1)), ...edges].sort((a, b) => a - b);
        for (let i = 0; i < catV.length; i++) {
          const lo = catV[i].y1, hi = catV[i].y2;
          if (hi - lo < 8) continue; // 太矮的是标题行/表头
          const texts = items
            .filter((i) => i.x > catL && i.x < catR && i.y >= lo && i.y <= hi && /[一-龥（）()：:]/.test(i.s))
            .sort((a, b) => a.y - b.y).map((i) => i.s).join("");
          const inside = courses.filter((c) => c.y > lo && c.y < hi);
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