/**
 * repositories/dbClient.js —— 数据访问层的「连接工具」（最底层，不含任何业务查询）
 *
 * 它只干一件事：把一次数据库请求安全地发出去，并把失败翻译成人能看懂的中文。
 * 这里**不认识 courses、categories 这些表名**，也不组装任何查询条件——
 * 那是 repositories/categoriesRepository.js 和 coursesRepository.js 的活。
 *
 * ⚠️ 为什么不是 pg 直连：这个环境是 CloudBase「PG 模式」数据库（角色只有
 * anon / authenticated / service_role 等系统角色，控制台不提供数据库账号密码）。
 * 官方路径是：云函数 → REST 网关（https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<表>）
 * 携带 API Key（对应 service_role，后端专用）。因此这里没有 SQL、没有连接池、
 * 也没有密码——密钥只放云函数环境变量，绝不进仓库。
 *
 * 参数化说明：筛选条件全部走 URL 查询参数（PostgREST 语法），天然没有字符串拼接 SQL 的注入面。
 */

const https = require("https");
const http = require("http");

// 环境 ID 不是机密（本来就在公网域名里），允许环境变量覆盖是为了本地测试
const ENV_ID = process.env.CLOUDBASE_ENV || "my-first-project-d2epfvu0373796b";
const BASE = process.env.CLOUDBASE_RDB_BASE || "https://" + ENV_ID + ".api.tcloudbasegateway.com/v1/rdb/rest";

/**
 * 底层请求：GET 读列表 / POST 写一行，共用同一套鉴权和错误翻译。
 * 拿到 2xx 就 resolve 解析后的 JSON，否则 reject——错误上带 status，
 * 让上层能把 409（唯一约束冲突）翻译成"重名了"这种人话。
 */
