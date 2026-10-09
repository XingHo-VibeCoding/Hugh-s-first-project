/**
 * verify-errors.js —— 安全自查清单第⑤⑥ 项的验证脚本
 *
 * 作用：用一个「假网关」代替真实数据库，按需制造后端故障，
 *      然后调云函数入口，看对外返回的是不是人话、有没有泄露内部术语。
 *
 * 为什么需要它：网络/接口错在线上**造不出来**（控制台没有故障注入开关），
 *   而这一类恰恰最需要验证—— 它是「用户看到的是不是人话」的最后一道防线。
 *
 * 怎么跑（必须先 cd 到仓库根目录，因为脚本用相对路径定位项目文件）：
 *   C:/Users/w3224/.workbuddy/binaries/node/versions/22.22.2-6/node.exe scripts/verify-errors.js
 *
 * 怎么算通过：输出里四类故障都返回中文，且「泄露扫描」一节显示 0 命中。
 */
const http = require("http");

const NODE_LABEL = "verify-errors";
const SCENARIOS = [
  { key: "nokey", fake: null, label: "缺 API Key",expect: "数据库暂时连不上，请稍后再试" },
  { key: "401",   fake: "401",   label: "Key 无效/权限不足", expect: "数据库暂时连不上，请稍后再试" },
  { key: "500",   fake: "500",   label: "数据库内部报错",     expect: "数据库服务暂时异常，请稍后再试" },
  { key: "404",   fake: "404",   label: "表名写错",           expect: "数据库访问异常，请稍后再试" },
];

// 17 个内部术语，接口响应里一个都不该出现
const LEAKS = [
  "socket hang up", "ECONNRESET", "INTERNAL_ERROR", "PGRST", "db exploded",
  "at Object", ".js:", "node_modules", "Traceback", "apikey", "Bearer",
  "MISSING_CREDENTIALS", "PGRST205", "Cannot read property", "undefined",
  "public.course", "ECONNREFUSED",
];

const gateway = http.createServer(function (req, res) {
  if (process.env.FAKE === "401") {
    res.writeHead(401, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: "MISSING_CREDENTIALS", message: "Credentials missing" }));
  }
  if (process.env.FAKE === "500") {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: "INTERNAL_ERROR", message: "db exploded" }));
  }
  if (process.env.FAKE === "404") {
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ code: "PGRST205", message: "Could not find the table public.course" }));
  }
  if (process.env.FAKE === "hangup") return req.socket.destroy();
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end("[]");
});

function loadIndex() {
  const p = require.resolve("../cloudfunctions/api/index.js");
  delete require.cache[p];
  return require(p);
}

(async function main() {
  await new Promise(function (r) { gateway.listen(0, "127.0.0.1", r); });
  process.env.CLOUDBASE_RDB_BASE = "http://127.0.0.1:" + gateway.address().port;
  process.env.API_ROUTE = "";

  const lines = [];
  let leakTotal = 0;
  let mismatch = 0;

  function record(label, res, expected) {
    let body = {};
    try { body = JSON.parse(res.body); } catch (e) { /* 非 JSON 本身就是问题 */ }
    const err = body.error || "";
    const leaks = LEAKS.filter(function (k) { return err.indexOf(k) >= 0; });
    leakTotal += leaks.length;
    const okText = expected === null || err === expected;
    if (!okText) mismatch++;
    lines.push(
      (okText && leaks.length === 0 ? "  ✓ " : "  ✗ ") +
      label.padEnd(22) + "HTTP " + String(res.statusCode).padEnd(4) +
      "文案=" + err +
      (leaks.length ? "　❌泄露:" + leaks.join(",") : "")
    );
  }

  lines.push("── ② 网络/接口错（注入后端故障）────────────────────");

  for (const s of SCENARIOS) {
    process.env.FAKE = s.fake;
    delete process.env.CLOUDBASE_API_KEY;
    delete process.env.CLOUDBASE_APIKEY;
    if (s.key !== "nokey") process.env.CLOUDBASE_API_KEY = "test-key";
    const index = loadIndex();
    const res = await index.main({ httpMethod: "GET", path: "/api/courses", queryStringParameters: {} });
    record(s.label, res, s.expect);
  }

  // ③ 服务端错：让业务层抛一个真异常
  const svcPath = require.resolve("../cloudfunctions/api/services/courseService.js");
  delete require.cache[svcPath];
  const svc = require(svcPath);
  const originalList = svc.listCourses;
  svc.listCourses = async function () {
    const e = new Error('TypeError: Cannot read property "trim" of undefined');
    throw e;
  };
  process.env.FAKE = "none";
  process.env.CLOUDBASE_API_KEY = "test-key";
  const idx2 = loadIndex();
  const r3 = await idx2.main({ httpMethod: "GET", path: "/api/courses", queryStringParameters: {} });
  lines.push("── ③ 服务端错 ────────────────────────────────────");
  record("业务层抛未预期异常", r3, "读取课程列表失败，稍后再试");
  svc.listCourses = originalList;

  lines.push("");
  lines.push("  泄露扫描：" + LEAKS.length + " 个内部术语 × " + (SCENARIOS.length + 1) + " 条响应");
  lines.push("  → 命中 " + leakTotal + " 处" + (leakTotal === 0 ? "　✅" : "　❌"));
  lines.push("  文案不符： " + mismatch + " 处" + (mismatch === 0 ? "　✅" : "　❌"));
  lines.push("");
  lines.push(leakTotal === 0 && mismatch === 0
    ? "  结论：通过 —— 全部是中文人话，且零泄露"
    : "  结论：不通过 —— 有泄露或文案与契约不符");

  console.log(lines.join("\n"));
  gateway.close();
  process.exit(leakTotal === 0 && mismatch === 0 ? 0 : 1);
})();
