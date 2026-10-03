/**
 * db.js —— 数据访问层（CloudBase PG 模式 · REST 网关版）
 *
 * ⚠️ 为什么不是 pg 直连：这个环境是 CloudBase「PG 模式」数据库（角色只有
 * anon / authenticated / service_role 等系统角色，控制台不提供数据库账号密码）。
 * 官方路径是：云函数 → REST 网关（https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/<表>）
 * 携带 API Key（对应 service_role，后端专用）。因此这里没有 SQL、没有连接池、
 * 也没有密码——密钥只放云函数环境变量 CLOUDBASE_API_KEY，绝不进仓库。
 *
 * 参数化说明：筛选条件全部走 URL 查询参数（PostgREST 语法），天然没有字符串拼接 SQL 的注入面。
 */

const https = require("https");
const http = require("http");

// 环境 ID 不是机密（本来就在公网域名里），允许环境变量覆盖是为了本地测试
const ENV_ID = process.env.CLOUDBASE_ENV || "my-first-project-d2epfvu0373796b";
const BASE = process.env.CLOUDBASE_RDB_BASE || "https://" + ENV_ID + ".api.tcloudbasegateway.com/v1/rdb/rest";

/** 底层 GET：拿到 2xx 的 JSON 数组，否则抛错（保留状态码便于日志） */
function requestJson(pathAndQuery) {
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

    const mod = BASE.indexOf("https:") === 0 ? https : http; // http 分支仅供本地测试桩使用
    const req = mod.request(
      BASE + pathAndQuery,
      {
        method: "GET",
        headers: {
          Authorization: "Bearer " + apiKey,
          Accept: "application/json",
        },
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
            // 是密钥问题（401/403）还是表路径问题（404）还是网关自身问题（5xx）
            const gwCode = data && data.code ? String(data.code) : "";
            const gwMsg = data && data.message ? String(data.message).slice(0, 120) : "";
            let msg;
            if (res.statusCode === 401 || res.statusCode === 403) {
              msg = "数据库拒绝访问（HTTP " + res.statusCode + (gwCode ? " " + gwCode : "") + "）：API Key 缺失、无效或权限不足";
            } else if (res.statusCode === 404) {
              msg = "数据库接口不存在（HTTP 404" + (gwCode ? " " + gwCode : "") + "）：表名或路径可能不对";
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
    req.end();
  });
}

// ---------------------------------------------------------------- 行 → JSON 映射
// 数据库列是 snake_case，接口 JSON 是 camelCase（映射表见 api-contract.md 第二节）。
// REST 网关返回的 numeric 同样是字符串（保精度），必须显式转数字。

function toCategory(row) {
  return {
    id: row.id,
    name: row.name,
    requiredCredits:
      row.required_credits === null || row.required_credits === undefined
        ? null
        : Number(row.required_credits),
    note: row.note === null || row.note === undefined ? "" : row.note,
  };
}

function toCourse(row) {
  return {
    id: row.id,
    name: row.name,
    credits: Number(row.credits),
    categoryId: row.category_id, // 未归类就是 null
    status: row.status,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
  };
}

// ---------------------------------------------------------------- 业务查询

/** 读板块列表（对应 GET /api/categories） */
async function listCategories() {
  const rows = await requestJson(
    "/categories?select=id,name,required_credits,note&order=created_at,id"
  );
  return rows.map(toCategory);
}

/**
 * 读课程列表（对应 GET /api/courses）。
 * PostgREST 筛选语法：eq.=等于、is.null=为空、ilike.*xx*=模糊匹配（不区分大小写）
 */
async function listCourses(filter) {
  const params = new URLSearchParams();
  params.set("select", "id,name,credits,category_id,status,score");
  params.set("deleted_at", "is.null"); // 软删除的行不算数

  if (filter.keyword) params.set("name", "ilike.*" + filter.keyword + "*");

  if (filter.categoryId === "none") {
    params.set("category_id", "is.null"); // 契约约定：none 表示"未归类"
  } else if (filter.categoryId) {
    params.set("category_id", "eq." + filter.categoryId);
  }

  if (filter.status) params.set("status", "eq." + filter.status);

  params.set("order", "created_at,id"); // 先录入的在前，与第 2 周前端顺序一致
  if (filter.limit) params.set("limit", String(filter.limit));

  const rows = await requestJson("/courses?" + params.toString());
  return rows.map(toCourse);
}

module.exports = { listCategories: listCategories, listCourses: listCourses };
