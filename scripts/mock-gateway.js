// 本地假网关 —— 用来测检查台的「改 / 删」逻辑，不碰线上数据库
//
// 【为什么要造假网关】
// 改删都是写操作。真打线上会污染演示数据（而且有 20 次/分钟限流）。
// 这里起一个本地服务，模拟 {ok,data} / {ok,error} 的形状，
// 检查台的 api() 只需把 API_BASE 指到这里就能跑通全流程。
//
// 用法：先跑这个，再把 cloud.html 的 API_BASE 覆盖掉（见下面的 ?mock=1）
const http = require("http");

let seq = 0;
let courses = [
  { id: "t01", name: "高等数学A", credits: 5, category_id: "c1", status: "done", score: 88 },
  { id: "t02", name: "线性代数A", credits: 3, category_id: "c1", status: "done", score: 92 },
  { id: "t03", name: "形势与政策（1）", credits: 0.25, category_id: "c2", status: "planned", score: null },
  { id: "t04", name: "毕业实习与社会调查", credits: 6, category_id: "c3", status: "planned", score: null },
];

const categories = [
  { id: "c1", name: "学科基础课程", requiredCredits: 36, note: "" },
  { id: "c2", name: "通识教育课程", requiredCredits: 50.5, note: "" },
  { id: "c3", name: "综合实践课程", requiredCredits: 14, note: "" },
];

function send(res, obj, status) {
  const body = JSON.stringify(obj);
  res.writeHead(status || 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { send(res, {}, 200); return; }

  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", () => {
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (e) { body = {}; }
    const q = new URL(req.url, "http://x").searchParams;
    const path = req.url.split("?")[0];

    console.log("  ←", req.method, req.url, raw ? "  body=" + raw.slice(0, 90) : "");

    // ---------- categories ----------
    if (path === "/api/categories") {
      send(res, { ok: true, data: categories });
      return;
    }

    // ---------- courses ----------
    if (path === "/api/courses") {
      if (req.method === "GET") {
        // ⚠️ 必须把 category_id 转成 categoryId —— 真实接口在
        // coursesRepository.js 第 23 行做了这个转换（`categoryId: row.category_id`）。
        // 假网关一开始漏了，害得页面以为课程"从板块掉出去了"，
        // 差点去改本来正确的页面代码。**假网关必须忠实于真实接口的字段名。**
        send(res, {
          ok: true,
          data: courses.map((c) => ({
            id: c.id,
            name: c.name,
            credits: c.credits,
            categoryId: c.category_id,
            status: c.status,
            score: c.score,
          })),
        });
        return;
      }

      if (req.method === "POST") {
        // 复刻真实后端的学分校验（含 B-001 / B-002 / B-004）
        const name = typeof body.name === "string" ? body.name.trim() : "";
        if (!name) { send(res, { ok: false, error: "课程名不能为空" }, 400); return; }
        if (body.credits === undefined) { send(res, { ok: false, error: "缺少必填字段 credits（学分）" }, 400); return; }
        if (typeof body.credits !== "number") {
          send(res, { ok: false, error: "学分必须是数字，不能是字符串（现在收到的是「" + String(body.credits) + "」）" }, 400);
          return;
        }
        if (body.credits <= 0) { send(res, { ok: false, error: "学分必须大于 0" }, 400); return; }
        if (body.credits > 9.99) {
          send(res, { ok: false, error: "学分不能超过 9.99（现在收到的是「" + body.credits + "」，请检查是不是把课程代码或学号填进去了）" }, 400);
          return;
        }
        const cents = Math.round(body.credits * 100);
        if (cents % 25 !== 0) {
          send(res, { ok: false, error: "学分必须是 0.25 的倍数，例如 0.25、1.5、3（现在收到的是「" + body.credits + "」）" }, 400);
          return;
        }
        if (courses.some((c) => c.name === name && c.category_id === (body.categoryId || null))) {
          send(res, { ok: false, error: "已经有同名的课程了：" + name }, 409);
          return;
        }
        seq += 1;
        const row = {
          id: "t" + String(seq + 100).padStart(2, "0"),
          name: name,
          credits: body.credits,
          category_id: body.categoryId || null,
          status: body.status || "planned",
          score: body.score === undefined ? null : body.score,
        };
        courses.push(row);
        send(res, { ok: true, data: row }, 201);
        return;
      }

      if (req.method === "PATCH") {
        const id = body.id || q.get("id");
        const row = courses.find((c) => c.id === id);
        if (!row) { send(res, { ok: false, error: "课程不存在：" + id }, 404); return; }
        if (body.credits !== undefined) {
          if (typeof body.credits !== "number") {
            send(res, { ok: false, error: "学分必须是数字，不能是字符串" }, 400); return;
          }
          const cents = Math.round(body.credits * 100);
          if (cents % 25 !== 0 || body.credits <= 0 || body.credits > 9.99) {
            send(res, { ok: false, error: "学分不合法：" + body.credits }, 400); return;
          }
          row.credits = body.credits;
        }
        // ⚠️ 这里要跟真实接口一样：PATCH 的响应体是**更新后的课程对象**，
        // 而且课程的字段名是数据库列名（category_id），不是前端的 categoryId。
        // 之前这里偷懒没更新 category_id，导致页面重绘后板块显示成"未归类"——
        // 那是假网关不忠实造成的假 bug，差点让我去改正确的页面代码。
        ["name", "status", "score"].forEach((k) => {
          if (body[k] !== undefined) row[k] = body[k];
        });
        if (body.categoryId !== undefined) row.category_id = body.categoryId || null;
        // 响应体同样是 categoryId（跟 GET 一致）
        send(res, {
          ok: true,
          data: {
            id: row.id, name: row.name, credits: row.credits,
            categoryId: row.category_id, status: row.status, score: row.score,
          },
        });
        return;
      }

      if (req.method === "DELETE") {
        const id = body.id || q.get("id");
        if (!id) {
          send(res, { ok: false, error: "必须指明要删哪一条（用 ?id=xxx 或请求体）" }, 400);
          return;
        }
        const idx = courses.findIndex((c) => c.id === id);
        if (idx === -1) { send(res, { ok: false, error: "课程不存在：" + id }, 404); return; }
        const gone = courses.splice(idx, 1)[0];
        send(res, {
          ok: true,
          data: { id: id, deleted: true, restoreBefore: new Date(Date.now() + 5000).toISOString() },
        });
        return;
      }
    }

    if (path === "/api/health") { send(res, { ok: true, service: "mock" }); return; }
    send(res, { ok: false, error: "mock 未实现这条路由：" + path }, 404);
  });
});

server.listen(8902, () => console.log("假网关已启动：http://127.0.0.1:8902"));
