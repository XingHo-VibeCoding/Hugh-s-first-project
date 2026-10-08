// Day 22 新增：修改与删除的业务逻辑（PATCH / DELETE / restore）
// 单独放在这个文件里，由 courseService.js 用 require 引入——保持每个文件职责单一。
//
// 分层提醒：本文件属于**业务层**，知道"规则"（能不能改、改名要不要查重、删了能撤销多久），
// 但不知道"怎么查"——那些在 repositories/coursesRepository.js 里。

const categoryRepo = require("../repositories/categoriesRepository");
const courseRepo = require("../repositories/coursesRepository");

/** 可撤销删除的时间窗（契约第 9 条定的 5 秒） */
const RESTORE_WINDOW_SECONDS = 5;

/** 业务错误：带 httpStatus 和 code，入口层负责翻成 {ok:false,error} */
function businessError(message, httpStatus, code) {
  return { __error: true, message: message, httpStatus: httpStatus, code: code };
}

/**
 * 校验并取出请求里的 id。
 *
 * ⚠️ 这是今天最重要的"防呆"：**操作不存在的 id 必须返回明确中文错误，
 * 不能崩、不能返回 500 裸报错，更不能报"成功"。**
 */
function readId(body) {
  if (!body || !("id" in body)) {
    return businessError("缺少必填字段 id（要修改或删除哪一条）", 400, "VALIDATION_ERROR");
  }
  const id = typeof body.id === "string" ? body.id.trim() : String(body.id || "").trim();
  if (!id) {
    return businessError("id 不能是空字符串", 400, "VALIDATION_ERROR");
  }
  return id;
}

/** 契约第 8 条允许改的字段：前端名 → 数据库列名 */
const PATCHABLE = { name: "name", credits: "credits", categoryId: "category_id", status: "status", score: "score" };

/** 把业务层的 camelCase 值转成数据库列名 */
function toDbRow(input) {
  return {
    name: input.name,
    credits: input.credits,
    category_id: input.categoryId,
    status: input.status,
    score: input.score,
  };
}

/**
 * 修改一条课程。
 * 顺序：取 id → 查存在 → 收集待改字段 → 补齐未改字段后整体校验 → 查重 → 写。
 *
 * ⚠️ 改名或换板块后**必须重新查重**：原来叫「线性代数」改成「高等数学A」，
 * 可能撞上已有的「高等数学A」。数据库的 UNIQUE 会兜底，但那时的错误是英文 409，得自己翻译。
 */
async function updateCourse(body, validateCourse) {
  const idResult = readId(body);
  if (idResult.__error) return idResult;
  const id = idResult;

  const existing = await courseRepo.findCourseById(id);
  if (!existing || existing.deleted_at) {
    return businessError("课程不存在：" + id + (existing && existing.deleted_at ? "（已被删除）" : ""), 404, "NOT_FOUND");
  }

  // 收集本次要改的字段
  const fields = [];
  Object.keys(PATCHABLE).forEach(function (key) {
    if (key in body) fields.push(key);
  });
  if (fields.length === 0) {
    return businessError(
      "没有要修改的字段。可改字段：name / credits / categoryId / status / score",
      400,
      "VALIDATION_ERROR"
    );
  }

  // 把没传的字段用原值补齐 → 复用第 7 条的校验表，只报真正传错的那个
  const merged = {
    name: "name" in body ? body.name : existing.name,
    credits: "credits" in body ? body.credits : Number(existing.credits),
    categoryId: "categoryId" in body ? body.categoryId : existing.category_id,
    status: "status" in body ? body.status : existing.status,
    score: "score" in body ? body.score : (existing.score === null ? null : Number(existing.score)),
  };
  const checked = validateCourse(merged);
  if (!checked.ok) return businessError(checked.error, 400, "VALIDATION_ERROR");

  const row = toDbRow(checked.value);

  // 改名 / 换板块 → 重新查重（排除自己）
  const nameChanged = row.name !== existing.name;
  const catChanged = String(row.category_id || "") !== String(existing.category_id || "");
  if (nameChanged || catChanged) {
    const dup = await courseRepo.findCourseByName(row.name, row.category_id);
    if (dup && dup.id !== id) {
      const scope = row.category_id ? "板块 " + row.category_id + " 下" : "未归类里";
      return businessError(scope + "已经有同名的课程了：" + row.name + "（改成这个名字的另一条已经存在）", 409, "VALIDATION_ERROR");
    }
  }

  // 板块必须真实存在
  if (row.category_id) {
    const category = await categoryRepo.findCategoryById(row.category_id);
    if (!category) return businessError("板块不存在：" + row.category_id, 404, "NOT_FOUND");
  }

  try {
    const updated = await courseRepo.updateCourse(id, row);
    return { updated: updated, fields: fields };
  } catch (err) {
    if (err && err.status === 409) {
      return businessError("板块 " + (row.category_id || "未归类") + " 下已经有同名的课程了：" + row.name, 409, "VALIDATION_ERROR");
    }
    if (err && err.status === 404) {
      return businessError("课程不存在：" + id, 404, "NOT_FOUND");
    }
    throw err;
  }
}

