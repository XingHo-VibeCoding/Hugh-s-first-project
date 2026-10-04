// Day 17｜HTTP 网关统一入口（学分规划助手 · credit-planner）
//
// 一个云函数接管所有接口：网关把 /api/xxx 的请求都转到这里，函数内部按「方法 + 路径」分发。
// Day 17 只实现两个读接口：GET /api/categories、GET /api/courses。
// Day 18 起加写入接口时，只要在 dispatch() 里加一个分支 + 一个 handler，不用再新建函数。
//
// 响应形状严格照 api-contract.md 第三节：
//   成功 { ok: true, data: ... }
//   失败 { ok: false, error: "中文说明" }

const {
  listCategories,
  listCourses,
  findCategoryById,
  findCourseByName,
  insertCourse,
} = require("./db");

const SERVICE = "credit-planner";

// GET /api/courses 的 limit 上限（契约第四节第 6 条定的 500）。
// 超过上限一律 400，不做"悄悄截断"——截断会让前端以为数据只有这么多，比报错更难查。
const MAX_LIMIT = 500;

// ---------------------------------------------------------------- 响应封装

/**
 * HTTP 网关认识的「集成响应」格式。
 * Content-Type 显式带 charset=utf-8，否则中文在部分浏览器里会乱码。
 *
 * ⚠️ 兜底说明：若线上看到返回把这段整个当成了 body（statusCode/body 字段裸露），
 * 说明该环境网关不认集成响应 —— 把 json() 改成 `return payload;` 即可
 * （Day 15 的 health 就是靠直接返回对象跑通的）。
 */
function json(statusCode, payload) {
  return {
    isBase64Encoded: false,
    statusCode: statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    // Day 18 前端接入时，在这里补 CORS 头（Access-Control-Allow-Origin 等）
    body: JSON.stringify(payload),
  };
}

function ok(data, statusCode) {
  return json(statusCode || 200, { ok: true, data: data });
}

/**
 * 失败响应。code 只进服务端日志（归类用），不返回给前端——契约第三节定的。
 */
function fail(message, statusCode, code) {
  console.error("[api] 失败", code || "INTERNAL", message);
  return json(statusCode || 500, { ok: false, error: message });
}

/**
 * 业务异常的收口。数据层（db.js）抛出的错误已写成"中文 + 关键线索"且不含密钥/堆栈，
 * 标记了 expose 的直接放行——调试期报错必须能看出是密钥问题还是路径问题；
 * 其余未知异常对外只说人话，根因进日志。
 */
function internalError(err, friendlyMessage) {
  console.error(
    "[api] 原始错误",
    err && err.message,
    err && err.detail ? JSON.stringify(err.detail).slice(0, 300) : ""
  );
  return fail(err && err.expose ? err.message : friendlyMessage, 500, err && err.code);
}

// ---------------------------------------------------------------- 请求解析

