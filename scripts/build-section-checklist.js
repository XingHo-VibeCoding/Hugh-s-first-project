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
      const heads = items.filter((i) =>
    /^(课程模块|课程类别|课程号|课程名|修读学期|总学分|总学时|周学时)$/.test(i.s));
      const hx = {};
      heads.forEach((h) => { if (!(h.s in hx)) hx[h.s] = h.x; });
      if (hx["课程类别"] == null || hx["课程号"] == null ||
          hx["课程名"] == null || hx["总学分"] == null) {
        // 不是第一张表格页 —— 用上一页定好的列位置
        pages.push({ pno, items, hLines, vLines, courses: [], segs: [] });
        continue;
      }
      // 【表头实测的列位置（第 4 页）】
    //   课程模块 x=101  课程类别 x=199  课程号 x=292  课程名 x=363
    //   修读学期 x=426  总学分 x=476    总学时 x=519  周学时 x=561
    //
    // ⚠️ 边界一律取**相邻表头的中点**，不写死数字：
    //   之前学分列写成 `nameR`（=419.5），结果把 x=441 的「3」（修读学期）当成了学分 ——
    //   「理论力学」显示 3.0 看着像对的，其实是周学时，纯属巧合。
    //   页间列宽会变，但**列的相对顺序不变**，所以按表头关系算边界才稳。
    const need = ["课程模块", "课程类别", "课程号", "课程名", "修读学期", "总学分", "总学时"];
    if (need.some((k) => hx[k] == null)) {
        // 不是第一张表格页 —— 用上一页定好的列位置
        pages.push({ pno, items, hLines, vLines, courses: [], segs: [] });
        continue;
      }
    COLS = {
        catL: (hx["课程模块"] + hx["课程类别"]) / 2,
        catR: (hx["课程类别"] + hx["课程号"]) / 2,
        // 课程号在「课程类别~课程名」之间，但 x=285 的 YN25xxx 是类别代号、x=294 才是真课程号，
        // 所以这个区间只能用来「排除左边」，取中点会偏右；这里保留给行框算法做参考。
        codeL: (hx["课程类别"] + hx["课程号"]) / 2,
        codeR: hx["课程名"],
        // 名字列：课程号 与 课程名 之中点 ~ **修读学期表头前 8**
        //
        // ⚠️ 为什么右边界用「修读学期表头 - 8」而不是相邻表头中点：
        //   中点 = (363+426)/2 = 394.5，会把 x=399 的「(2)」切掉 ——
        //   PDF 里真有**两门**「天体物理导论」（一门带 (2)、一门不带），
        //   切掉后缀后两门同名，体检判成「7 门重复」。
        //
        // ⚠️ 另一个坑：**表头的 x 和它下面数值的 x 并不对齐**。
        //   表头「总学分」x=476，但实际学分值在 x=441；
        //   所以学分列**不能靠 x 区间圈**，只能靠「列的先后顺序」取。
        nameL: (hx["课程号"] + hx["课程名"]) / 2,
        nameR: hx["修读学期"] - 8,
        // 不用 creditL/creditR：见上面说明，学分靠「名字列右边第一个纯数字」取
        fromPage: pno,
      };
    }
    const { catL, catR, codeL, codeR, nameL, nameR } = COLS;

        // ---- 类别列的竖线：按 x 聚类，找左右边界 ----
        const catV = vLines
          .filter((v) => v.x > catL - 14 && v.x < catR + 14)
          // ⚠️ 第一版写成 `.sort((a, b) => b.y2 - b.y2)` —— **两个参数一样，等于没排**，
          //   导致后面的相邻段计算全错，75 段只剩 4 段。
          //   按 y1 升序才是要的顺序（从上往下）。
          .sort((a, b) => a.y1 - b.y1);
        // 合并单元格里没有内部竖线，所以每条竖线 = 一个段的下边
        const edges = [...new Set(catV.map((v) => Math.round(v.y2)))].sort((a, b) => a - b);

