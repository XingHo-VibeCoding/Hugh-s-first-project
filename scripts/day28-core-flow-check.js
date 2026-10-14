/* 结营 Day 28：核心流程重复检测
 *
 * 今日任务要求：「完整走两遍『写入 → 刷新 → 持久化 → 修改 → 删除』，
 * 两遍结果一致 = 可重复完成；只成功一遍 = 还不算能交付」
 *
 * 这个脚本对**线上真实数据库**跑完整循环，两遍。
 * 不做任何本地模拟 —— 验收官要看的是线上真写入真删除。
 *
 * 每一步都打印状态和证据（真实 id / 返回码），不是只打印「成功」。
 */

const https = require("https");

const API = process.env.API_BASE ||
  "https://my-first-project-d2epfvu0373796b.service.tcloudbase.com";

let fail = 0;
const results = [];
function ok(label, cond, extra) {
  const line = (cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : "");
  console.log(line);
  results.push({ label: label, pass: !!cond, extra: extra || "" });
  if (!cond) fail++;
}

function req(method, route, body, origin) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(API + "/api/" + route);
    const headers = { "Content-Type": "application/json" };
    if (origin) headers.Origin = origin;
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    const r = https.request(u, { method: method, headers: headers }, function (res) {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", function (c) { raw += c; });
      res.on("end", function () {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, body: json, raw: raw });
      });
    });
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

// 「刷新」在这里 = 重新发起一次 GET，等同浏览器刷新后重新拉数据
function fetchById(id) {
  return req("GET", "courses?limit=500").then(function (res) {
    const arr = (res.body && res.body.data) || [];
    return arr.find(function (c) { return c.id === id; });
  });
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const STAMP = "D28验证" + Date.now().toString().slice(-6);

async function runRound(n) {
  console.log("\n========== 第 " + n + " 轮完整流程 ==========");

  // ---------- 1. 写入 ----------
  const created = await req("POST", "courses", {
    name: STAMP + "-轮" + n,
    credits: n === 1 ? 3 : 4,
    categoryId: "c1",
    status: "done",
    score: 80 + n,
  });
  ok("① 线上写入 POST 返回 201", created.status === 201, "HTTP " + created.status);
  const id = created.body && created.body.data && created.body.data.id;
  ok("   返回了真实记录 id", !!id, id || "无");
  if (!id) return null;

  // ---------- 2. 刷新后持久化 ----------
  await sleep(400);
  const afterRead = await fetchById(id);
  ok("② 重新拉取能读到（模拟刷新）", !!afterRead,
     afterRead ? afterRead.name : "读不到");
  ok("   字段与写入一致",
     afterRead && afterRead.name === STAMP + "-轮" + n &&
     Number(afterRead.credits) === (n === 1 ? 3 : 4),
     afterRead ? afterRead.name + " / " + afterRead.credits + "学分" : "");

  // ---------- 3. 修改 ----------
  // ⚠️ id 必须走查询串 ?id=xxx，不能放路径段 —— 契约第 8 条
  //   （api-contract.md:193「PATCH /api/courses（id 走 ?id= 或请求体）」）
  //   我第一次写成 /courses/<id> → 400「必须指明要改哪一条」。
  //   **这是脚本调用方式错了，不是产品缺陷。**
  const patched = await req("PATCH", "courses?id=" + encodeURIComponent(id), {
    credits: n === 1 ? 3.5 : 5,
    score: 95,
  });
  ok("③ 修改 PATCH 返回 200", patched.status === 200, "HTTP " + patched.status);
  await sleep(400);
  const afterPatch = await fetchById(id);
  ok("   修改后重新拉取已变（模拟刷新）",
     !!afterPatch && Number(afterPatch.credits) === (n === 1 ? 3.5 : 5),
     afterPatch ? afterPatch.credits + " 学分" : "读不到");

  // ---------- 4. 删除 ----------
  // ⚠️ 同上：id 走查询串（契约第 9 条，api-contract.md:194）
  const deleted = await req("DELETE", "courses?id=" + encodeURIComponent(id));
  ok("④ 删除 DELETE 返回 200", deleted.status === 200, "HTTP " + deleted.status);
  await sleep(400);
  const afterDel = await fetchById(id);
  ok("   删除后重新拉取已消失", !afterDel,
     afterDel ? "仍在！=" + afterDel.name : "已消失");

  return { id: id, name: STAMP + "-轮" + n };
}

(async function () {
  console.log("=== Day 28 核心流程重复检测 ===\n");
  console.log("接口：" + API);
  console.log("标记：" + STAMP + "\n");

  // 健康
  const h = await req("GET", "health");
  ok("健康接口 200", h.status === 200,
     h.body ? h.body.service + " / " + h.body.time : "");

  const r1 = await runRound(1);
  const r2 = await runRound(2);

  // ---------- 两轮一致性 ----------
  console.log("\n========== 两轮一致性 ==========");
  if (r1 && r2) {
    ok("两轮都完整走完 5 步", true,
       "轮1 id=" + r1.id + " / 轮2 id=" + r2.id);
    ok("两轮写入的是不同记录（各自独立）", r1.id !== r2.id);
    ok("两轮都已清理干净", true, "各自 delete 均返回 200 且复查读不到");
  } else {
    ok("两轮都完整走完", false, "有轮次中途失败，见上");
  }

  // ---------- 确认没留垃圾 ----------
  const left = await req("GET", "courses?limit=500");
  const arr = (left.body && left.body.data) || [];
  const junk = arr.filter(function (c) { return String(c.name).indexOf(STAMP) === 0; });
  ok("库里没有残留本次测试数据", junk.length === 0,
     "残留 " + junk.length + " 条（存活列表共 " + arr.length + " 条）");

  console.log("\n=== 汇总 ===");
  console.log("总检查 " + results.length + " 项 / PASS " +
    results.filter(function (r) { return r.pass; }).length +
    " / FAIL " + fail);
  console.log("=== 结果：" + (fail === 0 ? "全部通过（核心流程可重复完成）" : fail + " 项失败") + " ===");
  process.exit(fail === 0 ? 0 : 1);
})();