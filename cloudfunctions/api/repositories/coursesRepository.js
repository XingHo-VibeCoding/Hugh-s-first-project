/**
 * repositories/coursesRepository.js —— 课程表（courses）的数据访问层
 *
 * 本文件是**唯一**知道 courses 表长什么样的地方。
 * index.js（入口层）里搜不到 "courses" 这个字符串是正常的；services 层只负责
 * 「先查板块、再查重、最后写入」这个顺序和每一步失败时该说什么话。
 *
 * PostgREST 筛选语法备忘：eq.=等于、is.null=为空、ilike.*xx*=模糊匹配（不区分大小写）
 */

const { request, requestJson } = require("./dbClient");

/**
 * 行 → JSON 映射（snake_case 列 → camelCase JSON）。
 * ⚠️ credits / score 必须显式 Number()：REST 网关为了保精度把 numeric 返回成字符串，
 * 不转的话前端算总学分会得到 "3842" 这种离谱结果（Day 17 自查抓过一次）。
 */
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

/**
 * 读课程列表（对应 GET /api/courses）。
 * @param {{keyword?:string, categoryId?:string, status?:string, limit?:number}} filter
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

/**
 * 查重：同一板块下有没有同名课程。
 *
 * ⚠️ 为什么不能只靠数据库的 UNIQUE(category_id, name)：
 * Postgres 的唯一约束**不把 NULL 视为重复**——「未归类」（category_id 为 null）的课程
 * 可以存无数个同名行，约束拦不住。所以调用方（services 层）统一先查一次，两种情况都覆盖。
 *
 * @param {string} name 课程名（精确匹配）
 * @param {string|null} categoryId 板块 id；null / 空串表示查「未归类」
 */
async function findCourseByName(name, categoryId) {
  const params = new URLSearchParams();
  params.set("select", "id,name");
  params.set("name", "eq." + name);
  params.set("deleted_at", "is.null");
  if (categoryId) params.set("category_id", "eq." + categoryId);
  else params.set("category_id", "is.null");
  params.set("limit", "1");

  const rows = await requestJson("/courses?" + params.toString());
  return rows && rows.length ? rows[0] : null;
}

/**
 * 新增课程。row 用数据库列名（snake_case），返回 camelCase 的 JSON 对象。
 * 靠 PostgREST 的 return=representation 一次拿到写入后的整行（含数据库默认值）。
 * 违反唯一约束时由 dbClient 抛 409，上层翻译成"重名了"的中文提示。
 */
async function insertCourse(row) {
  const result = await request("POST", "/courses", row);
  const created = Array.isArray(result) ? result[0] : result;
  if (!created || !created.id) {
    const err = new Error("写入后没有拿到新行，请检查表结构或字段名");
    err.expose = true;
    throw err;
  }
  return toCourse(created);
}

module.exports = {
  listCourses: listCourses,
  findCourseByName: findCourseByName,
  insertCourse: insertCourse,
  toCourse: toCourse,
};
