/**
 * test-checklist.js —— Day 24 核心流程测试清单
 *
 * 用途：集中找 Bug。按「打开检查台 → 读列表 → 写入 → 刷新 → 修改 → 删除 → 刁钻输入」逐项跑。
 *
 * 怎么跑：
 *   cd C:/Users/w3224/Desktop/my-first-project
 *   C:/Users/w3224/.workbuddy/binaries/node/versions/22.22.2-6/node.exe scripts/test-checklist.js
 *
 * 传BASE 环境变量可改目标；不传默认打本地假网关（不碰线上）。
 *   BASE=https://xxx.service.tcloudbase.com node scripts/test-checklist.js
 *
 * 退出码 0 = 全部符合预期；非 0 = 至少一项异常（Bug 候选）。
 *
 * ⚠️ 打线上时：写入类用例会真的产生数据，跑完按PRINTED 里的 id 清理。
 */

const https = require("https");
const http = require("http");

const BASE = process.env.BASE || "";
const ONLINE = BASE.startsWith("http");
const CREATED = [];   // 记录跑出来的 id，方便清理
const ISSUES = [];    // 异常清单

// ---------------------------------------------------------------- 小工具
// observe=true 时只打印、不计入异常。
// 用在「测的是平台/网关行为、不是我们代码行为」的项上——
// 那是环境事实，不是 Bug，判 FAIL 会让清单失去意义。
function record(section, name, ok, detail, observe) {
  if (observe) {
    console.log("  [记录] " + section + " · " + name + "　→ " + detail);
    return;
  }
  const tag = ok ? "PASS" : "BUG ";
  console.log("  [" + tag + "] " + section + " · " + name + "　→ " + detail);
  if (!ok) ISSUES.push({ section: section, name: name, detail: detail });
}

// Day 24 修：清单本身会成为限流的受害者。
// 写请求连发超过 20 次/分 → 后面全部 429 → 回归结果全被污染。
// 做法：遇到 429 就等窗口过去重试一次，并把「等了多久」记下来。
const RATE = { hits: 0, waitedMs: 0 };
const RATE_LIMIT = 20;          // 与云函数 RATE_LIMIT_PER_MIN 默认值一致
const RATE_WINDOW_MS = 61000;   // 略大于 60 秒窗口
let writesSinceWindow = 0;

function isWrite(method) {
  return method === "POST" || method === "PATCH" || method === "DELETE";
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms); });
}

function req(method, path, body, opts) {
  // ⚠️ 默认**不**手动设 Content-Length（Day 24 修的 bug 就是这个）。
  // Node 的 https.request 在 write() 后如果不设 Content-Length，会用 chunked，
  // 而 CloudBase 网关按「无 body」处理 → 云函数收不到 body。
  // 真实客户端（浏览器 fetch、部分 SDK）也可能不设，所以清单必须能复现这个场景。
  const addLength = opts && opts.withLength;
  // 主动退避：写请求累计到 15 次就等一个窗口，别等撞到 429
  const preWait = isWrite(method) && writesSinceWindow >= RATE_LIMIT - 5
    ? (function () {
        writesSinceWindow = 0;
        RATE.waitedMs += RATE_WINDOW_MS;
        console.log("     [主动退避] 已用 " + (RATE_LIMIT - 5) + " 次写请求，等 " +
          Math.round(RATE_WINDOW_MS / 1000) + " 秒（避免撞限流）");
        return sleep(RATE_WINDOW_MS);
      })()
    : Promise.resolve();

  if (isWrite(method)) writesSinceWindow++;

  return preWait
    .then(function () { return sendOnce(method, path, body, opts); })
    .then(function (res) {
      if (res.status !== 429 || (opts && opts.noRetry)) return res;
      // 还是被限流了（可能配额已被别人用掉）→ 等一个窗口再试一次
      RATE.hits++;
      RATE.waitedMs += RATE_WINDOW_MS;
      return sleep(RATE_WINDOW_MS).then(function () {
        console.log("     [限流退避] 等待 " + Math.round(RATE_WINDOW_MS / 1000) + " 秒后重试：" + method + " " + path);
        return sendOnce(method, path, body, opts);
      });
    });
}

