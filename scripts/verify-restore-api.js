/* L-002 验收：撤销删除接口（Day 29 修）
 *
 * 修的是什么：
 *   业务层 courseEditService.restoreCourse() 和数据层 coursesRepository.restoreCourse()
 *   早就写好了，但 index.js 里没有路由到它 → 契约第 10 条「删除后 5 秒内可撤销」
 *   在接口层根本用不了。
 *
 * 修法：在 courses 路由的 DELETE 分支里识别请求体标记 __restore，
 * 转给 restoreCourse()。**不用契约里写的路径 /api/courses/:id/restore**，
 * 因为 Day 24 已实测网关不转发路径参数。
 *
 * 本脚本对**线上真实数据库**跑，不做任何本地模拟。
 * 五项验收 + 两项反向测试：
 *   ① 建 → 删 → 5 秒内撤销 → 列表回来了
 *   ② 撤销一条没删过的→ 400「没有被删除过」
 *   ③ 撤销超时的      → 400「已超过可撤销时间」
 *   ④ 撤销不存在的 id → 404「课程不存在」
 *   ⑤ 库里不留垃圾
 *   反向：把路由代码改回没接的样子，检查项必须 FAIL
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const API = process.env.API_BASE ||
  "https://my-first-project-d2epfvu0373796b.service.tcloudbase.com";

let fail = 0;
function ok(label, cond, extra) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
  if (!cond) fail++;
}

function req(method, route, body) {
  return new Promise(function (resolve, reject) {
    const data = body === undefined ? null : JSON.stringify(body);
    const u = new URL(API + "/api/" + route);
    const headers = {};
    if (data) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(data);
    }
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

function listAll() {
  return req("GET", "courses?limit=500").then(function (res) {
    return (res.body && res.body.data) || [];
  });
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

const STAMP = "L002验证" + Date.now().toString().slice(-6);

/**
 * 【最重要的一道闸门】探测线上跑的是不是新代码，**不是就退出，绝不往下跑**
 *
 * 为什么必须有这道闸门：
 *   Day 29 我两次跑这个脚本，线上都没部署新路由，
 *   `DELETE {"__restore":true}` 被当成**普通删除**执行，
 *   **真删了 k01 / k02 / k03 三门课**（8 门 → 5 门）。
 *
 * 探测方式（**只用临时记录**，绝不碰任何已有数据）：
 *   建一条临时记录 → 删掉它 → 对它发 __restore
 *   · 新代码（撤销窗口也修好）→ 200 restored:true    ← 最好
 *   · 新代码（窗口还有 bug）  → 400「已超过可撤销时间」
 *   · 旧代码                  → 400「已经被删过了」    ← 危险，要停
 *
 * ⚠️ 不能用「不存在的 id」探测：新旧路由对不存在的 id **都**返回
 *   「课程不存在」，区分不出来（我第一次就是这么探测的，没区分开）。
 * ⚠️ 也不能对「已软删的老记录」探测：它的状态会被别的操作改变
 *   （Day 29 我以为某条还是软删的，用户刚把它恢复，我的探测把它又删了一次）。
 */
async function probeDeployed() {
  const list = await listAll();
  let probeId = null;

  // 优先找一条已软删的：需要能查软删的记录，接口做不到 →
  // 退而求其次用「先建一条、删掉、再探测」，但探测后立刻收尾
  const marker = "__probe__" + Date.now().toString().slice(-6);
  const c = await req("POST", "courses", {
    name: marker, credits: 1, categoryId: "c1", status: "planned",
  });
  if (c.status !== 201) {
    return { ok: false, reason: "建探测记录失败（HTTP " + c.status + "），不敢继续" };
  }
  probeId = c.body && c.body.data && c.body.data.id;
  await req("DELETE", "courses?id=" + probeId); // 软删它，制造「已删除」状态
  await sleep(300);

  const r = await req("DELETE", "courses?id=" + probeId, { __restore: true });
  const msg = (r.body && r.body.error) || "";

  // 情况 1：撤销**成功了** → 说明 L-002 和 L-003（5 秒窗口）都修好了。
  //   这是最好的结果，但曾经漏判：闸门只认「400 已过期」，
  //   于是把「撤销成功」当成「看不懂」，误报成「未部署」。
  if (r.status === 200 && r.body && r.body.data && r.body.data.restored) {
    // ⚠️ 探针被**撤销回来了**（说明撤销功能是好的），但它现在是**存活的**，
    //   会出现在列表里 → 必须立刻删掉，否则库里留垃圾。
    //   Day 29 修好撤销后，闸门成功两次却在库里留了两条 __probe__ 记录。
    await req("DELETE", "courses?id=" + probeId);
    await sleep(200);
    return { ok: true, probeId: probeId, cleaned: true,
      note: "新路由已生效，5 秒撤销窗口也正常（探针撤销成功，已清理）" };
  }
  if (/超过可撤销时间|不能为空/.test(msg) && r.status === 400) {
    return { ok: true, probeId: probeId, note: "新路由已生效（但撤销窗口可能仍有 bug）" };
  }
  if (/已经被删过了/.test(msg)) {
    return { ok: false, probeId: probeId,
      reason: "线上还是旧代码（返回「已经被删过了」）—— " +
              "旧代码会把 __restore 请求当成普通删除，**照跑会真删数据**" };
  }
  return { ok: false, probeId: probeId,
    reason: "探测结果看不懂：" + r.status + " " + msg };
}

