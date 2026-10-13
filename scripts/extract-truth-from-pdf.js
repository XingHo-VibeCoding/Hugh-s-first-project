// 从 PDF 原文抽「课程名 + 它真正所属的组」——板块归属的真值。
//
// 【Day 28 的问题】
// 用户导出后发现板块全错：「大学英语听说怎么会是综合实践板块的？」
// 「量子力学A」被归到新生研讨课程。
//
// 【已确证的根因】
// PDF 的合并单元格，组名既不在段首也不在段尾：
//   量子力学A   y=198  ← 组名「专业核心课程」y=159（在下面）
//   数学物理方法 y=141  ← 组名「专业核心课程」y=150（在上面）
// 所以「向上找最近组名」和「向下找最近组名」**都会错**。
//
// 【为什么这版能对】
// 判断「这门课属于哪个组」，不看组名文字的 y 位置，
// 而看**表格框线**：类别列的合并单元格在框线里是**一整个矩形**，
// 上边线和下边线之间的距离就是这一组的跨度。
// 每门课落在哪个框里，就属于哪个组 —— **这是结构信息，不是猜的**。
//
// 【pdf.js 的框线格式（scripts/probe-pdf-lines.js 实测出来的）】
//   ·框线在 constructPath 里，参数是 [commands, coords, minMax]
//     commands: [13,14,14,14,18] → 13=moveTo, 14=lineTo（成对坐标）
//   · 有 transform 变换矩阵，Y 轴被翻转过（[1,0,0,-1,0,842]）
//     → 线段坐标要跟着当前 CTM 累乘，否则全是错的
//   · 每页 403 个 constructPath，表格线就在里面
//
// 用法：
//   node scripts/extract-truth-from-pdf.js <培养方案.pdf> > truth.tsv

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const FILE = process.argv[2];
const PAGE_URL = "http://127.0.0.1:8899/importer-lab.html";