function parseRequest(event) {
  const e = event || {};
  const ctx = e.requestContext || {};

  // 网关可能用两种格式之一（或同时）传 header：headers（单值）/ multiValueHeaders（数组）。
  // 实测有的请求走一种、有的走另一种（不同网关实例）——这就是"时通时不通"的来源。
  // 统一收集成 [key, value] 列表，两种都看。
  const headerPairs = [];
  [e.headers, e.multiValueHeaders].forEach(function (h) {
    if (!h || typeof h !== "object") return;
    Object.keys(h).forEach(function (key) {
      const v = h[key];
      if (Array.isArray(v)) {
        v.forEach(function (x) { if (typeof x === "string") headerPairs.push([key, x]); });
      } else if (typeof v === "string") {
        headerPairs.push([key, v]);
      }
    });
  });
  // 供"已知字段"查找用的单值视图（同名取第一个）
  const headers = {};
  headerPairs.forEach(function (pair) {
    if (headers[pair[0]] === undefined) headers[pair[0]] = pair[1];
  });

  // 不同版本网关放路径的位置五花八门，把已知位置全试一遍（按概率排序）
  const extensions = e.extensions || {};
  const extHttp = extensions.http || {};
  let rawPath = [
    e.path,
    ctx.path,
    ctx.http && ctx.http.path,
    ctx.resourcePath,
    ctx.resource,
    e.rawPath,
    e.route,
    e.resource,
    e.pathname,
    e.uri,
    e.url,
    extHttp.path,
    headers["x-forwarded-uri"],
    headers["x-original-uri"],
    headers["x-forwarded-path"],
  ].find(function (v) {
    return typeof v === "string" && v !== "";
  }) || "";

  // url / uri 可能带域名或查询串，统一剥成纯路径
  if (typeof rawPath === "string" && rawPath !== "") {
    if (rawPath.indexOf("?") >= 0) rawPath = rawPath.split("?")[0];
    if (/^https?:\/\//.test(rawPath)) {
      try { rawPath = new URL(rawPath).pathname; } catch (err) { /* 解析失败就用原值 */ }
    }
  }

  const strippedRaw = (rawPath || "").replace(/\/+$/, "");

  // 兜底：有些网关会把匹配掉的路径前缀「吃掉」，只留下 "/" 或空，
  // 原始请求路径反而放在某个 header 里（名字各家不同）。那就逐个 header 扫一遍，
  // 谁的值长得像 "/api/xxx" 就用谁。
  let scannedFrom = "";
  if (strippedRaw === "") {
    headerPairs.forEach(function (pair) {
      if (scannedFrom) return;
      const value = pair[1];
      const m = value.match(/\/(api\/[A-Za-z0-9_\-\/]*)/);
      if (m) scannedFrom = "/" + m[1];
    });
  }

  // 只有 "/" 这种空壳也算没认出来（剥掉尾部斜杠后会变空），让它进入诊断分支
  const stripped = scannedFrom || (rawPath || "").replace(/\/+$/, "");
  const recognized = stripped !== "";

  const method = (e.httpMethod || e.method || ctx.httpMethod || (ctx.http && ctx.http.method) || "").toUpperCase();
  const queryString =
    e.queryStringParameters || e.query || ctx.queryStringParameters || (ctx.http && ctx.http.queryStringParameters) || {};

  // 诊断信息：只带字段名，不带值（避免把 header 里的凭证打出去）
  const eventKeys = Object.keys(e).join(",");
  const ctxKeys = ctx && Object.keys(ctx).length ? Object.keys(ctx).join(",") : "";

  // 诊断用：网关给的 header 全列一遍——名字各家不同，只能看了才知道路径藏哪儿。
  // cookie / authorization / 带 key|token|secret 的一律打码，值截断到 120 字。
  const seen = {};
  const headerDump = headerPairs
    .filter(function (pair) {
      if (seen[pair[0]]) return false;
      seen[pair[0]] = true;
      return true;
    })
    .map(function (pair) {
      const key = pair[0];
      const raw = pair[1];
      const masked = /cookie|authorization|token|secret|key/i.test(key) ? "***" : String(raw).slice(0, 120);
      return key + "=" + masked;
    })
    .join(" | ");

  // event 里既有路径又有方法 → 正常网关请求；
  // 什么都没有 → 控制台手动「测试」（此时默认走 health）；
  // 有方法没路径 → 网关 event 结构和预期不同，进入诊断分支（见 dispatch）
  const looksLikeGateway = method !== "";

  return {
    path: stripped,
    method: method || "GET",
    query: queryString,
    recognized: recognized,
    looksLikeGateway: looksLikeGateway,
    eventKeys: eventKeys,
    ctxKeys: ctxKeys,
    headerDump: headerDump,
    pathValue: String(rawPath),
    queryKeys: Object.keys(queryString || {}).join(","),
    rawEvent: e,
    // POST 的请求体：网关可能原样给字符串，也可能 base64 编码后给（isBase64Encoded=true）
    rawBody: typeof e.body === "string" ? e.body : "",
    isBase64: e.isBase64Encoded === true || e.isBase64Encoded === "true",
  };
}

function firstValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