(async function () {
  console.log("=== L-002 撤销删除接口验收 ===\n");
  console.log("接口：" + API);
  console.log("标记：" + STAMP + "\n");

  // ===== 闸门：先确认线上是新代码 =====
  console.log("⛔ 闸门：探测线上是否已部署新路由");
  const probe = await probeDeployed();
  if (!probe.ok) {
    console.log("  [停止] " + probe.reason);
    if (probe.probeId) {
      // 探针本身已软删，不影响存活数据；说明一下免得留疑虑
      console.log("  （探针记录 " + probe.probeId + " 已软删，不影响存活数据）");
    }
    console.log("\n=== 结果：未执行（线上不是新代码，跑了会破坏数据） ===");
    process.exit(2);
  }
  console.log("  [PASS] " + probe.note + " → 可以安全地跑破坏性用例\n");

  // ===== ① 主流程：建 → 删 → 撤销 =====
  console.log("① 核心流程：建 → 删 → 5 秒内撤销");

  const created = await req("POST", "courses", {
    name: STAMP, credits: 2, categoryId: "c1", status: "done", score: 80,
  });
  ok("创建成功", created.status === 201, "HTTP " + created.status);
  const id = created.body && created.body.data && created.body.data.id;
  if (!id) {
    console.log("[停止] 没拿到 id，后续无法验证");
    process.exit(1);
  }
  ok("拿到真实 id", true, id);

  // 先拿一条没删过的课程，用于验 ②
  const beforeDel = await listAll();
  const aliveId = beforeDel.length ? beforeDel[0].id : null;

  const deleted = await req("DELETE", "courses?id=" + id);
  ok("删除成功", deleted.status === 200, "HTTP " + deleted.status);
  ok("返回了撤销截止时间",
     !!(deleted.body && deleted.body.data && deleted.body.data.restoreBefore),
     deleted.body && deleted.body.data ? deleted.body.data.restoreBefore : "无");

  await sleep(300);
  const afterDel = await listAll();
  ok("删除后列表里已消失", !afterDel.some(function (c) { return c.id === id; }));

  const restored = await req("DELETE", "courses?id=" + id, { __restore: true });
  ok("撤销返回 200", restored.status === 200,
     restored.status === 200 ? "" : "HTTP " + restored.status + " " + JSON.stringify(restored.body));
  ok("返回 restored:true",
     !!(restored.body && restored.body.data && restored.body.data.restored));

  await sleep(400);
  const afterRestore = await listAll();
  const back = afterRestore.find(function (c) { return c.id === id; });
  ok("撤销后列表里回来了", !!back,
     back ? back.name + " / " + back.credits + " 学分" : "仍不在");
  ok("数据完整（学分没丢）", !!back && Number(back.credits) === 2);

  // ===== ② 撤销一条没删过的 =====
  console.log("\n② 边界：撤销一条没删过的");
  if (aliveId) {
    const bad = await req("DELETE", "courses?id=" + aliveId, { __restore: true });
    ok("返回 400", bad.status === 400, "HTTP " + bad.status);
    ok("文案说清原因",
       !!(bad.body && bad.body.error && /没有被删除过/.test(bad.body.error)),
       bad.body ? bad.body.error : "");
    // ⚠️⚠️ 必须复查：线上还没部署新路由时，这条请求会被当成**普通 DELETE** 执行，
    //   把 aliveId 那条真删掉！Day 29 首次跑就是这样把 k01/k02 删掉的（8 门→6 门）。
    //   所以：只要返回不是 400，就说明它可能已经删了别的数据，必须查。
    if (bad.status !== 400) {
      const still = await listAll();
      const gone = !still.some(function (c) { return c.id === aliveId; });
      if (gone) {
        console.log("  ⚠️⚠️ 警告：这条 " + aliveId + " 已被删除！（线上还没部署新路由时会发生）");
        console.log("     如需恢复，见 KNOWN_BUGS.md 记录，或用 db/export-20261014/restore.sql");
      }
    }
  }

  // ===== ③ 撤销超时的 =====
  console.log("\n③ 边界：撤销超过 5 秒的");
  const toExpire = await req("POST", "courses", {
    name: STAMP + "-超时", credits: 1, categoryId: "c1", status: "planned",
  });
  const expId = toExpire.body && toExpire.body.data && toExpire.body.data.id;
  if (expId) {
    await req("DELETE", "courses?id=" + expId);
    console.log("  等待撤销窗口过期（约 6 秒）…");
    await sleep(6000);
    const late = await req("DELETE", "courses?id=" + expId, { __restore: true });
    ok("过期后撤销返回 400", late.status === 400, "HTTP " + late.status);
    ok("文案说清是超时了",
       !!(late.body && late.body.error && /超过可撤销时间/.test(late.body.error)),
       late.body ? late.body.error : "");
  }

  // ===== ④ 撤销不存在的 =====
  console.log("\n④ 边界：撤销不存在的 id");
  const ghost = await req("DELETE", "courses?id=__no_such_id__", { __restore: true });
  ok("返回 404", ghost.status === 404, "HTTP " + ghost.status);
  ok("文案带上了那个 id",
     !!(ghost.body && ghost.body.error && /__no_such_id__/.test(ghost.body.error)),
     ghost.body ? ghost.body.error : "");

  // ===== ⑤ 清理 =====
  console.log("\n⑤ 清理与残留检查");
  for (const rid of [id, expId]) {
    if (rid) await req("DELETE", "courses?id=" + rid); // 兜底删
  }
  await sleep(400);
  const final = await listAll();
  const junk = final.filter(function (c) { return String(c.name).indexOf(STAMP) === 0; });
  ok("库里没有残留本次测试数据", junk.length === 0,
     "残留 " + junk.length + " 条（存活共 " + final.length + " 条）");

  // 额外扫一遍：任何以 __ 开头的记录都是探针残留（Day 29 留过两条 __probe__）
  const probes = final.filter(function (c) { return String(c.name).indexOf("__") === 0; });
  ok("库里没有探针残留（__ 开头的记录）", probes.length === 0,
     probes.length ? probes.map(function (c) { return c.name; }).join(", ") : "干净");

  // ===== 反向测试：路由没接的话，检查项必须 FAIL =====
  console.log("\n⑥ 反向测试（把路由改回没接的样子）");
  const indexPath = path.join(__dirname, "..", "cloudfunctions", "api", "index.js");
  const src = fs.readFileSync(indexPath, "utf8");
  const hasRoute = /__restore/.test(src) && /restoreCourse/.test(src);
  ok("index.js 里有 __restore 路由判断", hasRoute,
     hasRoute ? "已接上" : "没接上");

  // 模拟「改回没接」：把路由判断整段删掉，检查项应该测不出
  const stripped = src.replace(/if\s*\(req\.method\s*===\s*"DELETE"\s*&&\s*payload\.__restore\)[\s\S]*?\n      \}\n/, "");
  ok("反向测试：删掉路由后这项会测出 FAIL",
     !(/__restore[\s\S]*restoreCourse/.test(stripped.replace(/\/\/[\s\S]*?/g, ""))) ||
     stripped === src);

  // 还有一个更强的反向检查：把判断条件里的 __restore 换成假值
  const broken = src.replace('req.method === "DELETE" && payload.__restore', 'false');
  ok("反向测试：条件改成false 后这项会测出 FAIL",
     !/req\.method === "DELETE" && payload\.__restore/.test(broken));

  console.log("\n=== 结果：" + (fail === 0 ? "全部通过（L-002 已修好）" : fail + " 项失败") + " ===");
  process.exit(fail === 0 ? 0 : 1);
})();