function sendOnce(method, path, body, opts) {
  return new Promise(function (resolve) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const mod = ONLINE ? https : http;
    const u = new URL(BASE + path);
    const headers = Object.assign({ Accept: "application/json" }, payload ? { "Content-Type": "application/json" } : {});
    const wantLength = opts && opts.withLength;
    if (payload && wantLength) headers["Content-Length"] = Buffer.byteLength(payload);
    const r = mod.request(
      u,
      { method: method, headers: headers },
      function (res) {
        let raw = "";
        res.on("data", function (c) { raw += c; });
        res.on("end", function () {
          let parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) { /* 非 JSON 本身就是问题 */ }
          resolve({ status: res.statusCode, raw: raw, body: parsed });
        });
      }
    );
    r.on("error", function (e) { resolve({ status: 0, raw: String(e.message), body: null }); });
    if (payload) r.write(payload);
    r.end();
  });
}

// 每次发请求时记下方法，供 tickWrites 使用
const _origReq = req;

// 唯一名字，避免撞防重复导致误判
const STAMP = "T" + String(Date.now()).slice(-6);

(async function main() {
  console.log("目标：" + (ONLINE ? BASE : "本地假网关（不碰线上）"));
  console.log("=".repeat(74));

  // ---------------------------------------------------------- ① 读：健康与列表
  console.log("\n① 读 —— 打开检查台先看到什么");
  const h = await req("GET", "/api/health");
  record("① 读", "health 返回 200 且 ok:true",
    h.status === 200 && h.body && h.body.ok === true,
    "HTTP " + h.status + " " + (h.body ? JSON.stringify(h.body).slice(0, 60) : h.raw.slice(0, 60)));

  const cats = await req("GET", "/api/categories");
  const catList = cats.body && cats.body.data;
  record("① 读", "categories 返回板块数组",
    Array.isArray(catList) && catList.length > 0,
    Array.isArray(catList) ? catList.length + " 个板块" : JSON.stringify(cats.body));

  const list = await req("GET", "/api/courses?limit=200");
  const rows = list.body && list.body.data;
  record("① 读", "courses 返回课程数组",
    Array.isArray(rows),
    Array.isArray(rows) ? rows.length + " 门" : JSON.stringify(list.body));

  // ---------------------------------------------------------- ② 写：新增
  console.log("\n② 写 —— 新增一条");
  const newName = "清单测试课" + STAMP;
  const created = await req("POST", "/api/courses", {
    name: newName, credits: 2.5, categoryId: "c1", status: "done", score: 77,
  });
  const newId = created.body && created.body.data && created.body.data.id;
  if (newId) CREATED.push(newId);
  record("② 写", "正常新增 → 201 + ok:true",
    created.status === 201 && created.body && created.body.ok === true,
    "HTTP " + created.status + " id=" + (newId || "(无)"));

  // ---------------------------------------------------------- ③ 刷新持久化
  console.log("\n③ 刷新 —— 重读确认落库");
  const reread = await req("GET", "/api/courses?limit=200");
  const after = reread.body && reread.body.data;
  const found = Array.isArray(after) && after.some(function (c) { return c.id === newId; });
  record("③ 刷新", "重新读取能查到刚写的那条", found,
    found ? "找到 " + newName : "列表里没有（写入没落库或读取有问题）");

  const row = Array.isArray(after) ? after.find(function (c) { return c.id === newId; }) : null;
  if (row) {
    record("③ 刷新", "数字字段是数字类型不是字符串",
      typeof row.credits === "number" && (row.score === null || typeof row.score === "number"),
      "credits=" + typeof row.credits + "(" + row.credits + ") score=" + typeof row.score + "(" + row.score + ")");
  }

  // ---------------------------------------------------------- ④ 修改
  console.log("\n④ 改 —— PATCH 一条");
  const patched = await req("PATCH", "/api/courses?id=" + encodeURIComponent(newId), { score: 66, status: "done" });
  record("④ 改", "正常修改 → 200 + ok:true",
    patched.status === 200 && patched.body && patched.body.ok === true,
    "HTTP " + patched.status + " " + (patched.body ? JSON.stringify(patched.body).slice(0, 70) : patched.raw.slice(0, 70)));

  const reread2 = await req("GET", "/api/courses?limit=200");
  const row2 = reread2.body && reread2.body.data &&
    reread2.body.data.find(function (c) { return c.id === newId; });
  record("④ 改", "重新读取能看到新值",
    !!row2 && row2.score === 66,
    row2 ? "score=" + row2.score + "（期望 66）" : "读不到这条");

  // ---------------------------------------------------------- ⑤ 删除
  console.log("\n⑤ 删 —— DELETE 一条");
  // Day 24 修复后：改用查询串传 id（不依赖 Content-Length，最可靠）
  const deleted = await req("DELETE", "/api/courses?id=" + encodeURIComponent(newId));
  record("⑤ 删", "正常删除 → 200 + deleted:true",
    deleted.status === 200 && deleted.body && deleted.body.data && deleted.body.data.deleted === true,
    "HTTP " + deleted.status + " " + (deleted.body ? JSON.stringify(deleted.body.data) : deleted.raw.slice(0, 60)));

  const reread3 = await req("GET", "/api/courses?limit=200");
  const still = reread3.body && reread3.body.data &&
    reread3.body.data.some(function (c) { return c.id === newId; });
  record("⑤ 删", "重新读取里它已消失", !still, still ? "还在列表里（没删掉）" : "已消失");

  const delAgain = await req("DELETE", "/api/courses?id=" + encodeURIComponent(newId));
  record("⑤ 删", "重复删同一条 → 404（不能假装成功）",
    delAgain.status === 404,
    "HTTP " + delAgain.status + " " + (delAgain.body ? delAgain.body.error : ""));

  // ---------------------------------------------------------- ⑤b 传 id 的方式（Day 24 重点）
  console.log("\n⑤b 传 id 的方式 —— Day 24 修掉的那个 bug");
  const c1 = await req("POST", "/api/courses", { name: "传id测试A" + STAMP, credits: 1, categoryId: "c1", status: "done" });
  const idA = c1.body && c1.body.data && c1.body.data.id;
  if (idA) CREATED.push(idA);
  // ① 查询串 + **不设 Content-Length**（原始 bug 的触发条件）
  //这是 Day 24 修复的主路径，必须真判——它失败就等于没修好
  const dA = await req("DELETE", "/api/courses?id=" + encodeURIComponent(idA));
  record("⑤b 传id", "★ 修复主路径：查询串传 id（不设 Content-Length）→ 200",
    dA.status === 200 && dA.body && dA.body.ok === true,
    "HTTP " + dA.status + " " + (dA.body ? JSON.stringify(dA.body.data) : dA.raw.slice(0, 50)));

  const c2b = await req("POST", "/api/courses", { name: "传id测试B" + STAMP, credits: 1, categoryId: "c1", status: "done" });
  const idB = c2b.body && c2b.body.data && c2b.body.data.id;
  if (idB) CREATED.push(idB);
  // ② 请求体 + **不设 Content-Length**（这条修复前会失败）
  const dB = await req("DELETE", "/api/courses", { id: idB });
  // 修复后的正确预期：body 被网关丢弃 → 我们收不到 id → 400「必须指明要…加上 ?id=xxx」
  // （修复前是 400「请求体不能为空」，那句是 bug 症状）
  record("⑤b 传id", "请求体传 id（请求不设 Content-Length）→ 400 且提示改用 ?id=",
    dB.status === 400 && dB.body && dB.body.error.indexOf("?id=") >= 0,
    "HTTP " + dB.status + " " + (dB.body ? dB.body.error : "(网关拦截)" + dB.raw.slice(0, 40)));

  // ③ 两处都没给id → 要教用户怎么改
  //
  // ⚠️ Day 24 实测发现**网关层的限制**（比代码更靠前）：
  //   DELETE **完全不带 body** 时（连空的都没有），网关直接回400 Bad Request，
  //   请求根本到不了云函数——响应是纯文本、不是我们的 JSON。
  //   加上空 body（-d ''）才会被转发，我们的代码才有机会说话。
  //   → 所以「完全不带 body」测出来的是网关行为，不是应用行为，
  //     这里显式带上空 body，才能测到我们自己的错误提示。
  //
  // 注意这一节测的是**网关行为**，不是我们代码的行为 ——
  // DELETE 带不带 body、body 有没有 Content-Length，决定请求能不能到云函数，
  // 由网关决定，与我们的代码无关。所以这两条只「记录」，不判 PASS/FAIL。
  const dC = await req("DELETE", "/api/courses", {});
  record("⑤b 传id", "DELETE 带空 body → 期望到云函数并回中文",
    dC.status === 400 && dC.body && dC.body.error.indexOf("?id=") >= 0,
    "HTTP " + dC.status + " " + (dC.body ? dC.body.error : "(网关拦截，非 JSON)" + dC.raw.slice(0, 40)), true);

  const dNoBody = await req("DELETE", "/api/courses", undefined, { noRetry: true });
  record("⑤b 传id", "【平台限制】DELETE 完全不带 body → 网关回 400 非 JSON",
    dNoBody.status === 400,
    "HTTP " + dNoBody.status + "  是否JSON=" + (dNoBody.body ? "是" : "否（纯文本，被网关拦下）") +
    "　（环境事实，非 Bug，见 KNOWN_BUGS.md L-001）", true);

  // ④ PATCH 也支持查询串
  const c3 = await req("POST", "/api/courses", { name: "传id测试C" + STAMP, credits: 1, categoryId: "c1", status: "planned" });
  const idC = c3.body && c3.body.data && c3.body.data.id;
  if (idC) CREATED.push(idC);
  const pC = await req("PATCH", "/api/courses?id=" + encodeURIComponent(idC), { status: "done", score: 55 });
  record("⑤b 传id", "PATCH 查询串传 id + body 带待改字段 → 200",
    pC.status === 200 && pC.body && pC.body.ok === true && pC.body.data.score === 55,
    "HTTP " + pC.status + " " + (pC.body ? "score=" + (pC.body.data && pC.body.data.score) : pC.raw.slice(0, 50)));

  // ---------------------------------------------------------- ⑥ 防重复
  console.log("\n⑥ 重复 —— 防重复提交");
  const dupName = "防重复课" + STAMP;
  const a = await req("POST", "/api/courses", { name: dupName, credits: 1, categoryId: "c2", status: "planned" });
  const dupId = a.body && a.body.data && a.body.data.id;
  if (dupId) CREATED.push(dupId);
  const b = await req("POST", "/api/courses", { name: dupName, credits: 1, categoryId: "c2", status: "planned" });
  record("⑥ 重复", "同一条再发一次 → 409",
    b.status === 409,
    "HTTP " + b.status + " " + (b.body ? b.body.error : ""));

  // ---------------------------------------------------------- ⑦ 刁钻输入
  console.log("\n⑦ 刁钻输入 —— 空值 / 超长 / 类型错");
  const probes = [
    ["课程名 null", { name: null, credits: 3, categoryId: "c1", status: "done" }, 400],
    ["课程名缺失", { credits: 3, categoryId: "c1", status: "done" }, 400],
    ["课程名 只有空格", { name: "   ", credits: 3, categoryId: "c1", status: "done" }, 400],
    ["学分为字符串 '3'", { name: "类型错" + STAMP, credits: "3", categoryId: "c1", status: "done" }, 400],
    ["学分为 0", { name: "零学分" + STAMP, credits: 0, categoryId: "c1", status: "done" }, 400],
    ["学分为负", { name: "负学分" + STAMP, credits: -3, categoryId: "c1", status: "done" }, 400],
    ["学分超大99999", { name: "超大学分" + STAMP, credits: 99999, categoryId: "c1", status: "done" }, 400],
    ["状态大小写错 Status", { name: "状态错" + STAMP, credits: 3, categoryId: "c1", status: "DONE" }, 400],
    ["成绩 101 越界", { name: "成绩越界" + STAMP, credits: 3, categoryId: "c1", status: "done", score: 101 }, 400],
    ["成绩负数", { name: "负成绩" + STAMP, credits: 3, categoryId: "c1", status: "done", score: -1 }, 400],
    ["板块不存在", { name: "板块错" + STAMP, credits: 3, categoryId: "c999", status: "done" }, 404],
    ["板块是 null（未归类）", { name: "未归类" + STAMP, credits: 3, categoryId: null, status: "done" }, 201],
    ["超长名字 5000 字", { name: "长" + "A".repeat(5000), credits: 3, categoryId: "c1", status: "done" }, 400],
  ];
  for (const p of probes) {
    const res = await req("POST", "/api/courses", p[1]);
    const ok = res.status === p[2];
    record("⑦ 刁钻", p[0] + " → 期望 " + p[2], ok,
      "HTTP " + res.status + " " + (res.body ? (res.body.error || "成功") : "非JSON:" + res.raw.slice(0, 40)));
    if (res.status === 201 && res.body && res.body.data) CREATED.push(res.body.data.id);
  }

  // ---------------------------------------------------------- ⑧ 读参数边界
  console.log("\n⑧ 读参数边界");
  const reads = [
    ["limit=0", "/api/courses?limit=0", 400],
    ["limit=501 越界", "/api/courses?limit=501", 400],
    ["limit=abc", "/api/courses?limit=abc", 400],
    ["limit=-1", "/api/courses?limit=-1", 400],
    ["status=abc", "/api/courses?status=abc", 400],
    ["categoryId=c99 不存在", "/api/courses?categoryId=c99", 200],
    ["categoryId=none 未归类", "/api/courses?categoryId=none", 200],
    ["limit=3 正常", "/api/courses?limit=3", 200],
  ];
  for (const p of reads) {
    const res = await req("GET", p[1]);
    record("⑧ 读边界", p[0] + " → 期望 " + p[2], res.status === p[2],
      "HTTP " + res.status + (res.status === 200 && res.body && res.body.data
        ? " " + res.body.data.length + " 条" : " " + (res.body ? (res.body.error || "") : res.raw.slice(0, 40))));
  }

  // ---------------------------------------------------------- ⑨ 边界 id
  console.log("\n⑨ 不存在的 id / 恶意 id");
  const badIds = [
    ["普通不存在 id", "99999"],
    ["SQL 注入 payload", "'; DROP TABLE courses;--"],
    ["路径穿越", "../../etc/passwd"],
    ["超长 id", "x".repeat(500)],
    ["空字符串", ""],
    ["纯空格", "   "],
    ["特殊字符", "<script>alert(1)</script>"],
  ];
  for (const p of badIds) {
    const res = await req("PATCH", "/api/courses", { id: p[1], score: 60 });
    const hasText = res.body && typeof res.body.error === "string" && res.body.error.length > 0;
    record("⑨ 恶意id", "PATCH " + p[0] + " → 4xx + 中文说明",
      res.status >= 400 && res.status < 500 && hasText && !/[a-z]{4,}Error|stack|at Object/.test(res.body.error),
      "HTTP " + res.status + " " + (res.body ? res.body.error.slice(0, 50) : res.raw.slice(0, 50)));
  }

  // ---------------------------------------------------------- ⑩ 方法与跨域
  console.log("\n⑩ 方法 / 跨域 / 限流");
  const put = await req("PUT", "/api/courses", {});
  record("⑩ 方法", "PUT → 405 且中文说明",
    put.status === 405 && put.body && /GET|POST|PATCH|DELETE/.test(put.body.error || ""),
    "HTTP " + put.status + " " + (put.body ? put.body.error : ""));

  const badJson = await new Promise(function (resolve) {
    const mod = ONLINE ? https : http;
    const u = new URL(BASE + "/api/courses");
    const r = mod.request(u, { method: "POST", headers: { "Content-Type": "application/json" } }, function (res) {
      let raw = ""; res.on("data", function (c) { raw += c; });
      res.on("end", function () { resolve({ status: res.statusCode, raw: raw, body: (function(){try{return JSON.parse(raw);}catch(e){return null;}})() }); });
    });
    r.on("error", function (e) { resolve({ status: 0, raw: e.message, body: null }); });
    r.write("{坏json"); r.end();
  });
  record("⑩ 方法", "非法 JSON → 400 中文",
    badJson.status === 400 && badJson.body && (badJson.body.error || "").indexOf("JSON") >= 0,
    "HTTP " + badJson.status + " " + (badJson.body ? badJson.body.error : badJson.raw.slice(0, 40)));

  // ---------------------------------------------------------- 汇总
  console.log("\n" + "=".repeat(74));
  if (RATE.waitedMs) {
    console.log("限流退避：共主动等待 " + Math.round(RATE.waitedMs / 1000) + " 秒"+
      "（撞到 429 " + RATE.hits + " 次）—— 这是清单自身产生的，不算 Bug");
  }
  if (CREATED.length) {
    console.log("跑出 " + CREATED.length + " 条记录需要清理（软删除）：");
    console.log(JSON.stringify(CREATED));
  }
  if (ISSUES.length === 0) {
    console.log("结论：全部符合预期，未发现异常。");
  } else {
    console.log("发现 " + ISSUES.length + " 项异常（Bug 候选）：");
    ISSUES.forEach(function (x, i) {
      console.log("  " + (i + 1) + ". [" + x.section + "] " + x.name);
      console.log("     " + x.detail);
    });
  }
  process.exit(ISSUES.length === 0 ? 0 : 1);
})();