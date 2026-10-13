// 探测：pdf.js 里的表格框线到底以什么形式存在？
//
// 【背景】
// Day 28 定位到板块归属全错的根因：PDF 的合并单元格，组名既不在段首也不在段尾，
// 判断「某门课属于哪个组」的正确依据应该是**表格框线的起止 y**，
// 而不是「组名文字的 y 在上还是在下」。
//
// 但第一版真值脚本抓框线时抓到 0 条 —— 说明没摸对 pdf.js 的算子格式。
// 这个脚本就是把原始算子打印出来，看它到底长什么样。
//
// 用法：
//   node scripts/probe-pdf-lines.js <培养方案.pdf>

const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C:\\Users\\w3224\\.agent-browser\\browsers\\chrome-155.0.8059.39\\chrome.exe";
const FILE = process.argv[2];
const PAGE_URL = "http://127.0.0.1:8899/importer-lab.html";

(async () => {
  if (!FILE) {
    console.error("用法：node scripts/probe-pdf-lines.js <培养方案.pdf>");
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
      // 先看看页数与pdf.js 版本
      const out = { version: pdfjsLib.version, ops: {}, perPage: [] };

      // 挑第一张表格页
      let target = null;
      for (let pno = 1; pno <= doc.numPages && !target; pno++) {
        const pg = await doc.getPage(pno);
        const tc = await pg.getTextContent();
        const has = tc.items.some((t) => /^YN25/.test(t.str.trim()));
        if (has) target = pno;
      }
      if (!target) return { err: "没找到表格页" };

      const pg = await doc.getPage(target);
      const ops = await pg.getOperatorList();
      const H = pg.getViewport({ scale: 1 }).height;

      // 统计所有算子类型
      const counts = {};
      for (let i = 0; i < ops.fnArray.length; i++) {
        const name = Object.keys(OPS).find((k) => OPS[k] === ops.fnArray[i]) || ("fn" + ops.fnArray[i]);
        counts[name] = (counts[name] || 0) + 1;
      }
      out.ops = counts;
      out.page = target;
      out.H = Math.round(H);

      // 把 draw 类算子的原始参数打出来
      const drawOps = ["constructPath", "stroke", "fill", "moveTo", "lineTo", "rectangle",
                       "transform", "setLineWidth", "save", "restore"];
      const samples = [];
      for (let i = 0; i < ops.fnArray.length && samples.length < 12; i++) {
        const name = Object.keys(OPS).find((k) => OPS[k] === ops.fnArray[i]);
        if (!drawOps.includes(name)) continue;
        const args = ops.argsArray[i];
        // args 里可能有 Int8Array 等，序列化成可读形式
        let safe;
        try {
          safe = JSON.parse(JSON.stringify(args, (k, v) => {
            if (ArrayBuffer.isView(v)) return Array.from(v).slice(0, 24);
            if (typeof v === "function") return "[fn]";
            return v;
          }));
        } catch (e) {
          safe = "[无法序列化]";
        }
        samples.push({ op: name, args: safe });
      }
      out.samples = samples;
      return out;
    }, b64);

    console.log("pdf.js 版本：" + res.version);
    console.log("表格页：" + res.page + "（页高 " + res.H + "）");
    console.log("");
    console.log("=== 该页算子类型统计 ===");
    Object.entries(res.ops || {})
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, v]) => console.log("  " + String(v).padStart(6) + "  " + k));

    console.log("");
    console.log("=== 画图算子的参数样例（前 12 个）===");
    (res.samples || []).forEach((s, i) => {
      console.log("[" + i + "] " + s.op);
      console.log("    " + JSON.stringify(s.args).slice(0, 500));
    });
  } catch (e) {
    console.error("错误：" + e.message.slice(0, 300));
  } finally {
    await browser.close();
  }
})();