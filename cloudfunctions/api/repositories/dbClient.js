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
    // 兼容两种来源：手动配的 CLOUDBASE_API_KEY，以及控制台「API Key 设置」开关
    // 自动注入的 CLOUDBASE_APIKEY（无下划线，后端专用）——两者任一存在即可
    const apiKey = process.env.CLOUDBASE_API_KEY || process.env.CLOUDBASE_APIKEY;
    if (!apiKey) {
      const missing = new Error(
        "云函数缺少 API Key：请开启函数配置里的「API Key 设置」开关（选后端专用），或手动添加环境变量 CLOUDBASE_API_KEY"
      );
      missing.code = "INTERNAL";
      missing.expose = true;
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
            if (res.statusCode === 401 || res.statusCode === 403) {
              msg = "数据库拒绝访问（HTTP " + res.statusCode + (gwCode ? " " + gwCode : "") + "）：API Key 缺失、无效或权限不足";
            } else if (res.statusCode === 404) {
              msg = "数据库接口不存在（HTTP 404" + (gwCode ? " " + gwCode : "") + "）：表名或路径可能不对";
            } else if (res.statusCode === 409) {
              msg = "数据库拒绝了这次写入（HTTP 409" + (gwCode ? " " + gwCode : "") + "）：多半是违反了唯一约束（同一板块下课程名重复）";
            } else {
              msg = "数据库请求失败（HTTP " + res.statusCode + (gwCode ? " " + gwCode : "") + "）" + (gwMsg ? "：" + gwMsg : "");
            }
            const err = new Error(msg);
            err.status = res.statusCode;
            err.detail = data;
            err.expose = true; // 中文 + 关键线索，可直接返回给调用方
            reject(err);
          }
        });
      }
    );
    req.on("error", function (err) {
      const e2 = new Error("连接数据库失败：" + (err && err.message ? err.message : "网络错误"));
      e2.expose = true;
      reject(e2);
    });
    req.setTimeout(8000, function () {
      const e3 = new Error("数据库请求超时（8 秒）");
      e3.expose = true;
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
