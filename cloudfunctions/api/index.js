// Day 19｜HTTP 网关入口层（学分规划助手 · credit-planner）
//
// 【本文件只做三件事】接请求、返响应、记日志。
//   · 它不认识数据库表名（"categories" / "courses" 只出现在 repositories/）
//   · 它不认识业务规则（"0.5 的倍数" / "30 个字" / "重名" 只出现在 services/）
//   · 它不组装任何查询参数、不做任何字段校验
//
// 分层结构（Day 19 重构确立）：
//   index.js                 入口层：解析 HTTP 请求、分发路由、包装响应
//     └── services/          业务层：字段校验、调用顺序、错误措辞
//           └── repositories/  数据访问层：表名、列名、查询条件
//                 └── dbClient.js  连接工具：发请求、翻译网关错误
//
// 一个云函数接管所有接口：网关把 /api/xxx 的请求都转到这里，函数内部按「方法 + 路径」分发。
// 加写入接口只要在 dispatch() 里加一个分支，不用新建云函数（Day 18 已验证）。
//
// 响应形状严格照 api-contract.md 第三节：
//   成功 { ok: true, data: ... }
//   失败 { ok: false, error: "中文说明" }

const courseService = require("./services/courseService");
// Day 22：修改与删除的业务规则放在独立服务文件里，保持每个文件职责单一
const courseEdit = require("./services/courseEditService");
// Day 23：写接口限流（护栏，防止接口被灌垃圾数据）
const rateLimiter = require("./services/rateLimiter");

const SERVICE = "credit-planner";

// ---------------------------------------------------------------- 跨域（CORS）

/**
 * Day 20：把静态托管页面的跨域请求放行。
 *
 * ⚠️ 为什么要在代码里加，而不是在控制台的「跨域配置」里配：
 * 实测本环境的 HTTP 网关**不把 OPTIONS 预检请求转给云函数**（直接返回 405，
 * 响应头 x-cloudbase-upstream-status-code 也是 405）。控制台那个跨域开关只对
 * 「HTTP 云函数」有效，而我们是「普通云函数 + HTTP 网关」（Day 15 选 HTTP 云函数会 403）。
 * 所以只能在函数自己返回的响应头里写。
 *
 * ⚠️ 为什么不写 `Access-Control-Allow-Origin: *`：
 * 那样任何网站都能拿这个接口读写你的数据。等价于把数据库敞开给陌生人。
 * 契约第三节的约定也要求写明来源域名，不许用通配符。
 *
 * 配置方式：环境变量 CORS_ALLOWED_ORIGIN 填允许的来源，多个用英文逗号分隔。
 * 留空则回退到静态托管默认域名（最常见的情况，省事）。
 */
/**
 * 允许的来源域名。
 *
 * ⚠️ 这里两个域名的数字不同，极易写错（写错会 418 / 跨域失败）：
 *   静态托管（放页面）：…-1499184401.tcloudbaseapp.com   ← 默认来源
 *   云函数 HTTP 网关：…-1489184401.ap-shanghai.app.tcloudbase.com  ← 接口地址
 *
 * 线上通过环境变量 CORS_ALLOWED_ORIGIN 覆盖（逗号分隔多个）。
 * 留空才回退到下面这个默认值。
 */
const DEFAULT_ALLOWED_ORIGIN =
  "https://my-first-project-d2epfvu0373796b-1499184401.tcloudbaseapp.com";

function allowedOrigins() {
  const raw = (process.env.CORS_ALLOWED_ORIGIN || "").trim();
  const list = (raw || DEFAULT_ALLOWED_ORIGIN)
    .split(",")
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s !== ""; });
  return list;
}

/**
 * 跨域响应头。
 * - Allow-Origin：只回显白名单里的来源；不在白名单就不加这个头（浏览器自然会拦）
 * - Allow-Methods / Allow-Headers：预检时告诉浏览器"这些方法/头我允许"
 * - Max-Age：让浏览器缓存预检结果 10 分钟，避免每次请求都多一次 OPTIONS
 */
