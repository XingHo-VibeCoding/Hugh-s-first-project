/**
 * repositories/categoriesRepository.js —— 板块表（categories）的数据访问层
 *
 * 分层约定（Day 19 重构确立）：
 *   入口层 index.js  →  接请求、返响应，不认识表名
 *   业务层 services/  →  校验、编排、报错措辞
 *   数据访问层 repositories/（本文件）→  只认表名和查询条件，返回行数据
 *
 * 所以：**表名、列名、查询参数拼装，全部只允许出现在本目录的文件里。**
 * 想改「读课程时按什么排序」，改这里；改「课程名超过多少字报错」，去 services 层。
 * 两者互不干扰——这就是拆分的意义。
 */

const { requestJson } = require("./dbClient");

/**
 * 行 → JSON 映射。
 * 数据库列是 snake_case，接口 JSON 是 camelCase（映射表见 api-contract.md 第二节）。
 * REST 网关返回的 numeric 是字符串（保精度），必须显式转数字。
 */
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

/** 读板块列表（对应 GET /api/categories） */
async function listCategories() {
  const rows = await requestJson(
    "/categories?select=id,name,required_credits,note&order=created_at,id"
  );
  return rows.map(toCategory);
}

/**
 * 板块是否存在。返回 {id,name,...} 或 null。
 * 写入前用：契约要求 categoryId 必须指向真实板块，不存在 → NOT_FOUND。
 */
async function findCategoryById(id) {
  const params = new URLSearchParams();
  params.set("select", "id,name");
  params.set("id", "eq." + id);
  params.set("limit", "1");
  const rows = await requestJson("/categories?" + params.toString());
  return rows && rows.length ? rows[0] : null;
}

module.exports = {
  listCategories: listCategories,
  findCategoryById: findCategoryById,
  toCategory: toCategory,
};
