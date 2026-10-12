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

// 学分上限：**必须和数据库列类型对齐**，否则会漏掉错误或误拒。
//
// 【B-004 定稿取值】数据库两列都是 numeric(4,2) → 上限 99.99。
//
// 方案换了三次才定下来，过程值得留档：
//   ① numeric(3,1) → 只能 0.5 的倍数，装不下 0.25 的课（形势与政策就是 0.25/学期）
//   ② numeric(3,2) → 上限掉到 9.99，装不下 categories 里已有的「专业核心 42」
//   ③ numeric(4,2) → 上限 99.99，**两列通用**，定这个
//
// 教训：改列类型之前必须查现有数据的实际范围。
// 我先后假设过「表里有 99999 垃圾数据」（DELETE 影响了 0 行，推翻）
// 和「courses 那条成功、categories 那条失败」（批量执行是单事务，全回滚，也错），
// 两次都是凭想象推断而不是查证。
//
// 【这里为什么还是 9.99 而不是 99.99】
// 数据库放行到 99.99，但**应用层卡得比数据库严**是安全的：
// 实际没有哪门课超过 20 学分，9.99 绰绰有余，
// 而拦得严一点能挡住「把学号/课程代码填进学分」这类误操作。
// 反过来（应用比数据库松）才会出 B-001 那种「用户没做错却被拒」的坑。
//
// 板块要求学分的上限是 99.99（线上有 42 的板块必须放行），
// 它的校验在**前端 app.js** —— 云函数目前只读板块，没有写入接口。
//
// 【三层上限必须对齐】
// 前端 < 云函数 ≤ 数据库 这个方向才安全；
// 一旦反过来，就会出现「前端过了、云函数过了、数据库拒了」。
const MAX_CREDITS = 9.99;

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
  // ⚠️ 别假设 query 里的值一定是字符串。真实前端如果写 `?limit=1`（不带引号），
  //   网关解析后可能是数字；`(123 || "").trim()` 会直接抛 TypeError → 整个请求 500。
  //   Day 22 本地测试就是这么抓到的。所以这里统一先转成字符串。
  const asText = function (v) {
    if (v === undefined || v === null) return "";
    return String(v).trim();
  };

  const keyword = asText(query.keyword);
  const categoryId = asText(query.categoryId);
  const status = asText(query.status);
  const limitRaw = asText(query.limit);

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

// ---------------------------------------------------------------- 学分校验

/**
 * 学分校验。**POST 与 PATCH 共用这一个函数**——
 * 之前两处各写一遍，改的时候很容易漏一处（B-002 就是这么漏的）。
 *
 * 三个问题在这里一起解决：
 * B-001 超大值：数据库是 numeric(3,1)，最多 999.9。传 99999 以前能过我们的校验，
 *   到数据库才炸，被当成"服务端故障"返回 503「稍后再试」——
 *   而重试一万次也一样失败，还会误导用户在那儿等。
 *   现在从源头拦住，返回 400 并直接告诉用户上限是多少。
 * B-002 类型：以前 `Number("3") === 3`，字符串悄悄变成数字通过校验。
 *   `"3abc"` 会被后面的 isFinite 拦住，但 `"3"` 是**静默通过**，
 *   让人以为校验没生效。现在 typeof 不是 number 就直接拒。
 * 粒度：0.5 → 0.25，与前端 app.js 的 isValidCreditStep() 和数据库 CHECK 约束对齐。
 *   （数据库 CHECK 约束还是 mod(credits, 0.5)，这是另一个待办，见 KNOWN_BUGS.md）
 */
function validateCredits(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, error: "缺少必填字段 credits（学分）" };
  }

  // B-002：先卡类型。JSON 里传 "3" 是字符串，说明调用方没按契约来，
  // 静默转成数字会掩盖调用方的问题（比如前端把 input.value 直接传了上来）。
  //
  // ⚠️ 文案要说"必须是数字"而不是"不能是字符串"——
  // 实测布尔值也会走到这里，说"不能是字符串"会让人以为是 bug。
  if (typeof raw !== "number") {
    return {
      ok: false,
      error:
        "学分必须是数字，不能是" +
        (typeof raw === "string" ? "字符串" : typeof raw) +
        "（现在收到的是「" +
        String(raw) +
        "」）"
    };
  }
  if (!isFinite(raw)) {
    return { ok: false, error: "学分必须是有限数字，不能是 Infinity 或 NaN" };
  }
  if (raw <= 0) {
    return { ok: false, error: "学分必须大于 0（现在收到的是「" + raw + "」）" };
  }

  // B-001：从源头拦住超范围的值，别让它走到数据库变成"服务端故障"
  if (raw > MAX_CREDITS) {
    return {
      ok: false,
      error: "学分不能超过 " + MAX_CREDITS + "（现在收到的是「" + raw + "」，请检查是不是把课程代码或学号填进去了）"
    };
  }

  // 粒度：0.25 的整数倍
  //
  // ⚠️ 必须按"百分位"判断，不能写 Math.round(raw * 4) === raw * 4。
  // 浮点误差会让 999.9（numeric(3,1) 的合法上限）算成 999.9*4=3999.6，
  // 跟 4000 不等，于是**上限值本身被拒**——这是本地单测实测出来的。
  // 转成两位小数的字符串再判断，绕开浮点误差。
  const scaled = Math.round(raw * 100);
  if (scaled % 25 !== 0) {
    return {
      ok: false,
      error: "学分必须是 0.25 的倍数，例如 0.25、1.5、3（现在收到的是「" + raw + "」）"
    };
  }

  return { ok: true, value: scaled / 100 };
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

  // 学分：必填、>0、上限内、0.25 的倍数、必须是数字
  const creditCheck = validateCredits(body.credits);
  if (!creditCheck.ok) return creditCheck;
  const credits = creditCheck.value;

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
  MAX_CREDITS: MAX_CREDITS,
  listCategories: listCategories,
  listCourses: listCourses,
  validateCourse: validateCourse,
  validateCredits: validateCredits,
  createCourse: createCourse,
  isBusinessError: function (r) { return !!(r && r.__error === true); },
};