function corsHeaders(requestOrigin) {
  const allowed = allowedOrigins();
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "600",
  };
  if (requestOrigin && allowed.indexOf(requestOrigin) >= 0) {
    headers["Access-Control-Allow-Origin"] = requestOrigin;
  }
  return headers;
}

// ---------------------------------------------------------------- 响应封装

/**
 * HTTP 网关认识的「集成响应」格式。
 * Content-Type 显式带 charset=utf-8，否则中文在部分浏览器里会乱码。
 *
 * ⚠️ 兜底说明：若线上看到返回把这段整个当成了 body（statusCode/body 字段裸露），
 * 说明该环境网关不认集成响应 —— 把 json() 改成 `return payload;` 即可
 * （Day 15 的 health 就是靠直接返回对象跑通的）。
 */
function json(statusCode, payload, requestOrigin) {
  const base = { "Content-Type": "application/json; charset=utf-8" };
  const cors = corsHeaders(requestOrigin);
  Object.keys(cors).forEach(function (k) { base[k] = cors[k]; });

  return {
    isBase64Encoded: false,
    statusCode: statusCode,
    headers: base,
    body: JSON.stringify(payload),
  };
}

function ok(data, statusCode, requestOrigin) {
  return json(statusCode || 200, { ok: true, data: data }, requestOrigin);
}

/**
 * 失败响应。code 只进服务端日志（归类用），不返回给前端——契约第三节定的。
 */
function fail(message, statusCode, code, requestOrigin) {
  console.error("[api] 失败", code || "INTERNAL", message);
  return json(statusCode || 500, { ok: false, error: message }, requestOrigin);
}

/**
 * 业务异常的收口。数据层（repositories/dbClient.js）抛出的错误已写成"中文 + 关键线索"
 * 且不含密钥/堆栈，标记了 expose 的直接放行——调试期报错必须能看出是密钥问题还是路径问题；
 * 其余未知异常对外只说人话，根因进日志。
 */
/**
 * Day 23：错误分级。
 *
 * 原来无论哪种内部故障，对外都是同一句「服务出了点问题，稍后再试」——
 * 安全，但排查时看不出是哪一类。现在按 kind 给出不同的中文说明。
 *
 * ⚠️ **分级不等于泄露**：对外仍然只有中文话，
 *    表名 / API Key / 堆栈 / 具体的 kind 值**一律不返回前端**，只进服务端日志。
 */
const DB_ERROR_TEXT = {
  DB_UNREACHABLE: "数据库暂时连不上，请稍后再试",
  DB_TIMEOUT: "数据库响应超时，请稍后再试",
  DB_SERVER_ERROR: "数据库服务暂时异常，请稍后再试",
};

function internalError(err, friendlyMessage, requestOrigin) {
  // kind 只进日志——这是排查的唯一线索，必须留下
  console.error(
    "[api] 原始错误",
    err && err.kind ? "[" + err.kind + "]" : "",
    err && err.message,
    err && err.detail ? JSON.stringify(err.detail).slice(0, 300) : ""
  );

  // 情况一：数据层主动抛出、且已标记 expose（如"API Key 无效"这类可安全外露的）
  //         → 直接用它自己的中文消息，那里面有排查线索
  if (err && err.expose) {
    return fail(err.message, 500, err.kind || err.code, requestOrigin);
  }

  // 情况二：网络类故障（连不上 / 超时 / 服务端 5xx）→ 按 kind 给更具体的中文说明
  if (err && err.kind && DB_ERROR_TEXT[err.kind]) {
    return fail(DB_ERROR_TEXT[err.kind], 503, err.kind, requestOrigin);
  }

  // 情况三：未预期的其它错误 → 最保守的一句话
  return fail(friendlyMessage, 500, (err && err.code) || "INTERNAL", requestOrigin);
}