// ---------------------------------------------------------------- 业务处理

/** GET /api/health —— 心跳灯，不查数据库 */
async function health() {
  return json(200, { ok: true, service: SERVICE, time: new Date().toISOString() });
}

/** GET /api/categories —— 读板块列表 */
async function listCategoriesHandler() {
  try {
    return ok(await listCategories());
  } catch (err) {
    return internalError(err, "读取板块列表失败，稍后再试");
  }
}

/** GET /api/courses —— 读课程列表（keyword / categoryId / status / limit） */
async function listCoursesHandler(queryParams) {
  const keyword = (firstValue(queryParams.keyword) || "").trim();
  const categoryId = (firstValue(queryParams.categoryId) || "").trim();
  const status = (firstValue(queryParams.status) || "").trim();
  const limitRaw = (firstValue(queryParams.limit) || "").trim();

  if (status && status !== "done" && status !== "planned") {
    return fail("状态参数只能是 done 或 planned", 400, "VALIDATION_ERROR");
  }

  let limit = null;
  if (limitRaw) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      return fail("limit 必须是 1-" + MAX_LIMIT + " 的正整数", 400, "VALIDATION_ERROR");
    }
  }

  try {
    return ok(await listCourses({ keyword: keyword, categoryId: categoryId, status: status, limit: limit }));
  } catch (err) {
    return internalError(err, "读取课程列表失败，稍后再试");
  }
}

// ---------------------------------------------------------------- 写入：校验

/**
 * 解析请求体。
 * 返回三种值，调用方据此区分：
 *   undefined = 有 body 但不是合法 JSON（400）
 *   null      = 根本没有 body（400，提示缺字段）
 *   其它      = 解析出的对象
 */
function parseJsonBody(req) {
  const raw = req.rawBody || "";
  if (raw === "") return null;

  let text = raw;
  if (req.isBase64) {
    try {
      text = Buffer.from(raw, "base64").toString("utf8");
    } catch (err) {
      return undefined;
    }
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    return undefined;
  }
}

/**
 * 课程字段校验。契约第二节 + 第四节第 7 条。
 * 返回 { ok: true, value } 或 { ok: false, error }——error 一律点名"缺了什么 / 哪里不对"，
 * 不用"参数错误"这种让调用方猜的笼统话。
 */
function validateCourse(body) {
  // 课程名：必填、去空格后非空、≤30 字
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { ok: false, error: "课程名不能为空" };
  if (name.length > 30) {
    return { ok: false, error: "课程名不能超过 30 个字（现在 " + name.length + " 个字）" };
  }

  // 学分：必填、>0、必须是 0.5 的倍数
  if (body.credits === undefined || body.credits === null || body.credits === "") {
    return { ok: false, error: "缺少必填字段 credits（学分）" };
  }
  const credits = Number(body.credits);
  if (!isFinite(credits) || credits <= 0) {
    return { ok: false, error: "学分必须是大于 0 的数字（现在收到的是「" + body.credits + "」）" };
  }
  if (Math.round(credits * 2) !== credits * 2) {
    return { ok: false, error: "学分必须是 0.5 的倍数，例如 2、2.5、3（现在收到的是「" + body.credits + "」）" };
  }

  // 板块：键必须存在；值可以是 null（未归类）
  if (!("categoryId" in body)) {
    return { ok: false, error: "缺少必填字段 categoryId（板块 id；不属于任何板块就传 null）" };
  }
  let categoryId = null;
  if (body.categoryId !== null && body.categoryId !== undefined && body.categoryId !== "") {
    categoryId = String(body.categoryId).trim();
    if (!categoryId) {
      return { ok: false, error: "categoryId 不能是空字符串（不属于任何板块就传 null）" };
    }
  }

  // 状态：必填，二选一
  const status = typeof body.status === "string" ? body.status.trim() : "";
  if (!status) return { ok: false, error: "缺少必填字段 status（只能是 done 或 planned）" };
  if (status !== "done" && status !== "planned") {
    return { ok: false, error: "状态只能是 done 或 planned（现在收到的是「" + body.status + "」）" };
  }

  // 成绩：选填；planned 时传了就报错（契约：planned 时不填）
  let score = null;
  if (body.score !== undefined && body.score !== null && body.score !== "") {
    if (status === "planned") {
      return { ok: false, error: "计划中的课程（status=planned）不能填成绩" };
    }
    score = Number(body.score);
    if (!Number.isInteger(score) || score < 0 || score > 100) {
      return { ok: false, error: "成绩必须是 0-100 的整数（现在收到的是「" + body.score + "」）" };
    }
  }

  return { ok: true, value: { name: name, credits: credits, categoryId: categoryId, status: status, score: score } };
}

