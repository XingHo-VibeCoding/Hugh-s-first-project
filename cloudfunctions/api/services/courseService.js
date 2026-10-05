/**
 * services/courseService.js —— 课程相关的业务逻辑（校验 + 编排）
 *
 * 分层职责：业务层知道"规则"，但不知道"怎么查"。
 * 所以这里调的是 categoriesRepository / coursesRepository 的函数，
 * 拿到结果后决定「这算成功还是错误」「错误该怎么说中文」「下一步做什么」。
 *
 * index.js（入口层）里搜不到 "0.5"、搜不到 "30 个字"、搜不到 "重名"——它们都在这里。
 */

const categoryRepo = require("../repositories/categoriesRepository");
const courseRepo = require("../repositories/coursesRepository");

// GET /api/courses 的 limit 上限（契约第四节第 6 条定的 500）。
// 超过上限一律 400，不做"悄悄截断"——截断会让前端以为数据只有这么多，比报错更难查。
const MAX_LIMIT = 500;

/** 业务错误的统一形状：带 httpStatus 和 code，便于入口层转成响应 */
function businessError(message, httpStatus, code) {
  return { __error: true, message: message, httpStatus: httpStatus, code: code };
}

// ---------------------------------------------------------------- 查询

/**
 * 读课程列表。
 * 参数校验属于业务规则，所以放这里；SQL 拼装属于数据访问层，在 coursesRepository 里。
 */
async function listCourses(query) {
  const keyword = (query.keyword || "").trim();
  const categoryId = (query.categoryId || "").trim();
  const status = (query.status || "").trim();
  const limitRaw = (query.limit || "").trim();

  if (status && status !== "done" && status !== "planned") {
    return businessError("状态参数只能是 done 或 planned", 400, "VALIDATION_ERROR");
  }

  let limit = null;
  if (limitRaw) {
    limit = Number(limitRaw);
    if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_LIMIT) {
      return businessError("limit 必须是 1-" + MAX_LIMIT + " 的正整数", 400, "VALIDATION_ERROR");
    }
  }

  return courseRepo.listCourses({ keyword: keyword, categoryId: categoryId, status: status, limit: limit });
}

/** 读板块列表 */
function listCategories() {
  return categoryRepo.listCategories();
}

// ---------------------------------------------------------------- 写入

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

/**
 * 新增课程。顺序是业务决定的：校验 → 板块存在性 → 防重复 → 写入。
 * 每一步失败都返回一条 businessError，措辞在这里定（"重名了"怎么说），入口层只负责转成 JSON。
 */
async function createCourse(body) {
  const checked = validateCourse(body);
  if (!checked.ok) return businessError(checked.error, 400, "VALIDATION_ERROR");
  const input = checked.value;

  const scope = input.categoryId ? "板块 " + input.categoryId + " 下" : "未归类里";

  // ① 板块必须真实存在（未归类除外）
  if (input.categoryId) {
    const category = await categoryRepo.findCategoryById(input.categoryId);
    if (!category) return businessError("板块不存在：" + input.categoryId, 404, "NOT_FOUND");
  }

  // ② 防重复：同板块（或未归类）下不能同名
  //    注：数据库还有 UNIQUE(category_id, name) 兜底，但它不认 NULL，
  //    所以「未归类」的重名只能靠这一次查询挡住。
  const duplicated = await courseRepo.findCourseByName(input.name, input.categoryId);
  if (duplicated) {
    return businessError(scope + "已经有同名的课程了：" + input.name, 409, "VALIDATION_ERROR");
  }

  // ③ 写入
  try {
    const created = await courseRepo.insertCourse({
      id: newCourseId(),
      name: input.name,
      credits: input.credits,
      category_id: input.categoryId,
      status: input.status,
      score: input.score,
    });
    return { created: created, name: input.name, categoryId: input.categoryId };
  } catch (err) {
    // 唯一约束兜底：万一两次请求并发穿过上面的查重，这里仍能给出人话
    if (err && err.status === 409) {
      return businessError(scope + "已经有同名的课程了：" + input.name, 409, "VALIDATION_ERROR");
    }
    throw err;
  }
}

module.exports = {
  MAX_LIMIT: MAX_LIMIT,
  listCategories: listCategories,
  listCourses: listCourses,
  validateCourse: validateCourse,
  createCourse: createCourse,
  isBusinessError: function (r) { return !!(r && r.__error === true); },
};