/**
 * 把业务层返回的结果翻成 HTTP 响应。
 * 业务层只说"这条请求失败了、该说这句话"；状态码和 JSON 形状由入口层统一处理。
 */
function send(result, statusOnSuccess, requestOrigin) {
  if (courseService.isBusinessError(result)) {
    return fail(result.message, result.httpStatus, result.code, requestOrigin);
  }
  return ok(result, statusOnSuccess, requestOrigin);
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
    // 跨域用：请求方页面在哪个域名（可能来自 headers 或 multiValueHeaders，两边都找）
    origin: headers["origin"] || headers["Origin"] || "",
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

/**
 * 解析请求体。
 * 返回三种值，调用方据此区分：
 *   undefined = 有 body 但不是合法 JSON（400）
 *   null      = 根本没有 body（400，提示缺字段）
 *   其它      = 解析出的对象
 * 这是 HTTP 层的关注点（传输格式），所以留在入口层；字段规则不在这里。
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

// ---------------------------------------------------------------- 排错工具

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
  const origin = req.origin;

  // ---- 写接口限流（Day 23）----
  // 位置很关键：必须在 OPTIONS 之后、任何业务处理之前。
  // 这样超限的请求连数据库都不用碰——省配额，也避免被恶意请求拖垮。
  if (rateLimiter.isRateLimited(req, req.method)) {
    console.warn("[api] 限流触发", req.method, rateLimiter.clientIp(req));
    return fail("操作太快了，请稍后再试", 429, "RATE_LIMITED", origin);
  }
  // 顺手清理过期计数，避免 IP 多了漏内存（概率性调用即可，不必每次都做）
  if (Math.random() < 0.02) rateLimiter.sweep();

  // 跨域预检（OPTIONS）：浏览器在真正发请求前会先问一句"我能不能发"。
  // ⚠️ 本环境的网关不把 OPTIONS 转给云函数（实测直接 405），所以这段很可能不会被执行到。
  // 但保留它有两个好处：① 万一日后网关支持了就能自动生效；② 万一请求真的到了，
  //    我们会回一个"我允许"而不是让它掉进下面的 405 分支。真正解决问题的是下面 json() 里的响应头。
  if (req.method === "OPTIONS") {
    return json(204, null, origin);
  }

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
    }, origin);
  }

  // 身份优先级：环境变量 API_ROUTE > event 里的路径。
  // 万一某个网关传给云函数的 event 里根本没有路径信息（连方法都没有），
  // 就给这个函数配一个 API_ROUTE（health / categories / courses），它就不用猜了。
  const envRoute = (process.env.API_ROUTE || "").trim();
  const route = envRoute || routeFromPath(req.path);

  if (route === "health") {
    return json(200, { ok: true, service: SERVICE, time: new Date().toISOString() }, origin);
  }

  if (route === "categories") {
    if (req.method !== "GET") return fail("该接口只支持 GET 请求", 405, "VALIDATION_ERROR", origin);
    try {
      return send(await courseService.listCategories(), 200, origin);
    } catch (err) {
      return internalError(err, "读取板块列表失败，稍后再试", origin);
    }
  }

  if (route === "courses") {
    // 同一个路由两种动作：GET 读列表、POST 新增。因此不用为写入再建一个云函数。
    if (req.method === "GET") {
      try {
        return send(await courseService.listCourses({
          keyword: firstValue(req.query.keyword) || "",
          categoryId: firstValue(req.query.categoryId) || "",
          status: firstValue(req.query.status) || "",
          limit: firstValue(req.query.limit) || "",
        }), 200, origin);
      } catch (err) {
        return internalError(err, "读取课程列表失败，稍后再试", origin);
      }
    }
    if (req.method === "POST") {
      const body = parseJsonBody(req);
      if (body === undefined) return fail("请求体不是合法的 JSON", 400, "VALIDATION_ERROR", origin);
      if (body === null) {
        return fail("请求体不能为空，需要提交 name、credits、categoryId、status 四个字段", 400, "VALIDATION_ERROR", origin);
      }
      try {
        const result = await courseService.createCourse(body);
        if (courseService.isBusinessError(result)) {
          return fail(result.message, result.httpStatus, result.code, origin);
        }
        console.log("[api] 新增课程成功", result.created.id, result.name, "板块=" + (result.categoryId || "未归类"));
        return ok(result.created, 201, origin);
      } catch (err) {
        return internalError(err, "保存课程失败，稍后再试", origin);
      }
    }
    // Day 22：PATCH（改一条）与 DELETE（软删除 + 5 秒内可撤销）
    if (req.method === "PATCH") {
      const body = parseJsonBody(req);
      if (body === undefined) return fail("请求体不是合法的 JSON", 400, "VALIDATION_ERROR", origin);
      if (body === null) return fail("请求体不能为空，必须提交 id 指明要改哪一条", 400, "VALIDATION_ERROR", origin);
      try {
        const result = await courseEdit.updateCourse(body, courseService.validateCourse);
        if (courseService.isBusinessError(result)) {
          return fail(result.message, result.httpStatus, result.code, origin);
        }
        console.log("[api] 修改课程成功", result.updated.id, "改动字段=" + result.fields.join(","));
        return ok(result.updated, 200, origin);
      } catch (err) {
        return internalError(err, "修改课程失败，稍后再试", origin);
      }
    }
    if (req.method === "DELETE") {
      const body = parseJsonBody(req);
      // DELETE 允许没有 body（空 body 当成"没说要删哪条"→ 400 并说清楚）
      if (body === undefined) return fail("请求体不是合法的 JSON", 400, "VALIDATION_ERROR", origin);
      if (body === null) return fail("请求体不能为空，必须提交 id 指明要删哪一条", 400, "VALIDATION_ERROR", origin);
      try {
        const result = await courseEdit.deleteCourse(body);
        if (courseService.isBusinessError(result)) {
          return fail(result.message, result.httpStatus, result.code, origin);
        }
        console.log("[api] 删除课程成功", result.id, "可在 " + courseEdit.RESTORE_WINDOW_SECONDS + " 秒内撤销");
        return ok({ id: result.id, deleted: true, restoreBefore: result.restoreBefore }, 200, origin);
      } catch (err) {
        return internalError(err, "删除课程失败，稍后再试", origin);
      }
    }
    return fail("该接口只支持 GET、POST、PATCH、DELETE 请求", 405, "VALIDATION_ERROR", origin);
  }

  // 以下都是「没认出来」的情况，按不同原因分别提示，方便一眼定位
  // ① 控制台手动点「测试」（event 什么都没有）→ 走 health，方便确认函数活着
  if (!req.recognized && !req.looksLikeGateway) {
    return json(200, { ok: true, service: SERVICE, time: new Date().toISOString() }, origin);
  }

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
    }, origin);
  }

  // ③ 有路径但不认识 → 把路径值和字段名都带回来
  console.error("[api] 未知的路径:", req.method, req.path, "顶层字段:", req.eventKeys);
  return fail(
    "接口不存在：" + req.method + " " + req.path +
    "（event 顶层字段：" + req.eventKeys + "）",
    404,
    "NOT_FOUND",
    origin
  );
}

exports.main = async function (event, context) {
  // 顶层兜底：任何没预料到的异常都变成中文 JSON，绝不让前端拿到白屏或英文堆栈
  try {
    const req = parseRequest(event);

    // 服务端日志（Day 18 余力加练）：每个请求留一行痕迹，方便事后排查
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
    // 这里拿不到 req，用环境变量里的默认来源（此时几乎不会走到）
    return fail((err && err.message) || "服务出了点问题，稍后再试", 500, err && err.code);
  }
};