(async () => {
  if (!FILE) {
    console.error("用法：node scripts/extract-truth-from-pdf.js <培养方案.pdf>");
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

      const pages = [];

      for (let pno = 1; pno <= doc.numPages; pno++) {
        const pg = await doc.getPage(pno);
        const H = pg.getViewport({ scale: 1 }).height;
        const tc = await pg.getTextContent();

        const items = tc.items
          .map((t) => ({ s: t.str.trim(), x: t.transform[4], y: H - t.transform[5] }))
          .filter((i) => i.s);
        if (!items.some((i) => /^YN25/.test(i.s))) continue;

        // ---- 走一遍算子流，维护 CTM，把constructPath 变成线段 ----
        const ops = await pg.getOperatorList();
        let ctm = [1, 0, 0, 1, 0, 0];
        const stack = [];
        const segs = [];

        const apply = (m, n) => [
          m[0] * n[0] + m[2] * n[1],
          m[1] * n[0] + m[3] * n[1],
          m[0] * n[2] + m[2] * n[3],
          m[1] * n[2] + m[3] * n[3],
          m[0] * n[4] + m[2] * n[5] + m[4],
          m[1] * n[4] + m[3] * n[5] + m[5],
        ];

        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i];
          const a = ops.argsArray[i];

          if (fn === OPS.save) stack.push(ctm.slice());
          else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
          else if (fn === OPS.transform) ctm = apply(ctm, Array.from(a).slice(0, 6));
          else if (fn === OPS.constructPath) {
            // ⚠️ 实测结构：a = [cmds, coords, minMax] 三个普通数组（不是嵌套）
            //   a[0] = [13,14,14,14,18]（算子码）
            //   a[1] = [x0,y0, x1,y1, x2,y2, x3,y3]（成对坐标）
            // 第一版写成 `var args = a[0] || a`，等于又剥了一层 → 拿到的
            // 是 cmds 自己当 cmds 用，于是 segs 全空（横线 0 条）。别再这么写。
            const cmds = a[0];
            const coords = a[1];
            if (!Array.isArray(cmds) || !Array.isArray(coords)) continue;

            // commands 是个扁平数组：[13,14,14,14,18]
            // 13=moveTo(13)、14=lineTo(14)、15/16/17=各类曲线、18=closePath、19=rectangle
            // ⚠️ closePath(18) **不消费坐标**，必须先判掉，
            //    否则会把下面的坐标当成它的参数，导致整段错位（第一版就栽在这）。
            let ci = 0;
            let cx = 0, cy = 0, sx = 0, sy = 0;
            const take = () => { const x = coords[ci++]; const y = coords[ci++];
                                 const q = apply(ctm, [1, 0, 0, 1, x, y]); return q; };

            for (let k = 0; k < cmds.length; k++) {
              const c = cmds[k];

              if (c === OPS.moveTo) {
                const q = take(); cx = q[4]; cy = q[5]; sx = cx; sy = cy;
              } else if (c === OPS.lineTo) {
                const q = take();
                segs.push({ x1: cx, y1: cy, x2: q[4], y2: q[5] });
                cx = q[4]; cy = q[5];
              } else if (c === OPS.closePath) {
                // 闭合：补一条回到起点的线（表格的框就是靠闭合形成的）
                if (cx !== sx || cy !== sy) segs.push({ x1: cx, y1: cy, x2: sx, y2: sy });
                cx = sx; cy = sy;
              } else if (c === OPS.curveTo) { ci += 6; }
              else if (c === OPS.curveTo2) { ci += 4; }
              else if (c === OPS.curveTo3) { ci += 6; }
              else if (c === OPS.rectangle) {
                const x = coords[ci++], y = coords[ci++], w = coords[ci++], h = coords[ci++];
                const p1 = apply(ctm, [1, 0, 0, 1, x, y]);
                const p2 = apply(ctm, [1, 0, 0, 1, x + w, y + h]);
                const p3 = apply(ctm, [1, 0, 0, 1, x + w, y]);
                const p4 = apply(ctm, [1, 0, 0, 1, x, y + h]);
                segs.push({ x1: p1[4], y1: p1[5], x2: p3[4], y2: p3[5] });
                segs.push({ x1: p3[4], y1: p3[5], x2: p2[4], y2: p2[5] });
                segs.push({ x1: p2[4], y1: p2[5], x2: p4[4], y2: p4[5] });
                segs.push({ x1: p4[4], y1: p4[5], x2: p1[4], y2: p1[5] });
              }
            }
          }
        }

        // ---- 拆成横线 / 竖线 ----
        const hLines = [], vLines = [];
        segs.forEach((s) => {
          const dx = Math.abs(s.x2 - s.x1), dy = Math.abs(s.y2 - s.y1);
          if (dy < 1.0 && dx > 20) hLines.push({ y: (s.y1 + s.y2) / 2, x1: Math.min(s.x1, s.x2), x2: Math.max(s.x1, s.x2) });
          else if (dx < 1.0 && dy > 3) vLines.push({ x: (s.x1 + s.x2) / 2, y1: Math.min(s.y1, s.y2), y2: Math.max(s.y1, s.y2) });
        });

        pages.push({ pno, H, items, hLines, vLines, segCount: segs.length });
      }

      return pages;
    }, b64);

    if (!res.length) {
      console.error("没找到表格页");
      process.exit(1);
    }

    // ---- 找类别列的 x 范围（用竖线聚类）----
    const allV = [];
    res.forEach((p) => p.vLines.forEach((v) => allV.push(v.x)));
    allV.sort((a, b) => a - b);
    const cols = [];
    allV.forEach((x) => {
      const last = cols[cols.length - 1];
      if (last && x - last.min < 5) { last.min = Math.min(last.min, x); last.max = Math.max(last.max, x); last.n++; }
      else cols.push({ min: x, max: x, n: 1 });
    });
    const colXs = cols.filter((c) => c.n >= 5).map((c) => Math.round((c.min + c.max) / 2));

    console.error("表格页：" + res.map((p) => p.pno).join(","));
    console.error("线段总数/页：" + res.map((p) => p.segCount).join(","));
    console.error("横线数/页：" + res.map((p) => p.hLines.length).join(","));
    console.error("竖线 x 位置（≥5 次的列）：" + colXs.join(", "));

    if (!res.some((p) => p.hLines.length > 20)) {
      console.error("");
      console.error("⚠️ 横线还是太少，框线没抓到 —— 这一版还不能当真值用。");
      process.exit(2);
    }

    // ---- 用「表头」定位各列，不猜 x 阈值 ----
    //
    // 实测（page4表头）：
    //   x=101 课程模块   x=199 课程类别   x=292 课程号   x=363 课程名
    //   x=426 修读学期   x=476 总学分     x=519 总学时   x=561 周学时
    //
    // 第一版用「x < 60 算类别列」是错的 —— 类别列在 x=199，
    // 80 那列是「课程模块」。**列位置必须从表头读，不能猜。**
    const out = [];
    res.forEach((p) => {
      const heads = p.items.filter((i) => /^(课程模块|课程类别|课程号|课程名|修读学期|总学分)/.test(i.s));
      const headX = {};
      heads.forEach((h) => {
        // ⚠️ 键名必须用**完整表头文字**，不能 replace(/^课程/,"") ——
        //   「修读学期」不含「课程」两字，但「总学分类型分配」里也有「总学分」，
        //   去掉前缀后两者会撞成同一个键，headX["学分"] 取到错的那个（x=635 而不是 476），
        //   列边界全错、课程一条都抓不到。实测踩过。
        if (!(h.s in headX)) headX[h.s] = h.x;
      });
      const X_MODULE = headX["课程模块"];
      const X_CATEGORY = headX["课程类别"];
      const X_CODE = headX["课程号"];
      const X_NAME = headX["课程名"];
      const X_CREDIT = headX["总学分"];
      if (X_CATEGORY == null || X_CODE == null) return;

      // 列边界：取相邻表头的中点
      const bounds = {
        module: [(X_MODULE + X_CATEGORY) / 2 - 60, (X_MODULE + X_CATEGORY) / 2],
        category: [(X_MODULE + X_CATEGORY) / 2, (X_CATEGORY + X_CODE) / 2],
        name: [(X_CATEGORY + X_CODE) / 2, (X_NAME + X_CREDIT) / 2 + 10],
      };

      // 类别列上的横线（框的上下边）
      const catH = p.hLines
        .filter((h) => h.x1 < bounds.category[1] + 10 && h.x2 > bounds.category[0] - 10)
        .map((h) => h.y)
        .sort((a, b) => a - b);

      const codes = p.items.filter((i) => i.x > X_CODE - 20 && i.x < X_CODE + 60 && /^YN25/.test(i.s));
      codes.forEach((code) => {
        const nameItem = p.items
          .filter((i) => i.x >= bounds.name[0] && i.x <= bounds.name[1] && /[一-龥]/.test(i.s))
          .sort((a, b) => Math.abs(a.y - code.y) - Math.abs(b.y - code.y))[0];
        const creditItem = p.items
          .filter((i) => i.x > X_CREDIT - 15 && i.x < X_CREDIT + 45 && /^[\d.]+$/.test(i.s) && i.s.indexOf(".") > 0)
          .sort((a, b) => Math.abs(a.y - code.y) - Math.abs(b.y - code.y))[0];
        if (!nameItem) return;

        // ★核心★：类别列的框——上下最近的两条横线之间 = 它所属的合并单元格
        let below = null, above = null;
        catH.forEach((y) => {
          if (y < code.y && (above === null || y > above)) above = y;
          if (y > code.y && (below === null || y < below)) below = y;
        });
        const lo = above === null ? -Infinity : above;
        const hi = below === null ? Infinity : below;

        // 框内类别列的文字 = 组名（按 y 从上到下拼）
        const frag = p.items
          .filter((i) => i.x >= bounds.category[0] && i.x <= bounds.category[1] &&
                         i.y > lo && i.y < hi && /[一-龥（）()：:]/.test(i.s))
          .sort((a, b) => a.y - b.y)
          .map((i) => i.s)
          .join("");

        // 模块列同理
        const modFrag = p.items
          .filter((i) => i.x >= bounds.module[0] && i.x <= bounds.module[1] &&
                         i.y > lo && i.y < hi && /[一-龥（）()：:]/.test(i.s))
          .sort((a, b) => a.y - b.y)
          .map((i) => i.s)
          .join("");

        out.push({
          pno: p.pno, y: code.y, code: code.s,
          name: nameItem.s,
          credits: creditItem ? creditItem.s : "",
          module: modFrag,
          cat: frag,
          cellH: above === null || below === null ? "" : Math.round(below - above),
        });
      });
    });

    console.error("抓到课程：" + out.length + " 门");
    console.error("");
    console.error("=== 组分布（按框线切出来的，应与 PDF 表格一致）===");
    const dist = {};
    out.forEach((r) => { const k = r.cat.replace(/\s+/g, ""); dist[k] = (dist[k] || 0) + 1; });
    Object.entries(dist).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => {
      console.error("  " + String(v).padStart(3) + " 门  " + k.slice(0, 46));
    });

    const lines = ["页\t代码\t课程名\t学分\t模块\t类别\t框高"];
    out.forEach((r) => {
      lines.push([r.pno, r.code, r.name, r.credits, r.module, r.cat, r.cellH].join("\t"));
    });
    process.stdout.write(lines.join("\n") + "\n");
  } catch (e) {
    console.error("错误：" + e.message.slice(0, 300));
    process.exit(1);
  } finally {
    await browser.close();
  }
})();