function request(method, pathAndQuery, bodyObj) {
  return new Promise(function (resolve, reject) {
    // 兼容两种来源：手动配的 CLOUDBASE_API_KEY，以及平台注入的
    // CLOUDBASE_APIKEY（无下划线，后端专用）——两者任一存在即可。
    // 配置方式见仓库根目录 .env.example。
    const apiKey = process.env.CLOUDBASE_API_KEY || process.env.CLOUDBASE_APIKEY;
    if (!apiKey) {
      const missing = new Error(
        "云函数缺少 API Key：请在云函数的「环境变量」里配置 CLOUDBASE_APIKEY 或 CLOUDBASE_API_KEY" +
        "（值取自控制台 → 环境管理 → API Key 配置 → 服务端 API Key）"
      );
      missing.code = "INTERNAL";
      // ⚠️ Day 23 修正：这是**部署配置问题**，普通用户改不了什么。
      //   原文是给部署者看的操作指引，原样返回只会让用户以为自己操作错了。
      //   expose=false → 只进日志，对外说「数据库暂时连不上，请稍后再试」。
      missing.expose = false;
      missing.kind = "DB_UNREACHABLE";
      reject(missing);
      return;
    }

    const payload = bodyObj === undefined || bodyObj === null ? null : JSON.stringify(bodyObj);
    const headers = {
      Authorization: "Bearer " + apiKey,
      Accept: "application/json",
    };
    if (payload !== null) {
      headers["Content-Type"] = "application/json";
      // 让 PostgREST 把写入后的整行原样返回，省掉"写完再查一次"的往返
      headers["Prefer"] = "return=representation";
    }

    const mod = BASE.indexOf("https:") === 0 ? https : http; // http 分支仅供本地测试桩使用
    const req = mod.request(
      BASE + pathAndQuery,
      {
        method: method,
        headers: headers,
      },
      function (res) {
        const chunks = [];
        res.on("data", function (c) { chunks.push(c); });
        res.on("end", function () {
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try { data = JSON.parse(text); } catch (e) { /* 非 JSON 交给下面按错误处理 */ }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            // 错误信息写成"人能看懂的中文 + 关键线索"：调试期必须能一眼看出
            // 是密钥问题（401/403）还是表路径问题（404）还是约束冲突（409）还是网关自身问题（5xx）
            const gwCode = data && data.code ? String(data.code) : "";
            const gwMsg = data && data.message ? String(data.message).slice(0, 120) : "";
            let msg;
              // ═══ Day 23 重写：所有分支一律不拼 gwCode / gwMsg ═══
              // 理由：它们是网关/PostgreSQL 的内部错误码（MISSING_CREDENTIALS、PGRST205…），
              // 对用户毫无意义，只会让人以为接口坏了。完整 code+message 留在 err.detail。
              if (res.statusCode === 401 || res.statusCode === 403) {
                msg = "数据库拒绝访问：API Key 缺失、无效或权限不足";
              } else if (res.statusCode === 404) {
                msg = "数据库访问路径不存在（表名或路径可能不对）";
              } else if (res.statusCode === 409) {
                msg = "数据库拒绝了这次写入：可能违反了唯一约束";
              } else if (res.statusCode >= 500) {
                msg = "数据库服务暂时异常，请稍后再试";
              } else {
                msg = "数据库请求未成功，请稍后再试";
              }
            const err = new Error(msg);
            err.status = res.statusCode;
            err.detail = data;
            // ⚠️ Day 23 决定：**一律 expose=false**。
            //   即使消息已是中文，它也属于「服务端故障」而不是「用户能自己解决的问题」，
            //   该由入口层按 kind 统一给出「数据库暂时连不上 / 超时 / 服务异常」这类话。
            //   这里保持消息完整只进日志，便于排查时对照。
            err.expose = false;
            // Day 23：给内部错误打上分类标记。上层据此给前端不同的中文说明，
            // 但**绝不把 kind 本身返回给前端**——它是内部排查用的。
            err.kind =
              res.statusCode === 401 || res.statusCode === 403 ? "DB_UNREACHABLE"
              : res.statusCode === 404 ? "DB_NOT_FOUND"
              : res.statusCode === 409 ? "DB_CONFLICT"
              : res.statusCode >= 500 ? "DB_SERVER_ERROR"
              : "DB_CLIENT_ERROR";
            reject(err);
          }
        });
      }
    );
    req.on("error", function (err) {
      // ⚠️ Day 23 自查（同伴交叉验证）抓到的真bug：
      //   超时走的是 `req.destroy(e3)`，而 destroy 会**触发 error 事件**，
      //   且事件参数就是 e3 本身。下面若无条件把它包装成 e2，
      //   「超时」就会被误报成「连不上」—— kind 被覆盖成 DB_UNREACHABLE。
      //   （Day 23 中途试过用 `rejectedByTimeout` 标记位修，
      //     结果 error 处理器直接 return，Promise 永不 settle、整个请求卡死。
      //     正确做法是在这里**认出 e3**，而不是阻止处理器运行。）
      if (err && err.isDbTimeout) {
        // 就是超时那个，别覆盖它的 kind
        reject(err);
        return;
      }
      const e2 = new Error("连接数据库失败：" + (err && err.message ? err.message : "网络错误"));
      // ⚠️ Day 23 修正：err.message 可能是 "socket hang up" / "ECONNRESET"
      // 这类**英文系统术语**，不能直接返回给用户（实测发现的真问题）。
      // expose=false → 原文只进服务端日志，前端拿到入口层按 kind 翻的标准中文。
      e2.expose = false;
      e2.systemMessage = err && err.message ? String(err.message) : ""; // 供日志对照
      e2.kind = "DB_UNREACHABLE"; // 网络层失败 = 连不上
      reject(e2);
    });
    req.setTimeout(8000, function () {
      const e3 = new Error("数据库请求超时（8 秒）");
      e3.expose = false; // 具体超时秒数是内部参数，前端只需知道「超时、稍后再试」
      e3.kind = "DB_TIMEOUT"; // Day 23：与「连不上」区分开，排查时能一眼看出是哪种
      // 这个标记让上面 error 处理器认出「这就是超时那个」，别把它误包装成网络故障
      e3.isDbTimeout = true;
      req.destroy(e3);
    });
    // POST 的请求体必须显式写出去——只 set header 不 write，服务端收到的会是空 body
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/** GET 快捷方式（所有读操作都走它） */
function requestJson(pathAndQuery) {
  return request("GET", pathAndQuery);
}

module.exports = { request: request, requestJson: requestJson, BASE: BASE };