/**
 * 软删除一条课程（契约第 9 条）。
 *
 * ⚠️ **为什么不是真删**：删除是不可逆的，删错了就没了。
 * 建表时（db/schema.sql 第 55–56 行）就留了 deleted_at / delete_expires_at 两列，
 * 这里只打标记，数据行仍在表里；列表接口的 deleted_at=is.null 会自动跳过它。
 * 5 秒内可以反悔（restore）。
 */
async function deleteCourse(body) {
  const idResult = readId(body);
  if (idResult.__error) return idResult;
  const id = idResult;

  const existing = await courseRepo.findCourseById(id);
  if (!existing) return businessError("课程不存在：" + id, 404, "NOT_FOUND");
  if (existing.deleted_at) {
    return businessError("这条课程已经被删过了（删除时间 " + existing.deleted_at + "）", 404, "NOT_FOUND");
  }

  const now = new Date();
  const expires = new Date(now.getTime() + RESTORE_WINDOW_SECONDS * 1000);
  try {
    await courseRepo.softDeleteCourse(id, now.toISOString());
  } catch (err) {
    if (err && err.status === 404) {
      // 并发：两次删除同时到，第二条受影响 0 行
      return businessError("课程不存在或已被删除：" + id, 404, "NOT_FOUND");
    }
    throw err;
  }

  return { id: id, deleted: true, restoreBefore: expires.toISOString(), name: existing.name };
}

/** 撤销删除（契约第 10 条）。过期的行由数据层过滤掉 → 这里返回 404。 */
async function restoreCourse(body) {
  const idResult = readId(body);
  if (idResult.__error) return idResult;
  const id = idResult;

  const existing = await courseRepo.findCourseById(id);
  if (!existing) return businessError("课程不存在：" + id, 404, "NOT_FOUND");
  if (!existing.deleted_at) {
    return businessError("这条课程没有被删除过，无需撤销", 400, "VALIDATION_ERROR");
  }
  if (existing.delete_expires_at && new Date(existing.delete_expires_at).getTime() < Date.now()) {
    return businessError("已超过可撤销时间（" + RESTORE_WINDOW_SECONDS + " 秒），这次删除已生效", 400, "VALIDATION_ERROR");
  }

  try {
    const restored = await courseRepo.restoreCourse(id);
    return { id: id, deleted: false, restored: restored };
  } catch (err) {
    if (err && err.status === 404) {
      return businessError("撤销失败：已超过可撤销时间（" + RESTORE_WINDOW_SECONDS + " 秒）", 400, "VALIDATION_ERROR");
    }
    throw err;
  }
}

module.exports = {
  RESTORE_WINDOW_SECONDS: RESTORE_WINDOW_SECONDS,
  updateCourse: updateCourse,
  deleteCourse: deleteCourse,
  restoreCourse: restoreCourse,
  readId: readId,
};