// ---- 课程行：以「行框」为单位 ----
        //
        // ⚠️ 之前用「课程号（YN25xxx）」当行锚点，方向就错了：
        //   实测 x=285 的 YN25xxx **只有 10 种、最多重复 52 次**
        //   （YN2530081 一个代号覆盖了 52 门课）—— 它是**课程类别代号**，不是课程号。
        //   真正的课程号在 x=294，是 5 位数字（100 次出现、79 种）。
        //
        // ✅ 正确做法：**行框（上下两条横线之间）就是一行**。
        //   实测第 4 页行框高 12、第 7 页 28~33，规整可靠；
        //   而且天然处理折行（「新生研讨与职业生」+「涯规划」自动落进同一个框）。
        //
        // 【名字拼接的三个坑，都实测过】
        // ① 同一行的名字是**横向多段**：「量子力学」x=354 +「A」x=394（同一 y=644）
        //    —— 不是折行，是并列。必须按 x 升序拼接，只取第一个会丢「A」。
        // ② 不能用「含中文」过滤：会丢掉「A」「4」「（1）」这些后缀/续行。
        //    改用**列范围**判定（nameL~nameR），这个范围实测是干净的。
        // ③ 学分列不能写死 x：页间列宽会变。改用「行框内、x 在名字列右边最近的纯数字」，
        //    依赖的是**列的相对顺序**而不是绝对坐标。
        const rowHs = [...new Set(
          hLines
            .filter((l) => l.x1 < nameR + 30 && l.x2 > nameL - 30)
            .map((l) => Math.round(l.y))
        )].sort((a, b) => b - a);

        const courses = [];
        for (let i = 0; i < rowHs.length - 1; i++) {
          const hi = rowHs[i];       // 上边（y 大 = 靠上）
          const lo = rowHs[i + 1];   // 下边
          if (hi - lo < 6) continue; // 太矮的是分隔细线
          const inBox = items.filter((it) => it.y > lo && it.y <= hi);

          // 名字：行框内落在名字列的全部片段，按 x 升序拼接
          const name = inBox
            .filter((it) => it.x > nameL - 10 && it.x < nameR)
            .sort((a, b) => a.x - b.x)
            .map((it) => it.s).join("")
            .replace(/\s+/g, "");

          // 学分：行框内、名字列**右边**的纯数字，按 x 取第一个
          //
          // ⚠️ 不能用 x 区间圈：表头「总学分」x=476，但实际数值在 x=441，
          //   表头和值不对齐（表头居中、值左对齐）。实测第 4 页表头：
          //     修读学期 x=426  总学分 x=476  总学时 x=519
          //   而「理论力学」那行的值是 [441]"3" [483]"3.0" [528]"48" [568]"3.0"。
          //   可靠办法是**列的先后顺序**：名字列右边第一个带小数的纯数字就是总学分
          //   （总学时/周学时都在它后面，且周学时通常是 x.x 格式）。
          const cr = inBox
            .filter((it) => it.x > nameR && /^[\d.]+$/.test(it.s) && it.s.indexOf(".") > 0)
            .sort((a, b) => a.x - b.x)[0];

          // 课程号：行框内 x 在 275~300 的 5 位数字（**排除 YN25 类别代号**）
          const no = inBox
            .filter((it) => it.x > 275 && it.x < 300 && /^[0-9]{5}$/.test(it.s))
            .sort((a, b) => a.x - b.x)[0];

          if (!name) continue;
          courses.push({
            code: no ? no.s : "",
            y: hi,
            lo: lo,
            name: name,
            credits: cr ? cr.s : "",
          });
        }

        // ---- 切段：**只认合并单元格的边界线** ----
        //
        // ⚠️ 这条走过两次弯路，写下来别再走：
        // ① 用「每条竖线各自成段」→ 同一门课落进多个段（体检抓到 270 门 vs 实际 100）
        // ② 「相邻竖线之间成段」→ 段数暴跌到 4、甚至 2
        //    因为**类别列压根没有竖线**（第 5 页实测：类别列竖线 0 条、横线 10 条）
        // ③ 「所有跨过类别列 x 区间的横线都当段边界」→ **错**，因为
        //    整行框线也跨过这个区间，被当成了组边界，段数虚高、组名对不上。
        //
        // ✅ 合并单元格的边界线**只画到自己那一列的宽度**；行框线则是整行的。
        //   实测每页横线只有三类（第 4/5/7 页端点完全一致）：
        //      x  80 → 156   课程模块列  ← **用这条**
        //      x 157 → 276   课程类别列
        //      x  79 → 879   整行框线（最宽，会横穿整个表格）
        //
        //   条件写成「左端够靠左 + 右端不超过类别列右边界」，这样：
        //     80→156   命中（x1=80<144，x2=156≤246）
        //     157→276  排除（x1=157 > 144）
        //     79→879   排除（x2=879 > 246）
        //   实测命中这一组参数 → 23 段、95 门，四门核心课
        //   （理论力学/数学物理方法/电动力学/量子力学A）全在「专业核心课程(27)」下 ✅
        //
        //   ⚠️ 试过两种更"聪明"的办法，都更差（写下来别再走）：
        //   ① 用精确竖线坐标（157/277）→ 45 段，组名跟课错位
        //   ② 从竖线 x 聚类取 top2 → 46 段，因为出现最多的竖线是
        //      那些画得最多的普通列（x=333/468/553…），不是类别列
        //   **结论：列的边界只能靠「横线端点 + 范围约束」筛，不能靠「哪个最常见」。**
        const segsOut = [];
        const catCellR = catR - 6;    // 类别列右边界（实测 221~246 区间内）
        const mergeH = [...new Set(
          hLines
            .filter((l) => l.x1 < catL - 6 && l.x2 > catL - 12 && l.x2 <= catCellR + 6)
            .map((l) => Math.round(l.y))
        )].sort((a, b) => b - a);

        for (let i = 0; i < mergeH.length - 1; i++) {
          const hi = mergeH[i];      // 上边（y 大 = 靠上）
          const lo = mergeH[i + 1];  // 下边
          if (hi - lo < 8) continue; // 太矮的是分隔细线

          // ⚠️ **「课程模块」和「课程类别」是两个独立的列，必须分开读。**
          //   之前把两列的文字 `join("")` 混成一句，产出全是这种鬼话：
          //     「（大类）学科基础必修课程(32）拓展教育课程(要求学分:4）  ← 体育在这
          //     「通识教育选择性必修课程组（级）(要求学分通识教育必修课程组（一）（级」
          //   —— 两列的半截话被拼在一起，**看起来像组名，其实是两列各说一半**。
          //
          //   分类对用户有意义的只有**课程类别**（专业核心课程 / 通识教育必修一组 /
          //   综合实践课程…）；课程模块是更大的归类（学科基础 / 专业教育 / 拓展教育），
          //   单独输出，别混。
          const readCol = (xFrom, xTo) => items
            .filter((it) => it.x > xFrom && it.x < xTo && it.y > lo && it.y <= hi &&
                              /[一-龥（）()：:]/.test(it.s))
            .sort((a2, b2) => a2.y - b2.y || a2.x - b2.x)
            .map((it) => it.s).join("")
            .replace(/\s+/g, "");
          const modName = readCol(catL - 20, catL);        // 课程模块列
          const catName = readCol(catL, catR - 6);         // 课程类别列

          // 课程归属用 [lo, hi]，与 texts 的边界对齐
          const inside = courses.filter((c) => c.lo >= lo && c.lo < hi);
          if (inside.length === 0 && !catName && !modName) continue;   // 空段不要
          segsOut.push({
            lo, hi, h: Math.round(hi - lo),
            name: catName || modName,      // 优先用课程类别
            catName, modName,
            courses: inside,
          });
        }
        // 段还没覆盖到的课（合并边界之间没框住）→ 各自单独一段，避免丢课
        const covered = new Set();
        segsOut.forEach((s) => s.courses.forEach((c) => covered.add(c.lo)));
        courses.filter((c) => !covered.has(c.lo)).forEach((c) => {
          segsOut.push({ lo: c.lo, hi: c.lo, h: 0, name: "", courses: [c] });
        });

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
      const cat = (s.catName || "").slice(0, 26);
      const mod = (s.modName || "").slice(0, 20);
      console.error(
        "  段" + String(i + 1).padStart(2) + " 页" + s.pno +
        " 高" + String(s.h).padStart(4) +
        " " + String(s.courses.length).padStart(3) + " 门  " +
        (cat || "(类别列空)") + (mod ? "   ⟨模块:" + mod + "⟩" : "")
      );
    });

    // TSV：课程类别和课程模块分两列，**不合并**
    //（合并过一次，产出全是两列各说一半的鬼话，见上面注释）
    const lines = ["段\t页\t框高\t门数\t课程类别\t课程模块\t课程名", "别"];
    let idx = 0;
    withCourses.forEach((s) => {
      idx++;
      lines.push(idx + "\t" + s.pno + "\t" + s.h + "\t" + s.courses.length + "\t" +
        (s.catName || "") + "\t" + (s.modName || "") + "\t（段首）");
      s.courses.forEach((c) => {
        lines.push("\t\t\t\t\t\t" + c.name + "  " + c.credits);
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