/** 服务端生成 id：k + 时间戳(36进制) + 4 位随机，远小于 varchar(32) 限制 */
function newCourseId() {
  return "k" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ---------------------------------------------------------------- 写入：处理

/** POST /api/courses —— 新增课程（校验 → 查板块 → 查重 → 写入） */
async function createCourseHandler(req) {
  const body = parseJsonBody(req);
  if (body === undefined) return fail("请求体不是合法的 JSON", 400, "VALIDATION_ERROR");
  if (body === null) {
    return fail("请求体不能为空，需要提交 name、credits、categoryId、status 四个字段", 400, "VALIDATION_ERROR");
  }

  const checked = validateCourse(body);
  if (!checked.ok) return fail(checked.error, 400, "VALIDATION_ERROR");
  const input = checked.value;

  const where = input.categoryId ? "板块 " + input.categoryId + " 下" : "未归类里";

  try {
    // ① 板块必须真实存在（未归类除外）
    if (input.categoryId) {
      const category = await findCategoryById(input.categoryId);
      if (!category) return fail("板块不存在：" + input.categoryId, 404, "NOT_FOUND");
    }

    // ② 防重复：同板块（或未归类）下不能同名
    const duplicated = await findCourseByName(input.name, input.categoryId);
    if (duplicated) {
      return fail(where + "已经有同名的课程了：" + input.name, 409, "VALIDATION_ERROR");
    }

    // ③ 写入
    const created = await insertCourse({
      id: newCourseId(),
      name: input.name,
      credits: input.credits,
      category_id: input.categoryId,
      status: input.status,
      score: input.score,
    });

    console.log("[api] 新增课程成功", created.id, input.name, "板块=" + (input.categoryId || "未归类"));
    return ok(created, 201);
  } catch (err) {
    // 数据库唯一约束兜底：万一两次请求并发穿过上面的查重，这里仍能给出人话
    if (err && err.status === 409) {
      return fail(where + "已经有同名的课程了：" + input.name, 409, "VALIDATION_ERROR");
    }
    return internalError(err, "保存课程失败，稍后再试");
  }
}

/**
 * 排错用：把网关传进来的 event 原样回显（脱敏后）。
 * 只有给函数配了环境变量 DEBUG_EVENT=1 才生效——因为云函数日志在这个环境里查不到数据，
 * 只能让函数自己"开口说话"。
 *
 * 脱敏规则：header 里名字带 auth / key / token / cookie / secret / sign 的值，
 * 以及 requestContext 里的 uin / appId（账号标识），一律替换成 "***"。
 * 只在你自己的浏览器里显示，不进仓库、不进日志外传。
 */
function redactedEvent(e) {
  try {
    const copy = JSON.parse(JSON.stringify(e || {}));
    const sensitive = /auth|key|token|cookie|secret|sign/i;

    ["headers", "multiValueHeaders"].forEach(function (group) {
      if (copy[group] && typeof copy[group] === "object") {
        Object.keys(copy[group]).forEach(function (k) {
          if (sensitive.test(k)) copy[group][k] = "***";
        });
      }
    });

    if (copy.requestContext && typeof copy.requestContext === "object") {
      if ("uin" in copy.requestContext) copy.requestContext.uin = "***";
      if ("appId" in copy.requestContext) copy.requestContext.appId = "***";
    }

    return copy;
  } catch (err) {
    return { error: "event 序列化失败：" + (err && err.message) };
  }
}

// ---------------------------------------------------------------- 路由分发

function routeFromPath(path) {
  if (path === "/api/health") return "health";
  if (path === "/api/categories") return "categories";
  if (path === "/api/courses") return "courses";
  return null;
}

async function dispatch(req) {
  // 排错开关：DEBUG_EVENT=1 时原样回显 event（脱敏），用于确认网关到底传了什么
  if (process.env.DEBUG_EVENT === "1") {
    return json(200, {
      ok: true,
      debug: {
        apiRoute: process.env.API_ROUTE || "(未设置)",
        path: req.path,
        method: req.method,
        recognized: req.recognized,
        eventKeys: req.eventKeys,
        ctxKeys: req.ctxKeys,
        event: redactedEvent(req.rawEvent),
      },
    });
  }

  // 身份优先级：环境变量 API_ROUTE > event 里的路径。
  // 万一某个网关传给云函数的 event 里根本没有路径信息（连方法都没有），
  // 就给这个函数配一个 API_ROUTE（health / categories / courses），它就不用猜了。
  const envRoute = (process.env.API_ROUTE || "").trim();
  const route = envRoute || routeFromPath(req.path);

  if (route === "health") return health();

  if (route === "categories") {
    if (req.method !== "GET") return fail("该接口只支持 GET 请求", 405, "VALIDATION_ERROR");
    return listCategoriesHandler();
  }

  if (route === "courses") {
    // 同一个路由两种动作：GET 读列表、POST 新增。因此不用为写入再建一个云函数。
    if (req.method === "GET") return listCoursesHandler(req.query);
    if (req.method === "POST") return createCourseHandler(req);
    return fail("该接口只支持 GET 和 POST 请求", 405, "VALIDATION_ERROR");
  }

  // 以下都是「没认出来」的情况，按不同原因分别提示，方便一眼定位
  // ① 控制台手动点「测试」（event 什么都没有）→ 走 health，方便确认函数活着
  if (!req.recognized && !req.looksLikeGateway) return health();

  // ② 像网关请求但 event 里没有可用的路径字段 → 列出字段名，一次定位
  if (!req.recognized) {
    console.error("[api] event 无可用 path 字段。完整 event:", JSON.stringify(req.rawEvent));
    console.error("[api] 顶层字段:", req.eventKeys, " requestContext 字段:", req.ctxKeys);
    console.error("[api] headers:", req.headerDump);
    return json(500, {
      ok: false,
      error:
        "请求路径未识别。path 原值=「" + req.pathValue + "」｜headers：" + req.headerDump +
        "｜query 键：" + req.queryKeys +
        "｜event 顶层字段：" + req.eventKeys +
        (req.ctxKeys ? "｜requestContext 字段：" + req.ctxKeys : ""),
    });
  }

  // ③ 有路径但不认识 → 把路径值和字段名都带回来
  console.error("[api] 未知的路径:", req.method, req.path, "顶层字段:", req.eventKeys);
  return fail(
    "接口不存在：" + req.method + " " + req.path +
    "（event 顶层字段：" + req.eventKeys + "）",
    404,
    "NOT_FOUND"
  );
}

exports.main = async function (event, context) {
  // 顶层兜底：任何没预料到的异常都变成中文 JSON，绝不让前端拿到白屏或英文堆栈
  try {
    const req = parseRequest(event);

    // 服务端日志（余力加练）：每个请求留一行痕迹，方便事后排查
    // ⚠️ 只记方法与长度，不记请求体内容——日志里不该出现任何业务数据
    console.log(
      "[api] 收到请求",
      req.method,
      process.env.API_ROUTE || req.path || "(路由未识别)",
      "query键=" + (req.queryKeys || "-"),
      "body长度=" + (req.rawBody ? req.rawBody.length : 0)
    );

    return await dispatch(req);
  } catch (err) {
    return fail((err && err.message) || "服务出了点问题，稍后再试", 500, err && err.code);
  }
};
