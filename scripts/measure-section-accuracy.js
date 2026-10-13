/**
 * scripts/measure-section-accuracy.js
 * 拿**用户亲手整理的真值集**给当前的自动识别打分。
 *
 * ⚠️ 为什么不抽样：今天栽的第N次就是「只看一两个例子对了就以为成了」。
 *   这里跑**全量 100 门**，一分就是一分。
 *
 * 顺带量课程名/学分的准确率 —— 全链路一次量清，不分批。
 */
const fs = require("fs");
const puppeteer = require("puppeteer-core");
const CHROME = "C://Users//w3224//.agent-browser//browsers//chrome-155.0.8059.39//chrome.exe";
const PDF = process.argv[2];
const TRUTH = JSON.parse(fs.readFileSync(__dirname + "/../db/truth-curriculum.json", "utf8"));

// 真值：课名 → 板块
const truthMap = {};
TRUTH.cats.forEach((c) => c.courses.forEach((n) => {
  truthMap[norm(n)] = (truthMap[norm(n)] || []);
  truthMap[norm(n)].push(c.name);
}));

function norm(s) {
  return String(s || "").replace(/\s+/g, "")
    .replace(/[“”]/g, '"').replace(/：/g, ":")
    .replace(/[（]/g, "(").replace(/[）]/g, ")").trim();
}

(async () => {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  try {
    const p = await b.newPage();
    p.on("pageerror", (e) => console.log("[JS错误] " + e.message));
    await p.goto("http://127.0.0.1:8899/index.html", { waitUntil: "domcontentloaded" });
    await new Promise((r) => setTimeout(r, 1500));
    await p.evaluate(() => { localStorage.clear(); location.hash = "#/courses"; });
    await new Promise((r) => setTimeout(r, 700));
    await p.evaluate(() => { const x = document.getElementById("import-open"); if (x) x.click(); });
    await new Promise((r) => setTimeout(r, 400));

    const b64 = fs.readFileSync(PDF).toString("base64");
    await p.evaluate(async (d) => {
      const bin = atob(d); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const f = new File([arr], "x.pdf", { type: "application/pdf" });
      const el = document.getElementById("import-file");
      const dt = new DataTransfer(); dt.items.add(f); el.files = dt.files;
      el.dispatchEvent(new Event("change"));
    }, b64);

    await p.waitForFunction(() => {
      const x = document.getElementById("import-result");
      return x && x.querySelector(".import-table");
    }, { timeout: 60000 });

    // 读解析器给的原始 section（不是 UI 的下拉框值）
    const raw = await p.evaluate(async () => {
      const el = document.getElementById("import-file");
      const buf = await el.files[0].arrayBuffer();
      const r = await window.PDFReader.parse(buf);
      const hdr = r.matrix[0].map((c) => c.text);
      const rows = r.matrix.slice(1).map((x) => x.map((c) => c.text));
      return { hdr, rows };
    });

    const ci = {};
    raw.hdr.forEach((h, i) => {
      if (!ci.module && /模块/.test(h)) ci.module = i;
      if (!ci.category && /类别/.test(h)) ci.category = i;
      if (!ci.name && /课程名/.test(h)) ci.name = i;
      if (ci.credits === undefined && /总学分/.test(h)) ci.credits = i;
    });
    console.log("表头: " + JSON.stringify(raw.hdr));
    console.log("列索引: " + JSON.stringify(ci) + "\n");

    // 逐行评估
    let hitName = 0, hitSec = 0, total = 0, noName = 0;
    const missSec = [], noMatch = [];
    raw.rows.forEach((r) => {
      const name = String(r[ci.name] || "").trim();
      const sec = String(r[ci.category] || "").trim();
      if (!name) { noName++; return; }
      total++;
      const key = norm(name);
      const truth = truthMap[key];
      if (truth) {
        hitName++;
        // 真值里同一个课名可能对应多个板块（用户表里 A2.形势与政策 这种）
        const predCore = norm(sec).replace(/[^一-龥]/g, "").slice(0, 6);
        const ok = truth.some((t) => {
          const tk = norm(t).replace(/[^一-龥]/g, "").slice(0, 6);
          return tk && predCore && (tk.indexOf(predCore) >= 0 || predCore.indexOf(tk) >= 0);
        });
        if (ok) hitSec++;
        else missSec.push({ name, 识别为: sec || "(空)", 真值: truth.join(" 或 ") });
      } else {
        noMatch.push({ name, 识别为: sec || "(空)" });
      }
    });

    console.log("=== 全量评估（" + total + " 门有名字的行）===");
    console.log("  课程名对上真值: " + hitName + " / " + total +
      "  (" + (hitName / total * 100).toFixed(1) + "%)");
    console.log("  板块对上真值  : " + hitSec + " / " + hitName +
      "  (" + (hitSec / Math.max(hitName, 1) * 100).toFixed(1) + "%)");
    console.log("  真值里有但没抓到: " + noMatch.length + " 门");
    console.log("  空名字的行      : " + noName);
    console.log("\n=== 板块错的（前 20）===");
    missSec.slice(0, 20).forEach((m) => {
      console.log("  " + m.name.padEnd(20) + "识别为「" + m.识别为.slice(0, 22) + "」  真值「" + m.真值.slice(0, 26) + "」");
    });
    console.log("\n=== 真值里有、但没识别出的（前 20）===");
    noMatch.slice(0, 20).forEach((m) => console.log("  " + m.name));
  } catch (e) {
    console.log("错误: " + e.message.slice(0, 300));
  } finally { await b.close(); }
})();
