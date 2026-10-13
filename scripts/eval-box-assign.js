/**
 * scripts/eval-box-assign.js —— 离线验证「框线定归属」方案
 *
 * ⚠️ 只在本地跑，不碰 importer/*.js。
 *   今天已经改坏过 3 版解析器；先证明方案可行，再动产品代码。
 *
 * 判据用 db/truth-curriculum.json（用户亲手整理的 100 门课）。
 * 全量评估，不抽样。
 */
const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C://Users//w3224//.agent-browser//browsers//chrome-155.0.8059.39//chrome.exe";
const PDF = process.argv[2];
const TRUTH = JSON.parse(fs.readFileSync(__dirname + "/../db/truth-curriculum.json", "utf8"));

function norm(s) {
  return String(s || "").replace(/\s+/g, "").replace(/[“”]/g, '"')
    .replace(/[（]/g, "(").replace(/[）]/g, ")").replace(/：/g, ":");
}
// 真值：课名 → 板块（规范化）
const truthMap = {};
TRUTH.cats.forEach((c) => c.courses.forEach((n) => {
  const k = norm(n);
  (truthMap[k] = truthMap[k] || []).push(c.name);
}));
// 真值板块名 → 核心词（去掉「要求学分」等后缀，用于比对）
function core(s) { return norm(s).replace(/\(?要求学分[^)]*\)?/g, "").replace(/[^一-龥]/g, ""); }

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  try {
    const p = await b.newPage();
    p.on("pageerror", (e) => console.log("[JS] " + e.message));
    await p.goto("http://127.0.0.1:8899/importer-lab.html", { waitUntil: "networkidle0" });
    await new Promise((r) => setTimeout(r, 2500));
    const b64 = fs.readFileSync(PDF).toString("base64");

    const res = await p.evaluate(async (d) => {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const doc = await pdfjsLib.getDocument({ data: arr }).promise;
      const OPS = pdfjsLib.OPS;
      const A = (m, n) => [m[0]*n[0]+m[2]*n[1], m[1]*n[0]+m[3]*n[1],
        m[0]*n[2]+m[2]*n[3], m[1]*n[2]+m[3]*n[3],
        m[0]*n[4]+m[2]*n[5]+m[4], m[1]*n[4]+m[3]*n[5]+m[5]];
      let COLS = null;
      const out = [];
      for (let pno = 1; pno <= doc.numPages; pno++) {
        const pg = await doc.getPage(pno);
        const H = pg.getViewport({ scale: 1 }).height;
        const tc = await pg.getTextContent();
        const items = tc.items.map((t) => ({ s: t.str.trim(), x: Math.round(t.transform[4]), y: Math.round(H - t.transform[5]) })).filter((i) => i.s);
        if (!COLS) {
          const heads = items.filter((i) => /^(课程模块|课程类别|课程号|课程名|修读学期|总学分)$/.test(i.s));
          const hx = {}; heads.forEach((h) => { if (!(h.s in hx)) hx[h.s] = h.x; });
          if (hx["课程类别"] == null) continue;
          COLS = { catL: (hx["课程模块"]+hx["课程类别"])/2, catR: (hx["课程类别"]+hx["课程号"])/2,
                   nameL: (hx["课程号"]+hx["课程名"])/2, nameR: hx["修读学期"]-8 };
        }
        const ops = await pg.getOperatorList();
        let ctm = [1,0,0,1,0,0]; const stack = []; const segs = [];
        for (let i = 0; i < ops.fnArray.length; i++) {
          const fn = ops.fnArray[i], a = ops.argsArray[i];
          if (fn === OPS.save) stack.push(ctm.slice());
          else if (fn === OPS.restore) ctm = stack.pop() || [1,0,0,1,0,0];
          else if (fn === OPS.transform) ctm = A(ctm, Array.from(a).slice(0,6));
          else if (fn === OPS.constructPath) {
            const cmds = a[0], coords = a[1];
            if (!Array.isArray(cmds) || !Array.isArray(coords)) continue;
            let ci2 = 0, cx = 0, cy = 0, sx = 0, sy = 0;
            const take = () => { const x = coords[ci2++], y = coords[ci2++]; return A(ctm, [1,0,0,1,x,y]); };
            for (let k = 0; k < cmds.length; k++) { const c = cmds[k];
              if (c === 13) { const q = take(); cx=q[4]; cy=q[5]; sx=cx; sy=cy; }
              else if (c === 14) { const q = take(); segs.push({x1:cx,y1:cy,x2:q[4],y2:q[5]}); cx=q[4]; cy=q[5]; }
              else if (c === 18) { if (cx!==sx||cy!==sy) segs.push({x1:cx,y1:cy,x2:sx,y2:sy}); cx=sx; cy=sy; } }
          }
        }
        // 类别列的合并边界（端点 = 类别列两条竖线之间）
        const boxes = [...new Set(segs.filter((s) => Math.abs(s.y2-s.y1) < 1.0 &&
          Math.abs(s.x2-s.x1) > 20 &&
          Math.min(s.x1,s.x2) >= COLS.catL - 5 && Math.min(s.x1,s.x2) < COLS.catL + 20 &&
          Math.max(s.x1,s.x2) >= COLS.catR - 15 && Math.max(s.x1,s.x2) < COLS.catR + 35
          ).map((s) => Math.round((s.y1+s.y2)/2)))].sort((a,b) => b-a);
        // 行框（名字列上的横线）
        const rowH = [...new Set(segs.filter((s) => Math.abs(s.y2-s.y1) < 1.0 &&
          Math.abs(s.x2-s.x1) > 20 && s.x1 < COLS.nameR + 30 && s.x2 > COLS.nameL - 30
          ).map((s) => Math.round((s.y1+s.y2)/2)))].sort((a,b) => b-a);
        const courses = [];
        for (let i = 0; i < rowH.length - 1; i++) {
          const hi = rowH[i], lo = rowH[i+1];
          if (hi - lo < 6) continue;
          const inBox = items.filter((it) => it.y > lo && it.y <= hi);
          const frags = inBox.filter((it) => it.x > COLS.nameL - 10 && it.x < COLS.nameR);
          if (!frags.length) continue;
          const name = frags.slice().sort((a,b)=>a.x-b.x).map((it)=>it.s).join("").replace(/\s+/g,"");
          if (!name) continue;
          const y = frags[0].y;
          // ★ 归属：y 落在哪两个 boxes 之间
          let above = null, below = null;
          boxes.forEach((yy) => { if (yy < y && (above === null || yy > above)) above = yy;
                                  if (yy > y && (below === null || yy < below)) below = yy; });
          const sec = items.filter((it) => it.x > COLS.catL && it.x < COLS.catR &&
            (above === null || it.y > below) && (below === null || it.y <= above) &&
            /[一-龥（）()]/.test(it.s))
            .sort((a,b) => a.y - b.y || a.x - b.x).map((it) => it.s).join("");
          courses.push({ name, y, sec, above, below });
        }
        out.push({ pno, boxes, courses });
      }
      return out;
    }, b64);

    // ── 评估 ──
    const all = [];
    res.forEach((r) => r.courses.forEach((c) => all.push({ pno: r.pno, ...c })));
    let nameHit = 0, secHit = 0, secMiss = [], noTruth = [];
    all.forEach((c) => {
      const truth = truthMap[norm(c.name)];
      if (!truth) { noTruth.push(c); return; }
      nameHit++;
      const pc = core(c.sec);
      const ok = truth.some((t) => { const tc = core(t);
        return tc && pc && (tc.indexOf(pc) >= 0 || pc.indexOf(tc) >= 0); });
      if (ok) secHit++;
      else secMiss.push({ ...c, truth: truth.join(" 或 ") });
    });
    console.log("=== 「框线定归属」方案 全量评估 ===");
    console.log("  抓到有名字的行 : " + all.length);
    console.log("  课程名对上真值 : " + nameHit + " / " + all.length + "  (" + (nameHit/all.length*100).toFixed(1) + "%)");
    console.log("  ★板块对上真值  : " + secHit + " / " + nameHit + "  (" + (secHit/Math.max(nameHit,1)*100).toFixed(1) + "%)");
    console.log("  旧方案（y 猜）板块: 65.3%");
    console.log("  真值里有但没抓到 : " + noTruth.length + " 门");
    console.log("\n=== 板块错的（前 15）===");
    secMiss.slice(0, 15).forEach((m) => {
      console.log("  p" + m.pno + " " + m.name.padEnd(22) + "→「" + m.sec.slice(0,20) + "」真值「" + m.truth.slice(0,22) + "」");
    });
    console.log("\n=== 没抓到真值的（前 10）===");
    noTruth.slice(0, 10).forEach((m) => console.log("  p" + m.pno + " " + m.name));
  } catch (e) { console.log("错误: " + e.message.slice(0, 250)); }
  finally { await b.close(); }
})();
