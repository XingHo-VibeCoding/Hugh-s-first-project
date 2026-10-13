
// ============================================================================
// 学分常量：必须放在所有使用它的函数之前
// ============================================================================
// 学分上限：与云函数 courseService 的 MAX_CREDITS 保持一致。
// 数据库两列都是 numeric(4,2)，上限 99.99（B-004 迁移后）。
//
// ⚠️ Day 27 换了三次方案，最后定的是**两列都用 4,2**，不用"两列不同精度"：
//   既然 4,2 两列都能用，就别搞两套数字 —— 一个上限不可能对不上、不会记错。
//   （Day 27 先试 numeric(3,2)，装不下 categories 里已有的 42；改成 4,2 后两列通用。）
// 【为什么必须三处一致】前端、云函数、数据库各自的上限不同，
// 就会出现「前端过了、云函数过了、数据库拒了」这种用户完全没做错的报错。
//
// ⚠️ 这里的 const 必须定义在下面的 validateCategory / validateCourse **之前**。
// 修 B-004 时踩过一个坑：**`node --check` 查不出 const 的定义顺序问题**，
// 但运行时会报 ReferenceError。函数声明会提升，const 不会——
// 常量写在后面的话语法检查能过，页面一加载就崩。
// 这个坑是靠真跑一次浏览器发现的，不是靠语法检查。
// 教训：加新常量时，用真实浏览器跑一次，别只靠 node --check。
// 两列数据库上限都是 99.99。
//
// 但**应用层卡得比数据库更严**：课程学分上限 9.99（实际没有课超过 20 学分），
// 板块要求学分放到 99.99（线上有 42 的板块，必须放行）。
// 「应用比数据库严」是安全的 —— 反过来才会出现
// 「前端过了、云函数过了、数据库拒了」这种用户完全没做错的报错。
const MAX_CREDITS = 9.99;
const MAX_REQUIRED_CREDITS = 99.99;

// 超上限的文案（应用层上限，改数据库列类型时这里不必动）
const CREDIT_OVER_HINT = "学分不能超过 9.99（请检查是不是把课程代码或学号填进去了）";
const REQUIRED_CREDIT_OVER_HINT = "要求学分不能超过 99.99";


// 学分规划助手 —— 页面交互与计算逻辑
// Day 7：本机存储接入、板块管理（F1）、课程录入（F2）、缺口与 GPA（F3/F4）
// Day 8：主视图重组为四个板块（学分 / 课程 / 绩点 / 决策）、四种页面状态、
//         mock 示例数据（只填页面、不落盘）、决策板块的"建议优先选哪几门"
//
// 代码分三层：
//   1) 数据与计算层（不碰页面，可单独测试）
//   2) 渲染层（把数据画成四个板块）
//   3) 状态与事件层（四种页面状态、dev 工具、用户操作）

// ---------------------------------------------------------------------------
// 一、通用
// ---------------------------------------------------------------------------

function cloneData(data) {
  return {
    version: data.version,
    categories: data.categories.map(function (c) { return Object.assign({}, c); }),
    courses: data.courses.map(function (c) { return Object.assign({}, c); }),
    // plan 是培养方案信息（Day 26），没有就补 null
    plan: data.plan ? Object.assign({}, data.plan) : null
  };
}

function makeId() {
  return "id-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1000).toString(36);
}

function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  return String(Math.round(value * 100) / 100);
}

// ---------------------------------------------------------------------------
// 二、数据操作层 · 板块（F1）
// ---------------------------------------------------------------------------

function validateCategory(input) {
  const name = (input.name || "").trim();

  if (!name) {
    return { ok: false, error: "请填写板块名称。" };
  }
  if (name.length > 20) {
    return { ok: false, error: "板块名称请控制在 20 个字以内。" };
  }

  if (input.requiredCredits !== null && input.requiredCredits !== undefined) {
    const credits = input.requiredCredits;
    if (typeof credits !== "number" || isNaN(credits)) {
      return { ok: false, error: "要求学分请填数字（可留空）。" };
    }
    if (credits <= 0) {
      return { ok: false, error: "要求学分要大于 0；不确定就留空。" };
    }
    if (credits > MAX_REQUIRED_CREDITS) {
      return { ok: false, error: REQUIRED_CREDIT_OVER_HINT };
    }
    if (!isValidCreditStep(credits)) {
      return { ok: false, error: REQUIRED_CREDIT_STEP_HINT };
    }
  }

  if ((input.note || "").length > 100) {
    return { ok: false, error: "特殊条件备注请控制在 100 个字以内。" };
  }

  return { ok: true, error: "" };
}

function addCategory(data, input) {
  const check = validateCategory(input);
  if (!check.ok) {
    return { ok: false, data: data, error: check.error };
  }

  const next = cloneData(data);
  next.categories.push({
    id: makeId(),
    name: (input.name || "").trim(),
    requiredCredits: (input.requiredCredits === null || input.requiredCredits === undefined)
      ? null
      : input.requiredCredits,
    note: (input.note || "").trim()
  });

  return { ok: true, data: next, error: "" };
}

function updateCategory(data, id, input) {
  const check = validateCategory(input);
  if (!check.ok) {
    return { ok: false, data: data, error: check.error };
  }

  const next = cloneData(data);
  const target = next.categories.find(function (c) { return c.id === id; });
  if (!target) {
    return { ok: false, data: data, error: "没找到这个板块，可能已被删除。" };
  }

  target.name = (input.name || "").trim();
  target.requiredCredits = (input.requiredCredits === null || input.requiredCredits === undefined)
    ? null
    : input.requiredCredits;
  target.note = (input.note || "").trim();

  return { ok: true, data: next, error: "" };
}

function findCategoryCourses(data, id) {
  return data.courses.filter(function (c) { return c.categoryId === id; });
}

function removeCategory(data, id) {
  const next = cloneData(data);
  next.categories = next.categories.filter(function (c) { return c.id !== id; });
  next.courses.forEach(function (course) {
    if (course.categoryId === id) {
      course.categoryId = "";
    }
  });
  return { ok: true, data: next, error: "" };
}

// ---------------------------------------------------------------------------
// 三、数据操作层 · 课程（F2）
// ---------------------------------------------------------------------------

function isFailed(course) {
  return course.status === "done"
    && typeof course.score === "number"
    && course.score < 60;
}

function countsAsDoneCredits(course) {
  return course.status === "done" && !isFailed(course);
}

function validateCourse(input, data) {
  const name = (input.name || "").trim();

  if (!name) {
    return { ok: false, error: "请填写课程名称。" };
  }
  if (name.length > 30) {
    return { ok: false, error: "课程名称请控制在 30 个字以内。" };
  }

  const credits = input.credits;
  if (credits === null || credits === undefined || typeof credits !== "number" || isNaN(credits)) {
    return { ok: false, error: CREDIT_FILL_HINT };
  }
  if (credits <= 0) {
    return { ok: false, error: "学分要大于 0。" };
  }
  if (credits > MAX_CREDITS) {
    return { ok: false, error: CREDIT_OVER_HINT };
  }
  if (!isValidCreditStep(credits)) {
    return { ok: false, error: CREDIT_STEP_HINT };
  }

  if (!input.categoryId) {
    return { ok: false, error: "请选择所属板块。" };
  }
  const categoryExists = data.categories.some(function (c) { return c.id === input.categoryId; });
  if (!categoryExists) {
    return { ok: false, error: "所属板块不存在，请先到“学分板块”里创建。" };
  }

  if (input.status !== "done" && input.status !== "planned") {
    return { ok: false, error: "请选择课程状态（已修 / 计划修）。" };
  }

  const hasScore = input.score !== null && input.score !== undefined;
  if (hasScore) {
    if (input.status === "planned") {
      return { ok: false, error: "计划修的课程先不用填成绩。" };
    }
    if (typeof input.score !== "number" || isNaN(input.score)) {
      return { ok: false, error: "成绩请填数字（可留空）。" };
    }
    if (input.score < 0 || input.score > 100) {
      return { ok: false, error: "成绩需在 0–100 之间。" };
    }
    if (Math.round(input.score) !== input.score) {
      return { ok: false, error: "成绩请填整数。" };
    }
  }

  return { ok: true, error: "" };
}

// ---------------------------------------------------------------------------
// 学分粒度：0.25 的整数倍
// ---------------------------------------------------------------------------
// 【为什么从 0.5 放宽到 0.25】（Day 26）
// 原来只允许 0.5 的整数倍，是当初为了防止输错设的。
// 但实测真实的 2025 版培养方案里，「形势与政策」这类课就是 0.25 学分/学期，
// 共 8 门。按原来的规则，这 8 门课一节都导不进来，用户还得逐个手动改学分 ——
// 本来是「自动导入」，结果变成了「自动导入 + 手工修补」，违背了这个功能的意义。
// 所以放宽到 0.25，取「四分之一学分」这个粒度，够用且仍能挡住误输入（如 1.3）。
//
// 四处校验（板块要求、课程学分、实时提示 ×2）统一走这里，
// 免得改一处漏一处 —— 这是之前维护校验文案时踩过的坑。
//
// 【为什么不能用 Math.round(value * 4) === value * 4】（Day 26 修B-001 时发现）
// IEEE 754 里 999.9 实际存的是 999.89999999999997726…，
// 乘 4 得 3999.599999999999909，不等于 4000 —— 于是 **9.99 这个合法的学分值会被误拒**。
// 同样地 1.005 会被误收（1.005*4 恰好等于 4.02，取整后 4 ≠ 4.02，
// 但 1.005 这种"看起来是两位小数"的值本身就不该通过）。
//
// 可靠做法：先转成"百分位整数"再判断，全程整数运算，绕开浮点误差。
// 之所以还要限制"最多两位小数"，是因为 0.1+0.2 = 0.30000000000000004 这种值
// 取整后是 30，30 % 25 ≠ 0 会被拒——但如果只判断"是不是 25 的倍数"，
// 某些浮点误差恰好能被整除，反而把明显错误的值放进来了。
function isValidCreditStep(value) {
  if (typeof value !== "number" || !isFinite(value)) return false;
  // 最多两位小数：把数值转成字符串看小数位数
  const text = String(value);
  const dot = text.indexOf(".");
  if (dot !== -1 && text.length - dot - 1 > 2) return false;
  const cents = Math.round(value * 100);
  return cents % 25 === 0;
}

const CREDIT_STEP_HINT = "学分需为 0.25 的整数倍（如 0.25 / 0.5 / 1.5 / 3）";
const REQUIRED_CREDIT_STEP_HINT = "要求学分需为 0.25 的整数倍（如 0.25 / 1.5 / 12）";
const CREDIT_FILL_HINT = "请填写学分（可填 0.25 的整数倍，如 3、1.5 或 0.25）";

// 字段级错误字典：只针对单个字段可即时判定的规则，返回 { 字段键: 错误文案 }
function liveErrorsCategory(input) {
  const errors = {};
  const name = (input.name || "").trim();
  if (!name) errors.name = "请填写板块名称。";
  else if (name.length > 20) errors.name = "板块名称请控制在 20 个字以内。";

  if (input.requiredCredits !== null && input.requiredCredits !== undefined) {
    const c = input.requiredCredits;
    if (typeof c !== "number" || isNaN(c)) errors.credits = "要求学分请填数字（可留空）。";
    else if (c <= 0) errors.credits = "要求学分要大于 0；不确定就留空。";
    // ↓ Day 27 补：这里原先漏了上限检查（提交校验有、实时提示没有），
    //   于是填 150 时输入框不报错，点提交才被拦 —— 两处反馈不一致。
    else if (c > MAX_REQUIRED_CREDITS) errors.credits = REQUIRED_CREDIT_OVER_HINT;
    else if (!isValidCreditStep(c)) errors.credits = REQUIRED_CREDIT_STEP_HINT;
  }

  if ((input.note || "").length > 100) errors.note = "特殊条件备注请控制在 100 个字以内。";
  return errors;
}

function liveErrorsCourse(input, data) {
  const errors = {};
  const name = (input.name || "").trim();
  if (!name) errors.name = "请填写课程名称。";
  else if (name.length > 30) errors.name = "课程名称请控制在 30 个字以内。";

  const credits = input.credits;
  if (credits === null || credits === undefined || typeof credits !== "number" || isNaN(credits)) {
    errors.credits = CREDIT_FILL_HINT;
  } else if (credits <= 0) {
    errors.credits = "学分要大于 0。";
  } else if (credits > MAX_CREDITS) {
    errors.credits = CREDIT_OVER_HINT;
  } else if (!isValidCreditStep(credits)) {
    errors.credits = CREDIT_STEP_HINT;
  }

  if (!input.categoryId) errors.categoryId = "请选择所属板块。";
  else {
    const exists = data.categories.some(function (c) { return c.id === input.categoryId; });
    if (!exists) errors.categoryId = "所属板块不存在，请先到“学分板块”里创建。";
  }

  if (input.status !== "done" && input.status !== "planned") {
    errors.status = "请选择课程状态（已修 / 计划修）。";
  }

  const hasScore = input.score !== null && input.score !== undefined;
  if (hasScore) {
    if (input.status === "planned") errors.score = "计划修的课程先不用填成绩。";
    else if (typeof input.score !== "number" || isNaN(input.score)) errors.score = "成绩请填数字（可留空）。";
    else if (input.score < 0 || input.score > 100) errors.score = "成绩需在 0–100 之间。";
    else if (Math.round(input.score) !== input.score) errors.score = "成绩请填整数。";
  }
  return errors;
}

// 记录每个表单的实时校验引用，供提交成功/失败时使用
const liveForms = {};

function setupLiveForm(cfg) {
  const form = document.getElementById(cfg.formId);
  if (!form) return;
  const errorEl = document.getElementById(cfg.errorId);
  const fieldEls = cfg.fields.map(function (f) { return document.getElementById(f.el); });

  function refresh() {
    const input = cfg.read();
    const errors = cfg.validate(input, state);
    let firstMsg = "";
    cfg.fields.forEach(function (f, i) {
      const el = fieldEls[i];
      const msg = errors[f.key];
      if (msg) {
        el.classList.add("invalid");
        el.setAttribute("aria-invalid", "true");
        if (!firstMsg) firstMsg = msg;
      } else {
        el.classList.remove("invalid");
        el.removeAttribute("aria-invalid");
      }
    });
    if (errorEl) {
      if (firstMsg) { errorEl.textContent = firstMsg; errorEl.hidden = false; }
      else { errorEl.textContent = ""; errorEl.hidden = true; }
    }
  }

  fieldEls.forEach(function (el) {
    if (!el) return;
    el.addEventListener("input", refresh);
    el.addEventListener("change", refresh);
  });

  liveForms[cfg.formId] = { refresh: refresh, errorEl: errorEl, fieldEls: fieldEls };
}

function attachLiveValidation() {
  setupLiveForm({
    formId: "category-form",
    errorId: "category-error",
    fields: [
      { el: "category-name", key: "name" },
      { el: "category-credits", key: "credits" },
      { el: "category-note", key: "note" }
    ],
    read: function () {
      const creditsRaw = document.getElementById("category-credits").value.trim();
      return {
        name: document.getElementById("category-name").value,
        requiredCredits: creditsRaw === "" ? null : Number(creditsRaw),
        note: document.getElementById("category-note").value
      };
    },
    validate: function (input) { return liveErrorsCategory(input); }
  });

  setupLiveForm({
    formId: "course-form",
    errorId: "course-error",
    fields: [
      { el: "course-name", key: "name" },
      { el: "course-credits", key: "credits" },
      { el: "course-category", key: "categoryId" },
      { el: "course-status", key: "status" },
      { el: "course-score", key: "score" }
    ],
    read: function () {
      const creditsRaw = document.getElementById("course-credits").value.trim();
      const scoreRaw = document.getElementById("course-score").value.trim();
      const status = document.getElementById("course-status").value;
      return {
        name: document.getElementById("course-name").value,
        credits: creditsRaw === "" ? null : Number(creditsRaw),
        categoryId: document.getElementById("course-category").value,
        status: status,
        score: (status === "done" && scoreRaw !== "") ? Number(scoreRaw) : null
      };
    },
    validate: function (input, data) { return liveErrorsCourse(input, data); }
  });
}

function refreshLiveForm(formId) {
  const f = liveForms[formId];
  if (f) f.refresh();
}

function clearLiveValidation(formId) {
  const f = liveForms[formId];
  if (!f) return;
  f.fieldEls.forEach(function (el) {
    if (el) { el.classList.remove("invalid"); el.removeAttribute("aria-invalid"); }
  });
  if (f.errorEl) { f.errorEl.textContent = ""; f.errorEl.hidden = true; }
}

function buildCourseRecord(input) {
  const hasScore = input.score !== null && input.score !== undefined;
  const term = input.term === null || input.term === undefined ? "" : String(input.term).trim();
  return {
    id: makeId(),
    name: (input.name || "").trim(),
    credits: input.credits,
    categoryId: input.categoryId,
    status: input.status,
    score: (input.status === "done" && hasScore) ? input.score : null,
    // 推荐修读学期（Day 26）：培养方案里写着「第5学期」这类信息。
    // 「凭记忆确认已修」的清单页靠它帮你回想时间线，所以必须存下来。
    // 手动录入的课没有这个值，留空字符串即可。
    term: term.slice(0, 20)
  };
}

function addCourse(data, input) {
  const check = validateCourse(input, data);
  if (!check.ok) {
    return { ok: false, data: data, error: check.error };
  }

  const next = cloneData(data);
  next.courses.push(buildCourseRecord(input));
  return { ok: true, data: next, error: "" };
}

function updateCourse(data, id, input) {
  const check = validateCourse(input, data);
  if (!check.ok) {
    return { ok: false, data: data, error: check.error };
  }

  const next = cloneData(data);
  const index = next.courses.findIndex(function (c) { return c.id === id; });
  if (index === -1) {
    return { ok: false, data: data, error: "没找到这门课程，可能已被删除。" };
  }

  const record = buildCourseRecord(input);
  record.id = id;
  next.courses[index] = record;

  return { ok: true, data: next, error: "" };
}

function removeCourse(data, id) {
  const next = cloneData(data);
  next.courses = next.courses.filter(function (c) { return c.id !== id; });
  return { ok: true, data: next, error: "" };
}

function categoryNameOf(data, categoryId) {
  const found = data.categories.find(function (c) { return c.id === categoryId; });
  return found ? found.name : "未归类";
}

// ---------------------------------------------------------------------------
// 四、计算层 · 板块缺口（F3）
// ---------------------------------------------------------------------------

function calcCategoryStats(data) {
  return data.categories.map(function (category) {
    const itsCourses = data.courses.filter(function (c) { return c.categoryId === category.id; });

    const doneCredits = itsCourses
      .filter(countsAsDoneCredits)
      .reduce(function (sum, c) { return sum + c.credits; }, 0);

    const plannedCourses = itsCourses.filter(function (c) { return c.status === "planned"; });

    const required = (category.requiredCredits === null || category.requiredCredits === undefined)
      ? null
      : category.requiredCredits;

    const gap = (required === null) ? null : Math.max(0, required - doneCredits);

    return {
      categoryId: category.id,
      name: category.name,
      note: category.note || "",
      requiredCredits: required,
      doneCredits: doneCredits,
      gap: gap,
      plannedCourses: plannedCourses
    };
  });
}

// 决策建议（Day 8）：缺口 > 0 时，从"计划修课程"里按学分从大到小挑，
// 算出"至少选几门可以补满缺口"。这是 PRD 后续待办第 5 条的算法，一期提前实现。
function buildRecommendation(stat) {
  if (stat.requiredCredits === null || stat.gap === null || stat.gap <= 0) {
    return null;
  }

  const candidates = stat.plannedCourses.slice().sort(function (a, b) {
    return b.credits - a.credits;
  });

  if (candidates.length === 0) {
    return { level: "none", picked: [], count: 0, sum: 0, enough: false, remaining: stat.gap };
  }

  let sum = 0;
  const picked = [];
  for (let i = 0; i < candidates.length; i++) {
    if (sum >= stat.gap) break;
    sum += candidates[i].credits;
    picked.push(candidates[i]);
  }

  const enough = sum >= stat.gap;

  return {
    level: enough ? "enough" : "short",
    picked: picked,
    count: picked.length,
    sum: sum,
    enough: enough,
    remaining: enough ? 0 : stat.gap - sum
  };
}

// ---------------------------------------------------------------------------
// 五、计算层 · 总分与 GPA（F4）
// ---------------------------------------------------------------------------

const GPA_RULES = {
  "4.0": [
    { min: 90, point: 4.0 }, { min: 85, point: 3.7 }, { min: 82, point: 3.3 },
    { min: 78, point: 3.0 }, { min: 75, point: 2.7 }, { min: 72, point: 2.3 },
    { min: 68, point: 2.0 }, { min: 64, point: 1.5 }, { min: 60, point: 1.0 },
    { min: 0, point: 0 }
  ],
  "5.0": [
    { min: 90, point: 5.0 }, { min: 80, point: 4.0 },
    { min: 70, point: 3.0 }, { min: 60, point: 2.0 }, { min: 0, point: 0 }
  ],
  "grade": [
    { min: 90, point: 4.0 }, { min: 80, point: 3.0 },
    { min: 70, point: 2.0 }, { min: 60, point: 1.0 }, { min: 0, point: 0 }
  ]
};

function gradePoint(score, ruleKey) {
  const table = GPA_RULES[ruleKey] || GPA_RULES["4.0"];
  for (let i = 0; i < table.length; i++) {
    if (score >= table[i].min) {
      return table[i].point;
    }
  }
  return 0;
}

function calcOverall(data, ruleKey) {
  const counted = data.courses.filter(countsAsDoneCredits);
  const totalCredits = counted.reduce(function (sum, c) { return sum + c.credits; }, 0);

  const withScore = counted.filter(function (c) { return typeof c.score === "number"; });
  const scoreCredits = withScore.reduce(function (sum, c) { return sum + c.credits; }, 0);

  const weightedAvg = scoreCredits > 0
    ? withScore.reduce(function (sum, c) { return sum + c.score * c.credits; }, 0) / scoreCredits
    : null;

  const gpa = scoreCredits > 0
    ? withScore.reduce(function (sum, c) { return sum + gradePoint(c.score, ruleKey) * c.credits; }, 0) / scoreCredits
    : null;

  return {
    totalCredits: totalCredits,
    weightedAvg: weightedAvg,
    gpa: gpa,
    countedCourses: counted.length,
    failedCourses: data.courses.filter(isFailed).length
  };
}

// ---------------------------------------------------------------------------
// 六、示例数据（mock：只填在页面里，不写本机存储）
// ---------------------------------------------------------------------------

const MOCK_DATA = {
  version: 1,
  categories: [
    { id: "mock-c1", name: "专业必修", requiredCredits: 40, note: "" },
    { id: "mock-c2", name: "专业选修", requiredCredits: 6, note: "" },
    { id: "mock-c3", name: "通识选修", requiredCredits: 12, note: "须含 2 学分艺术类" }
  ],
  courses: [
    { id: "mock-k1", name: "高等数学", credits: 5, categoryId: "mock-c1", status: "done", score: 88 },
    { id: "mock-k2", name: "大学英语", credits: 3, categoryId: "mock-c1", status: "done", score: 58 },
    { id: "mock-k3", name: "大学物理", credits: 4, categoryId: "mock-c1", status: "done", score: 76 },
    { id: "mock-k4", name: "数据库原理", credits: 3, categoryId: "mock-c2", status: "planned", score: null },
    { id: "mock-k5", name: "算法设计", credits: 3, categoryId: "mock-c2", status: "planned", score: null },
    { id: "mock-k6", name: "音乐鉴赏", credits: 2, categoryId: "mock-c3", status: "planned", score: null }
  ]
};

// 示例数据 2 · 天文学专业（Day 10 追加，Day 25 之后按 PDF 原图重建）
// 依据 2025 版培养方案（scripts/pdf-page-image.js 渲染第 4~9 页逐行核对）：
//   通识必修（一）38 / 通识必修（二）3.5 / 通识选修 8 / 新生研讨 2
//   学科基础 36 / 专业核心 27 / 专业选修 18 / 综合实践 14 / 个性发展（留空）
// 98 门课程（+2 门用于测未归类课程的处理）。
//
// 【两处修正】原 92 门是 Day 10 手工整理的，核对 PDF 原图后发现学分录错：
//   量子力学A 1.5→4、高等数学A（1）(2) 3→5、理论力学 4→3、热力学与统计物理 4→3、
//   天体物理导论（1）3→4、实测天体物理 4→3、线性代数A 4→3、概率论与数理统计 4→3、
//   星系宇宙学 3→2、天体辐射机制 2→3、数学物理方法 3→4 等；
//   形势与政策原来只有 4 门，实际有 8 门（每门 0.25）。
//
// 【注意】「要求学分」是「至少要修够多少」，不是该组所有课的总学分。
// 培养方案列的是「所有可以修的课」，学生只挑一部分，
// 所以各组学分合计超过要求学分是正常的，不是数据错误。
//
// 同一门课只录一条，板块取主要归属，不重复。
const MOCK_DATA_2 = {
  version: 1,
  categories: [
    { id: "g1", name: "通识必修（一）", requiredCredits: 38, note: "" },
    { id: "g2", name: "通识必修（二）", requiredCredits: 3.5, note: "" },
    { id: "g3", name: "通识选修", requiredCredits: 8, note: "建议含美育类 2 学分" },
    { id: "g4", name: "新生研讨", requiredCredits: 2, note: "" },
    { id: "m1", name: "学科基础", requiredCredits: 36, note: "" },
    { id: "m2", name: "专业核心", requiredCredits: 27, note: "" },
    { id: "m3", name: "专业选修", requiredCredits: 18, note: "" },
    { id: "m4", name: "综合实践", requiredCredits: 14, note: "" },
    { id: "x1", name: "个性发展（要求待定）", requiredCredits: null, note: "" }
  ],
  courses: [
    { id: "m2-0", name: "思想道德与法治", credits: 2.5, categoryId: "g1", status: "done", score: 62 },
    { id: "m2-1", name: "马克思主义基本原理", credits: 2.5, categoryId: "g1", status: "done", score: 69 },
    { id: "m2-2", name: "中国近现代史纲要", credits: 2.5, categoryId: "g1", status: "done", score: 55 },
    { id: "m2-3", name: "毛泽东思想基本原理", credits: 2.5, categoryId: "g1", status: "done", score: 83 },
    { id: "m2-4", name: "习近平新时代中国特色社会主义思想概论", credits: 3, categoryId: "g1", status: "done", score: 90 },
    { id: "m2-5", name: "中华民族共同体概论", credits: 2, categoryId: "g1", status: "done", score: 66 },
    { id: "m2-6", name: "新中国史", credits: 1, categoryId: "g1", status: "done", score: 73 },
    { id: "m2-7", name: "党史", credits: 1, categoryId: "g1", status: "done", score: 80 },
    { id: "m2-8", name: "社会主义发展史", credits: 1, categoryId: "g1", status: "done", score: 87 },
    { id: "m2-9", name: "军事理论", credits: 2, categoryId: "g1", status: "done", score: 63 },
    { id: "m2-10", name: "军事技能训练", credits: 2, categoryId: "g1", status: "done", score: 70 },
    { id: "m2-11", name: "大学生心理健康教育", credits: 1, categoryId: "g1", status: "done", score: 77 },
    { id: "m2-12", name: "大学生心理健康教育实践", credits: 1, categoryId: "g1", status: "done", score: 84 },
    { id: "m2-13", name: "思政实践", credits: 2, categoryId: "g1", status: "done", score: 91 },
    { id: "m2-14", name: "国家安全教育", credits: 1, categoryId: "g1", status: "done", score: 67 },
    { id: "m2-15", name: "大学英语听说（1）", credits: 1, categoryId: "g1", status: "done", score: 74 },
    { id: "m2-16", name: "大学英语听说（2）", credits: 1, categoryId: "g1", status: "done", score: 81 },
    { id: "m2-17", name: "大学英语听说（3）", credits: 1, categoryId: "g1", status: "done", score: 88 },
    { id: "m2-18", name: "大学英语读写（1）", credits: 1, categoryId: "g1", status: "done", score: 64 },
    { id: "m2-19", name: "大学英语读写（2）", credits: 1, categoryId: "g1", status: "done", score: 71 },
    { id: "m2-20", name: "大学英语读写（3）", credits: 1, categoryId: "g1", status: "done", score: 78 },
    { id: "m2-21", name: "大学英语读写（4）", credits: 1, categoryId: "g1", status: "done", score: 95 },
    { id: "m2-22", name: "通用学术英语听说", credits: 1, categoryId: "g1", status: "done", score: 92 },
    { id: "m2-23", name: "通用学术英语读写", credits: 1, categoryId: "g1", status: "done", score: 68 },
    { id: "m2-24", name: "高级英语（口译）", credits: 1, categoryId: "g1", status: "done", score: 75 },
    { id: "m2-25", name: "高级英语（笔译）", credits: 1, categoryId: "g1", status: "done", score: 82 },
    { id: "m2-26", name: "英语文学赏析", credits: 1, categoryId: "g1", status: "done", score: 93 },
    { id: "m2-27", name: "旅游文化交流英语", credits: 1, categoryId: "g1", status: "done", score: 95 },
    { id: "m2-28", name: "体育（1）", credits: 1, categoryId: "g1", status: "done", score: 94 },
    { id: "m2-29", name: "体育（2）", credits: 1, categoryId: "g1", status: "done", score: 79 },
    { id: "m2-30", name: "体育（3）", credits: 1, categoryId: "g1", status: "done", score: 86 },
    { id: "m2-31", name: "体育（4）", credits: 1, categoryId: "g1", status: "done", score: 62 },
    { id: "m2-32", name: "形势与政策（1）", credits: 0.25, categoryId: "g1", status: "done", score: 69 },
    { id: "m2-33", name: "形势与政策（2）", credits: 0.25, categoryId: "g1", status: "done", score: 76 },
    { id: "m2-34", name: "形势与政策（3）", credits: 0.25, categoryId: "g1", status: "done", score: 83 },
    { id: "m2-35", name: "形势与政策（4）", credits: 0.25, categoryId: "g1", status: "done", score: 90 },
    { id: "m2-36", name: "形势与政策（5）", credits: 0.25, categoryId: "g1", status: "done", score: 66 },
    { id: "m2-37", name: "形势与政策（6）", credits: 0.25, categoryId: "g1", status: "done", score: 73 },
    { id: "m2-38", name: "形势与政策（7）", credits: 0.25, categoryId: "g1", status: "done", score: 80 },
    { id: "m2-39", name: "形势与政策（8）", credits: 0.25, categoryId: "g1", status: "done", score: 87 },
    { id: "m2-40", name: "中文写作", credits: 1, categoryId: "g2", status: "done", score: 62 },
    { id: "m2-41", name: "悦读计划", credits: 1, categoryId: "g2", status: "done", score: 69 },
    { id: "m2-42", name: "大学生创新创业教育", credits: 2, categoryId: "g2", status: "done", score: 76 },
    { id: "m2-43", name: "人工智能通识（理工农医类）", credits: 1.5, categoryId: "g2", status: "done", score: 83 },
    { id: "m2-44", name: "人工智能通识集中实践（理工农医类）", credits: 1, categoryId: "g2", status: "done", score: 90 },
    { id: "m2-45", name: "新生研讨与职业生涯规划", credits: 1, categoryId: "g4", status: "done", score: 62 },
    { id: "m2-46", name: "线性代数A", credits: 3, categoryId: "m1", status: "done", score: 62 },
    { id: "m2-47", name: "高等数学A（1）", credits: 5, categoryId: "m1", status: "done", score: 50 },
    { id: "m2-48", name: "高等数学A（2）", credits: 5, categoryId: "m1", status: "done", score: 76 },
    { id: "m2-49", name: "AI与天文数据分析", credits: 2, categoryId: "m1", status: "done", score: 83 },
    { id: "m2-50", name: "大学物理A：力学", credits: 3, categoryId: "m1", status: "done", score: 90 },
    { id: "m2-51", name: "大学物理A：热学", credits: 3, categoryId: "m1", status: "done", score: 66 },
    { id: "m2-52", name: "大学物理A：光学", credits: 3, categoryId: "m1", status: "done", score: 73 },
    { id: "m2-53", name: "大学物理A：电磁学", credits: 4, categoryId: "m1", status: "done", score: 80 },
    { id: "m2-54", name: "大学物理A：原子物理学", credits: 3, categoryId: "m1", status: "done", score: 87 },
    { id: "m2-55", name: "概率论与数理统计B", credits: 3, categoryId: "m1", status: "done", score: 63 },
    { id: "m2-56", name: "天体辐射机制", credits: 3, categoryId: "m1", status: "done", score: 70 },
    { id: "m2-57", name: "天体物理前沿专题讲座", credits: 2, categoryId: "m1", status: "done", score: 77 },
    { id: "m2-58", name: "星系宇宙学", credits: 2, categoryId: "m1", status: "planned", score: null },
    { id: "m2-59", name: "量子力学综合训练", credits: 2, categoryId: "m1", status: "planned", score: null },
    { id: "m2-60", name: "普通物理综合训练", credits: 2, categoryId: "m1", status: "planned", score: null },
    { id: "m2-61", name: "电动力学综合训练", credits: 2, categoryId: "m1", status: "planned", score: null },
    { id: "m2-62", name: "等离子体天体物理", credits: 2, categoryId: "m1", status: "planned", score: null },
    { id: "m2-63", name: "量子力学A", credits: 4, categoryId: "m2", status: "done", score: 62 },
    { id: "m2-64", name: "电动力学", credits: 4, categoryId: "m2", status: "done", score: 69 },
    { id: "m2-65", name: "数学物理方法", credits: 4, categoryId: "m2", status: "done", score: 76 },
    { id: "m2-66", name: "理论力学", credits: 3, categoryId: "m2", status: "done", score: 83 },
    { id: "m2-67", name: "热力学与统计物理", credits: 3, categoryId: "m2", status: "done", score: 90 },
    { id: "m2-68", name: "天体物理导论（1）", credits: 3, categoryId: "m2", status: "done", score: 66 },
    { id: "m2-69", name: "实测天体物理", credits: 3, categoryId: "m2", status: "planned", score: null },
    { id: "m2-70", name: "天体物理导论（2）", credits: 3, categoryId: "m2", status: "planned", score: null },
    { id: "m2-71", name: "广义相对论基础", credits: 3, categoryId: "m3", status: "done", score: 62 },
    { id: "m2-72", name: "高能天体物理", credits: 2, categoryId: "m3", status: "done", score: 69 },
    { id: "m2-73", name: "天体力学基础", credits: 3, categoryId: "m3", status: "done", score: 76 },
    { id: "m2-74", name: "天体光谱学", credits: 2, categoryId: "m3", status: "done", score: 83 },
    { id: "m2-75", name: "射电天文学", credits: 3, categoryId: "m3", status: "done", score: 90 },
    { id: "m2-76", name: "专业英语", credits: 2, categoryId: "m3", status: "done", score: 66 },
    { id: "m2-77", name: "光电子技术实验", credits: 1, categoryId: "m3", status: "done", score: 73 },
    { id: "m2-78", name: "普通天文学实习", credits: 1, categoryId: "m3", status: "done", score: 80 },
    { id: "m2-79", name: "普通天文学（1）", credits: 3, categoryId: "m3", status: "planned", score: null },
    { id: "m2-80", name: "普通天文学（2）", credits: 3, categoryId: "m3", status: "planned", score: null },
    { id: "m2-81", name: "星系天文学", credits: 3, categoryId: "m3", status: "planned", score: null },
    { id: "m2-82", name: "恒星结构与演化", credits: 3, categoryId: "m3", status: "planned", score: null },
    { id: "m2-83", name: "高能天体物理数据处理实验", credits: 1, categoryId: "m3", status: "planned", score: null },
    { id: "m2-84", name: "计算物理实验", credits: 1, categoryId: "m3", status: "planned", score: null },
    { id: "m2-85", name: "计算物理", credits: 2, categoryId: "m3", status: "planned", score: null },
    { id: "m2-86", name: "光电子学基础", credits: 2, categoryId: "m3", status: "planned", score: null },
    { id: "m2-87", name: "理论天体物理", credits: 3, categoryId: "m3", status: "planned", score: null },
    { id: "m2-88", name: "毕业实习与社会调查", credits: 2, categoryId: "m4", status: "done", score: 62 },
    { id: "m2-89", name: "实测天体物理实习", credits: 1, categoryId: "m4", status: "done", score: 69 },
    { id: "m2-90", name: "科研训练", credits: 2, categoryId: "m4", status: "done", score: 76 },
    { id: "m2-91", name: "毕业论文（设计）", credits: 4, categoryId: "m4", status: "done", score: 83 },
    { id: "m2-92", name: "创新能力提升与就业指导", credits: 1, categoryId: "m4", status: "done", score: 90 },
    { id: "m2-93", name: "大学物理实验A（1）", credits: 2, categoryId: "m4", status: "done", score: 66 },
    { id: "m2-94", name: "大学物理实验A（2）", credits: 2, categoryId: "m4", status: "done", score: 73 },
    { id: "m2-95", name: "大学物理实验A（3）", credits: 2, categoryId: "m4", status: "planned", score: null },
    { id: "m2-96", name: "近代物理实验（1）", credits: 2, categoryId: "m4", status: "planned", score: null },
    { id: "m2-97", name: "近代物理实验（2）", credits: 2, categoryId: "m4", status: "planned", score: null },
    { id: "m2-98", name: "通识类讲座（原板块已删除）", credits: 1, categoryId: "", status: "done", score: 82 },
    { id: "m2-99", name: "跨院系研讨课（原板块已删除）", credits: 2, categoryId: "", status: "done", score: 74 }

  ]
};

// ---------------------------------------------------------------------------
// 七、渲染层
// ---------------------------------------------------------------------------

let state = null;
let editingId = null;
let editingCourseId = null;
let gapStats = [];
let gpaRule = "4.0";
let mockMode = false;
let lastAddedId = null;   // 刚刚新增的那一条，用来在列表里高亮一下（Day 11）
let pendingDelete = null;       // 软删除待撤销：{ kind, id, item, index, name, timer, removed }
let simulateDeleteFail = false; // 开发者开关：模拟删除提交失败，用于测试错误提示
let courseFilter = { keyword: "", categoryId: "", status: "" }; // 课程列表筛选（Day 12，只影响显示不改数据）
let expandedCourseGroups = {};  // 课程列表按板块分组的展开状态（Day 14·同伴反馈：长列表要折叠）

// ---------------------------------------------------------------------------
// 批量选择（Day 28）
//
// 【为什么用 Set 而不是数组】
// 勾选/取消是高频操作，Set 的 has/add/delete 都是常数时间；
// 数组在 100 门规模时 splice 的开销虽然可忽略，但语义上也更容易写错
//（比如「选中的顺序」到底按勾选顺序还是按列表顺序）。
//
// 【为什么不存localStorage】
// 勾选是「马上要做一件事」的中间状态，不是要长期保存的东西。
// 刷新后清空是多数工具（邮箱、文件管理器）的做法。
//
// 【为什么用 id 集合而不是 DOM 引用】
// 列表会重渲染（renderAll），DOM 引用会失效；id 是数据层的稳定标识。
// ---------------------------------------------------------------------------
const selectedCourseIds = new Set();

function toggleCourseSelect(id, on) {
  if (on) selectedCourseIds.add(id);
  else selectedCourseIds.delete(id);
}

function clearCourseSelection() {
  selectedCourseIds.clear();
}

function selectedCourses() {
  // 按列表顺序返回，而不是 Set 的插入顺序 —— 用户看到的就是列表顺序
  return state.courses.filter(function (c) { return selectedCourseIds.has(c.id); });
}

// ---------------------------------------------------------------------------
// 批量工具栏（Day 28）
// ---------------------------------------------------------------------------

function renderBulkBar() {
  const bar = document.getElementById("bulk-bar");
  if (!bar) return;

  // 课程被删光之后，已选的 id 可能已经不存在了，顺手清掉
  // （不然批量删除会拿着不存在的 id 去操作）
  const alive = new Set(state.courses.map(function (c) { return c.id; }));
  Array.from(selectedCourseIds).forEach(function (id) {
    if (!alive.has(id)) selectedCourseIds.delete(id);
  });

  const n = selectedCourseIds.size;
  // 有课程就显示工具栏（哪怕还没勾选 —— 让用户知道「这里能批量操作」）
  // 没课程时隐藏（选它没意义），示例数据模式下隐藏（删除本就禁用）
  if (state.courses.length === 0 || mockMode) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  // ⚠️ Day 28：光写「已选 N 门」会让人以为选漏了。
  // 列表按板块分组且**默认折叠**，折叠分组里的课**根本没渲染出来**，
  // 屏幕上根本看不到那些勾选框 —— 但它们确实被选中了。
  // 用户会数一遍看得见的勾选框，发现比 N 少，就以为「全选坏了」
  // （实测就出现过「全选只选到 91 门 / 96 门」这种报告）。
  //
// ⚠️ 第二版修正：第一版用 filterCourses 算隐藏数（错的，那是筛选不是折叠），
//   改成遍历 expandedCourseGroups 的键 —— 也是错的：
//   没手动展开过的分组**键根本不存在**（1942 行 isOpen = !!expandedCourseGroups[catId]），
//   Object.keys 拿到空对象，于是提示永远不出现。
  // 正确做法：直接问「这个分组合起来了吗」，跟 1942 行用同一个判据。
  const visible = filterCourses(state.courses, courseFilter);
  let collapsedSelected = 0;
  visible.forEach(function (c) {
    if (selectedCourseIds.has(c.id) && !expandedCourseGroups[c.categoryId || ""]) {
      collapsedSelected++;
    }
  });

  const count = document.getElementById("bulk-count");
  if (count) {
    count.textContent = "已选 " + n + " 门" +
      (collapsedSelected > 0 ? "（其中 " + collapsedSelected + " 门在折叠的分组里）" : "");
  }

  // 全选勾：当前**可见**的课全部选中才算勾上
  const allBox = document.getElementById("bulk-all");
  const allLabel = document.getElementById("bulk-all-label");
  if (allBox) {
    const allSelected = visible.length > 0 && visible.every(function (c) { return selectedCourseIds.has(c.id); });
    allBox.checked = allSelected;
    allBox.indeterminate = !allSelected && visible.some(function (c) { return selectedCourseIds.has(c.id); });
  }
  if (allLabel) {
    const allSelected = visible.length > 0 && visible.every(function (c) { return selectedCourseIds.has(c.id); });
  allLabel.textContent = allSelected ? "取消全选" : "全选";
  }

  // 目标板块下拉
  const sel = document.getElementById("bulk-category");
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "（选板块）";
    sel.appendChild(none);
    state.categories.forEach(function (c) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.name;
      sel.appendChild(o);
    });
    sel.value = cur;
  }

  // 没选中时，归类/删除按钮不可用（避免空操作）
  ["bulk-assign-btn", "bulk-delete-btn"].forEach(function (id) {
    const btn = document.getElementById(id);
    if (btn) btn.disabled = n === 0;
  });
}

// 批量归类：把选中的课移到目标板块
function bulkAssignCategory() {
  const sel = document.getElementById("bulk-category");
  if (!sel || !sel.value) return;
  const targetId = sel.value;
  if (!state.categories.some(function (c) { return c.id === targetId; })) return;

  const items = selectedCourses();
  if (items.length === 0) return;

  let moved = 0;
  state.courses.forEach(function (c) {
    if (selectedCourseIds.has(c.id) && c.categoryId !== targetId) {
      c.categoryId = targetId;
      c.updatedAt = new Date().toISOString();
      moved++;
    }
  });

  clearCourseSelection();
  renderAll();
  persist();   // ⚠️ 漏了这条就只改了内存，刷新后归类全丢（实测踩过）
  const name = categoryNameOf(state, targetId);
  // 用页面已有的 #course-feedback 显示结果（跟「✓ 已添加课程」同一个位置），
  // 不要自己造 toast —— 本项目没有 toast 函数，凭空调一个会在运行时崩。
  const fb = document.getElementById("course-feedback");
  if (fb) {
    fb.textContent = "✓ 已把 " + moved + " 门课归到《" + name + "》";
    fb.hidden = false;
  }
}

// 批量删除：删之前存快照，撤销一次全部恢复
//
// 【为什么快照而不是逐条走现有的 pendingDelete】
// 现有机制 pendingDelete 只记一条，撤销只能恢复最后那门。
// 删 1 门时够用，删 100 门时**撤销只能救回 1 门**，太危险。
//
// 【快照存什么】
// [{ id, item, index }] —— item 是删除前的完整对象（含成绩、状态），
// index 是它当时在数组里的位置，恢复后顺序不变。
function bulkDeleteCourses() {
  if (mockMode) return;
  const items = selectedCourses();
  if (items.length === 0) return;

  const snapshot = items.map(function (c) {
    return {
      id: c.id,
      item: c,
      index: state.courses.findIndex(function (x) { return x.id === c.id; }),
    };
  });

  // 先给卡片加删除中的动效
  snapshot.forEach(function (sn) {
    const card = document.querySelector('.course-card[data-id="' + sn.id + '"]');
    if (card) card.classList.add("removing");
  });

  window.setTimeout(function () {
    // 真的从内存里删（此时**还没写盘** —— 与单条删除同一套时序：
    // 撤销窗口内不落盘，超时才 saveData，保存失败还能原样恢复）
    state.courses = state.courses.filter(function (c) { return !selectedCourseIds.has(c.id); });

    if (bulkPending) commitBulkDelete();
    bulkPending = { snapshot: snapshot, timer: null };

    clearCourseSelection();
 renderAll();
    showBulkUndoToast(snapshot.length, bulkPending);
  }, 260);
}

// 恢复批量删除
function undoBulkDelete() {
  const bp = bulkPending;
  if (!bp) return;
  if (bp.timer) { window.clearTimeout(bp.timer); bp.timer = null; }

  // 按 index 从大到小插回去，避免打乱既有顺序
  bp.snapshot.slice().sort(function (a, b) { return b.index - a.index; })
    .forEach(function (sn) {
      state.courses.splice(Math.min(sn.index, state.courses.length), 0, sn.item);
      // 恢复后要让这门的分组展开，否则用户看不到刚恢复的东西
      expandedCourseGroups[sn.item.categoryId || ""] = true;
    });

  bulkPending = null;
  hideUndoToast();
  renderAll();
}

function commitBulkDelete() {
  // 撤销窗口到了 —— 这时才真正写盘（与单条删除 commitSave 同一套时序）
  const bp = bulkPending;
  if (!bp) return;
  if (bp.timer) { window.clearTimeout(bp.timer); bp.timer = null; }
  bulkPending = null;

  const result = CreditPlanner.saveData(state);
  if (!result.ok) {
    // 写盘失败：把删掉的课原样放回去，不能让用户数据凭空消失
    bp.snapshot.slice().sort(function (a, b) { return b.index - a.index; })
      .forEach(function (sn) {
        state.courses.splice(Math.min(sn.index, state.courses.length), 0, sn.item);
      });
    renderAll();
    showUndoError("删除未能保存到本机，已为你恢复。");
  }
}

let bulkPending = null;   // 批量删除待撤销：{ snapshot: [{id,item,index}], timer }

function showBulkUndoToast(count, bp) {
  const toastEl = document.getElementById("undo-toast");
  const text = document.getElementById("undo-text");
  if (!toastEl || !text) return;
  text.textContent = "已删除 " + count + " 门课";
  toastEl.hidden = false;
  void toastEl.offsetWidth;
  toastEl.classList.add("is-visible");

  const progress = document.getElementById("undo-progress");
  if (progress) {
    progress.style.transition = "none";
    progress.style.width = "100%";
    void progress.offsetWidth;
    progress.style.transition = "width 10s linear";   // 批量删给 10 秒（单条是 5 秒）
    progress.style.width = "0%";
  }

  bp.timer = window.setTimeout(function () {
    if (bulkPending === bp) commitBulkDelete();
    hideUndoToast();
  }, 10000);
}
let expandedOverviewRows = {};  // 决策板块每行的说明展开状态（Day 14·同伴反馈：说明文字可折叠）

function showError(boxId, message) {
  const box = document.getElementById(boxId);
  if (!box) return;
  if (message) {
    box.textContent = message;
    box.hidden = false;
  } else {
    box.textContent = "";
    box.hidden = true;
  }
}

function showGlobalError(message) {
  const box = document.getElementById("global-error");
  if (!box) return;
  box.textContent = message;
  box.hidden = false;
}

function hideGlobalError() {
  const box = document.getElementById("global-error");
  if (!box) return;
  box.textContent = "";
  box.hidden = true;
}

// 操作反馈：在表单下方显示一条短暂提示（成功绿 / 失败红），1.8 秒后自动收起
// 放在表单下方而不是页面顶部，因为此刻用户的眼睛就在表单上
function showFeedback(boxId, message, ok) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.textContent = message;
  box.className = "form-feedback " + (ok ? "is-ok" : "is-fail");
  box.hidden = false;

  window.setTimeout(function () {
    box.hidden = true;
  }, 1800);
}

// 提交时先进入"处理中"：按钮禁用并改文案，防止连点重复提交
// work() 返回 { ok, message, feedbackId }，结束后恢复按钮并给出提示
function runSubmit(button, idleText, work) {
  if (button.disabled) return;          // 已经在处理中，忽略后续点击
  button.disabled = true;
  button.textContent = "添加中…";

  // 本机存储写入是瞬时的，留一点点时间让"处理中"这个状态真的能被看到
  window.setTimeout(function () {
    const outcome = work();
    button.disabled = false;
    button.textContent = idleText;

    // 成功才有"一闪而过"的提示；失败时保留表单下方那条常驻红字，
    // 因为用户要照着它改，一闪就没了反而不好（避免两条红字重复出现）
    if (outcome.ok) {
      showFeedback(outcome.feedbackId, outcome.message, true);
    }
  }, 180);
}

function persist() {
  const result = CreditPlanner.saveData(state);
  if (!result.ok) {
    showGlobalError(result.message);
  }
}

// ---------------------------------------------------------------------------
// 软删除 + 5 秒撤销（赏心悦目版）
// 思路：点删除先播退出动画，再从内存移除并刷新页面，底部弹出撤销条；
// 5 秒内点“撤销”可完整恢复；超时则真正保存；保存失败会自动恢复并提示。
// ---------------------------------------------------------------------------

function findItem(kind, id) {
  if (kind === "course") return state.courses.find(function (c) { return c.id === id; });
  return state.categories.find(function (c) { return c.id === id; });
}

function removeItem(kind, id) {
  if (kind === "course") state = removeCourse(state, id).data;
  else state = removeCategory(state, id).data;
}

function insertItem(kind, item, index) {
  if (kind === "course") state.courses.splice(Math.min(index, state.courses.length), 0, item);
  else state.categories.splice(Math.min(index, state.categories.length), 0, item);
}

function showUndoToast(pd) {
  const toast = document.getElementById("undo-toast");
  const text = document.getElementById("undo-text");
  if (!toast || !text) return;
  text.textContent = "已删除《" + pd.name + "》";
  toast.hidden = false;
  void toast.offsetWidth;            // 强制重排，过渡才会播放
  toast.classList.add("is-visible");

  const progress = document.getElementById("undo-progress");
  if (progress) {
    progress.style.transition = "none";
    progress.style.width = "100%";
    void progress.offsetWidth;
    progress.style.transition = "width 5s linear";
    progress.style.width = "0%";
  }

  pd.timer = window.setTimeout(function () { commitPending(false); }, 5000);
}

function hideUndoToast() {
  const toast = document.getElementById("undo-toast");
  if (!toast) return;
  toast.classList.remove("is-visible");
  const progress = document.getElementById("undo-progress");
  if (progress) progress.style.transition = "none";
  window.setTimeout(function () {
    if (!toast.classList.contains("is-visible")) toast.hidden = true;
  }, 280);
}

function showUndoError(message) {
  const toast = document.getElementById("undo-toast");
  const text = document.getElementById("undo-text");
  if (!toast || !text) return;
  text.textContent = message;
  toast.hidden = false;
  void toast.offsetWidth;
  toast.classList.add("is-visible", "is-error");
  window.setTimeout(function () {
    toast.classList.remove("is-visible", "is-error");
    window.setTimeout(function () { toast.hidden = true; }, 280);
  }, 2600);
}

function commitSave(pd) {
  const result = CreditPlanner.saveData(state);
  if (!result.ok) {
    insertItem(pd.kind, pd.item, pd.index);   // 真实保存失败：恢复并提示
    renderAll();
    showUndoError("删除未能保存到本机，已为你恢复。");
    return false;
  }
  hideGlobalError();
  return true;
}

function commitPending(silent) {
  const pd = pendingDelete;
  if (!pd) return;
  if (pd.timer) { window.clearTimeout(pd.timer); pd.timer = null; }
  if (!pd.removed) { removeItem(pd.kind, pd.id); pd.removed = true; }
  hideUndoToast();
  pendingDelete = null;

  // 模拟失败（仅自然超时触发，第二次删除的 silent 提交不走这里）
  if (!silent && simulateDeleteFail) {
    insertItem(pd.kind, pd.item, pd.index);
    renderAll();
    showUndoError("删除失败，已为你恢复，请稍后重试。");
    return;
  }
  commitSave(pd);
}

function undoDelete() {
  const pd = pendingDelete;
  if (!pd) return;
  if (pd.timer) { window.clearTimeout(pd.timer); pd.timer = null; }
  if (pd.kind === "course") expandedCourseGroups[pd.item.categoryId || ""] = true; // 恢复后要能看见
  insertItem(pd.kind, pd.item, pd.index);
  pendingDelete = null;
  hideUndoToast();
  renderAll();
}

function requestDelete(kind, id, cardEl) {
  if (mockMode) return;                  // 示例数据模式下删除按钮本就禁用，双保险
  if (pendingDelete) commitPending(true); // 已有待撤销的删除，先把上一个真正提交
  // 批量删除也有待撤销的 —— 单条删除前必须先把它提交掉，
  // 否则两套撤销窗口会互相覆盖（实测会丢掉批量的快照）
  if (bulkPending) commitBulkDelete();

  const item = findItem(kind, id);
  if (!item) return;
  const list = (kind === "course") ? state.courses : state.categories;
  const index = list.findIndex(function (x) { return x.id === id; });
  const pd = { kind: kind, id: id, item: item, index: index, name: item.name, timer: null, removed: false };
  pendingDelete = pd;

  if (cardEl) cardEl.classList.add("removing");

  window.setTimeout(function () {
    if (pendingDelete !== pd) return;     // 已被新的删除取代，不再弹撤销
    removeItem(kind, id);
    pd.removed = true;
    renderAll();
    showUndoToast(pd);
  }, 260);
}

// ---------------------------------------------------------------------------
// 视图路由与列表四种状态（Day 13）
// ---------------------------------------------------------------------------

let currentView = "dashboard";   // 当前显示的视图
let currentDetailId = "";        // 详情页对应的板块 id（#/category/<id>）
let listStateOverride = "";      // 开发者开关：强制列表呈现某状态（"" = 跟随真实数据）

const VIEW_MAP = {
  dashboard: { el: "view-dashboard", title: "概览", crumb: "首页 › 概览" },
  courses: { el: "view-courses", title: "课程管理", crumb: "首页 › 课程管理" },
  categories: { el: "view-categories", title: "学分板块", crumb: "首页 › 学分板块" },
  detail: { el: "view-category-detail", title: "板块详情", crumb: "首页 › 学分板块 › 板块详情" }
};

// 解析 #/xxx 或带参数的 #/category/<id>；地址栏没写或写错时，一律回概览
function parseHash() {
  const raw = (window.location.hash || "").replace(/^#\/?/, "").trim();
  const parts = raw.split("/").filter(function (p) { return p !== ""; });
  if (parts.length === 0) return { view: "dashboard", id: "" };

  const head = parts[0].toLowerCase();
  if ((head === "category" || head === "categories") && parts[1]) {
    return { view: "detail", id: parts[1] }; // id 保留原样，不做大小写转换
  }
  // 写了 #/category 却没带 id：退回板块列表，而不是把人扔回概览
  if (head === "category") return { view: "categories", id: "" };
  return { view: VIEW_MAP[head] ? head : "dashboard", id: "" };
}

function showView(target, opts) {
  const t = target || { view: "dashboard", id: "" };
  const withLoading = !!(opts && opts.loading);
  currentView = VIEW_MAP[t.view] ? t.view : "dashboard";
  currentDetailId = currentView === "detail" ? (t.id || "") : "";

  Object.keys(VIEW_MAP).forEach(function (k) {
    const el = document.getElementById(VIEW_MAP[k].el);
    if (el) el.hidden = (k !== currentView);
  });

  // 详情属于「板块」这一支，导航高亮仍落在「板块」上
  const navKey = currentView === "detail" ? "categories" : currentView;
  const links = document.querySelectorAll(".nav-link");
  links.forEach(function (link) {
    const active = link.dataset.view === navKey;
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
    link.classList.toggle("is-active", active);
  });

  let crumb = VIEW_MAP[currentView].crumb;
  if (currentView === "detail") {
    const found = state.categories.filter(function (c) { return c.id === currentDetailId; })[0];
    if (found) crumb = "首页 › 学分板块 › " + found.name;
  }
  const crumbEl = document.getElementById("breadcrumb");
  if (crumbEl) crumbEl.textContent = crumb;
  document.title = VIEW_MAP[currentView].title + "｜学分规划助手";

  if (withLoading) viewListLoading();
  else renderAll();
}

// 切换视图 / 重新读取：先显示"加载中"，再回到真实状态
function viewListLoading() {
  const previous = listStateOverride;
  listStateOverride = "loading";
  renderAll();
  window.setTimeout(function () {
    listStateOverride = previous;
    renderAll();
  }, 250);
}

// 列表呈现哪种状态：开发者开关优先，其次看有没有数据
function listStatusOf(count) {
  if (listStateOverride) return listStateOverride;
  return count === 0 ? "empty" : "success";
}

function makeListSkeleton(count) {
  const box = document.createElement("div");
  box.className = "list-skeleton";
  box.setAttribute("aria-busy", "true");
  const tip = document.createElement("p");
  tip.className = "state-tip";
  tip.textContent = "正在读取本机数据…";
  box.appendChild(tip);
  for (let i = 0; i < count; i++) {
    const bar = document.createElement("div");
    bar.className = "list-skeleton-card";
    box.appendChild(bar);
  }
  return box;
}

function makeListError() {
  const box = document.createElement("div");
  box.className = "list-error";
  box.setAttribute("role", "alert");
  const text = document.createElement("p");
  text.className = "list-error-text";
  text.textContent = "数据读取失败，没能取到本机保存的内容。";
  const hint = document.createElement("p");
  hint.className = "state-tip";
  hint.textContent = "常见原因是浏览器隐私模式或存储被清理。可以点「重试」再读一次。";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-ghost";
  btn.textContent = "重试";
  btn.addEventListener("click", function () {
    listStateOverride = "";
    const sel = document.getElementById("list-state");
    if (sel) sel.value = "";
    viewListLoading();
  });
  box.appendChild(text);
  box.appendChild(hint);
  box.appendChild(btn);
  return box;
}

function renderAll() {
  gapStats = calcCategoryStats(state);
  renderCategoryOptions();
  renderCategories();
  renderCourses();
  renderDetail();
  renderGpa();
  renderDecision();
  syncFormButtons();
  syncCopyButton();
  renderBulkBar();   // 批量工具栏（Day 28）
}

// 没有板块时可以复制的内容是空的，先把按钮禁掉（Day 11）
function syncCopyButton() {
  const btn = document.getElementById("copy-summary");
  if (!btn) return;
  btn.disabled = gapStats.length === 0;
}

function makeButton(label, action, className) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.dataset.action = action;
  btn.textContent = label;

  // 示例数据模式下：除"取消"、以及只读的"查看课程"外，所有编辑类按钮一律禁用（Day 9）
  // 以前是"点了才提示不能改"，现在改成"直接变灰点不动"，更接近正常产品
  if (mockMode && action !== "cancel" && action !== "detail") {
    btn.disabled = true;
    btn.title = "示例数据模式下不能修改";
  }

  return btn;
}

// 示例数据模式下，两个"添加"按钮也一起禁用
function syncFormButtons() {
  const buttons = document.querySelectorAll("#category-form button, #course-form button");
  buttons.forEach(function (btn) {
    btn.disabled = mockMode;
    btn.title = mockMode ? "示例数据模式下不能添加" : "";
  });
}

function makeBadge(text, className) {
  const badge = document.createElement("span");
  badge.className = "badge " + className;
  badge.textContent = text;
  return badge;
}

function makeEmpty(text) {
  const empty = document.createElement("p");
  empty.className = "empty";
  empty.textContent = text;
  return empty;
}

function isCategorySatisfied(categoryId) {
  const stat = gapStats.find(function (s) { return s.categoryId === categoryId; });
  return !!stat && stat.requiredCredits !== null && stat.gap === 0;
}

// ---- 板块①：学分板块 ----

function requiredText(credits) {
  if (credits === null || credits === undefined) {
    return "要求学分：未设置";
  }
  return "要求 " + credits + " 学分";
}

function buildCategoryCard(category) {
  const card = document.createElement("div");
  card.className = "category-card";
  card.dataset.id = category.id;

  // 刚新增的那一条高亮一下，让"加在哪儿了"这件事看得见（Day 11）
  if (category.id === lastAddedId) {
    card.classList.add("is-new");
  }

  const head = document.createElement("div");
  head.className = "card-head";

  const title = document.createElement("strong");
  title.className = "card-title";
  title.textContent = category.name;

  const required = document.createElement("span");
  required.className = "card-required";
  required.textContent = requiredText(category.requiredCredits);

  head.appendChild(title);
  head.appendChild(required);

  const stat = gapStats.find(function (s) { return s.categoryId === category.id; });
  if (stat && stat.requiredCredits !== null) {
    head.appendChild(makeBadge("已修 " + formatNumber(stat.doneCredits), "badge-done"));
  }
  card.appendChild(head);

  if (category.note) {
    const note = document.createElement("p");
    note.className = "card-note";
    note.textContent = "特殊条件：" + category.note;
    card.appendChild(note);
  }

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(makeButton("查看课程", "detail", "btn-ghost"));
  actions.appendChild(makeButton("修改", "edit", "btn-ghost"));
  actions.appendChild(makeButton("删除", "delete", "btn-danger"));
  card.appendChild(actions);

  return card;
}

function buildCategoryEditCard(category) {
  const card = document.createElement("div");
  card.className = "category-card editing";
  card.dataset.id = category.id;

  const fields = document.createElement("div");
  fields.className = "edit-fields";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "edit-name";
  nameInput.maxLength = 20;
  nameInput.value = category.name;

  const creditsInput = document.createElement("input");
  creditsInput.type = "number";
  creditsInput.className = "edit-credits";
  creditsInput.step = "0.5";
  creditsInput.min = "0.5";
  creditsInput.placeholder = "要求学分（可留空）";
  creditsInput.value = (category.requiredCredits === null || category.requiredCredits === undefined)
    ? ""
    : category.requiredCredits;

  const noteInput = document.createElement("input");
  noteInput.type = "text";
  noteInput.className = "edit-note";
  noteInput.maxLength = 100;
  noteInput.placeholder = "特殊条件备注（可留空）";
  noteInput.value = category.note || "";

  fields.appendChild(nameInput);
  fields.appendChild(creditsInput);
  fields.appendChild(noteInput);
  card.appendChild(fields);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(makeButton("保存", "save", "btn"));
  actions.appendChild(makeButton("取消", "cancel", "btn-ghost"));
  card.appendChild(actions);

  return card;
}

function renderCategories() {
  const list = document.getElementById("category-list");
  if (!list) return;

  list.innerHTML = "";

  // 四种状态（Day 13）：加载中 / 正常 / 空 / 错误
  const status = listStatusOf(state.categories.length);

  if (status === "loading") {
    list.appendChild(makeListSkeleton(2));
    return;
  }
  if (status === "error") {
    list.appendChild(makeListError());
    return;
  }
  if (status === "empty") {
    list.appendChild(makeEmpty(
      "还没有板块。先在上面添加第一个板块，例如“专业选修”，并填上它要求多少学分。"
    ));
    return;
  }

  state.categories.forEach(function (category) {
    if (category.id === editingId) {
      list.appendChild(buildCategoryEditCard(category));
    } else {
      list.appendChild(buildCategoryCard(category));
    }
  });
}

// ---- 板块详情页（Day 13）：#/category/<id> ----

function makeDetailNumber(label, value) {
  const box = document.createElement("div");
  box.className = "number-item";
  const dt = document.createElement("span");
  dt.className = "detail-label";
  dt.textContent = label;
  const dd = document.createElement("strong");
  dd.className = "detail-value";
  dd.textContent = value;
  box.appendChild(dt);
  box.appendChild(dd);
  return box;
}

// 详情页里的课程行是只读的：这里不放修改/删除按钮，避免出现"点了没反应"的死按钮
function buildDetailCourseRow(course) {
  const row = document.createElement("div");
  row.className = "detail-course";

  const name = document.createElement("span");
  name.className = "detail-course-name";
  name.textContent = course.name;

  const meta = document.createElement("span");
  meta.className = "detail-course-meta";
  const statusText = course.status === "done" ? "已修" : "计划修";
  const scoreText = (course.status === "done" && typeof course.score === "number")
    ? " · " + course.score + " 分"
    : "";
  meta.textContent = course.credits + " 学分 · " + statusText + scoreText;

  row.appendChild(name);
  row.appendChild(meta);
  return row;
}

function renderDetail() {
  const titleEl = document.getElementById("detail-title");
  const subEl = document.getElementById("detail-subtitle");
  const summaryEl = document.getElementById("detail-summary");
  const listEl = document.getElementById("detail-course-list");
  if (!titleEl || !listEl) return;

  const category = state.categories.filter(function (c) { return c.id === currentDetailId; })[0];

  // 板块不存在（被删除 / 地址栏手输错）：给出可理解的提示与退路
  if (!category) {
    titleEl.textContent = "板块详情";
    if (subEl) { subEl.textContent = ""; subEl.hidden = true; }
    if (summaryEl) summaryEl.innerHTML = "";
    listEl.innerHTML = "";
    listEl.appendChild(makeEmpty("没找到这个板块。它可能已经被删除了——点上面的「返回板块列表」回去看看。"));
    return;
  }

  titleEl.textContent = category.name + " · 课程明细";
  if (subEl) {
    subEl.textContent = requiredText(category.requiredCredits)
      + (category.note ? "；" + category.note : "");
    subEl.hidden = false;
  }

  const stat = gapStats.filter(function (s) { return s.categoryId === category.id; })[0];
  const courses = state.courses.filter(function (c) { return c.categoryId === category.id; });
  const doneCredits = stat ? stat.doneCredits : 0;

  if (summaryEl) {
    summaryEl.innerHTML = "";
    summaryEl.appendChild(makeDetailNumber("已修学分", String(doneCredits)));
    summaryEl.appendChild(makeDetailNumber(
      "要求学分",
      (category.requiredCredits === null || category.requiredCredits === undefined)
        ? "未设置"
        : String(category.requiredCredits)
    ));
    summaryEl.appendChild(makeDetailNumber(
      "还差",
      (stat && stat.gap !== null && stat.gap !== undefined) ? String(stat.gap) : "—"
    ));
  }

  // 四种状态
  const status = listStatusOf(courses.length);
  listEl.innerHTML = "";

  if (status === "loading") {
    listEl.appendChild(makeListSkeleton(3));
    return;
  }
  if (status === "error") {
    listEl.appendChild(makeListError());
    return;
  }
  if (status === "empty") {
    listEl.appendChild(makeEmpty("这个板块下还没有课程。到「课程」页添加时，把所属板块选成它就行。"));
    return;
  }

  courses.forEach(function (course) {
    listEl.appendChild(buildDetailCourseRow(course));
  });
}

function readEditCard(card) {
  const creditsRaw = card.querySelector(".edit-credits").value.trim();
  return {
    name: card.querySelector(".edit-name").value,
    requiredCredits: creditsRaw === "" ? null : Number(creditsRaw),
    note: card.querySelector(".edit-note").value
  };
}

// ---- 板块②：课程板块 ----

function buildCategorySelect(className, selectedId, includeEmptyPlaceholder) {
  const select = document.createElement("select");
  select.className = className;

  if (includeEmptyPlaceholder) {
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "选择板块";
    select.appendChild(placeholder);
  }

  state.categories.forEach(function (category) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.name;
    select.appendChild(option);
  });

  select.value = selectedId || "";
  return select;
}

function buildCourseCard(course) {
  const card = document.createElement("div");
  card.className = "course-card";
  card.dataset.id = course.id;

  // 批量选中态（Day 28）：整张卡片给边框+底色，
  // 100 行里靠找小方框太累，整卡变化才扫得出来
  if (selectedCourseIds.has(course.id)) card.classList.add("is-picked");

  // 刚新增的那一条高亮一下（Day 11）
  if (course.id === lastAddedId) {
    card.classList.add("is-new");
  }

  const head = document.createElement("div");
  head.className = "card-head";

  // 批量选择的勾选框（Day 28）
  // 放在卡片左上角第一个元素 —— 位置固定才符合「扫一眼就能勾」的习惯。
  const pick = document.createElement("label");
  pick.className = "card-pick";
  const pickBox = document.createElement("input");
  pickBox.type = "checkbox";
  pickBox.className = "card-pick-box";
  pickBox.dataset.pickId = course.id;
  pickBox.checked = selectedCourseIds.has(course.id);
  pickBox.setAttribute("aria-label", "选中《" + course.name + "》用于批量操作");
  pick.appendChild(pickBox);
  head.appendChild(pick);

  const title = document.createElement("strong");
  title.className = "card-title";
  title.textContent = course.name;

  const credits = document.createElement("span");
  credits.className = "card-credits";
  credits.textContent = course.credits + " 学分";

  head.appendChild(title);
  head.appendChild(credits);
  head.appendChild(makeBadge(
    course.status === "done" ? "已修" : "计划修",
    course.status === "done" ? "badge-done" : "badge-planned"
  ));
  if (isFailed(course)) {
    head.appendChild(makeBadge("不及格 · 不计学分", "badge-fail"));
  }
  if (course.status === "planned" && isCategorySatisfied(course.categoryId)) {
    head.appendChild(makeBadge("可不选", "badge-skip"));
  }
  card.appendChild(head);

  const meta = document.createElement("p");
  meta.className = "card-meta";
  const scoreText = (typeof course.score === "number") ? " · 成绩 " + course.score : " · 成绩未填";
  meta.textContent = "板块：" + categoryNameOf(state, course.categoryId)
    + (course.status === "done" ? scoreText : " · 还没修，不参与统计");
  card.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(makeButton("修改", "edit", "btn-ghost"));
  actions.appendChild(makeButton("删除", "delete", "btn-danger"));
  card.appendChild(actions);

  return card;
}

function buildCourseEditCard(course) {
  const card = document.createElement("div");
  card.className = "course-card editing";
  card.dataset.id = course.id;

  const fields = document.createElement("div");
  fields.className = "edit-fields";

  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.className = "edit-name";
  nameInput.maxLength = 30;
  nameInput.value = course.name;

  const creditsInput = document.createElement("input");
  creditsInput.type = "number";
  creditsInput.className = "edit-credits";
  creditsInput.step = "0.5";
  creditsInput.min = "0.5";
  creditsInput.placeholder = "学分";
  creditsInput.value = course.credits;

  const categorySelect = buildCategorySelect("edit-category", course.categoryId, true);

  const statusSelect = document.createElement("select");
  statusSelect.className = "edit-status";
  ["done", "planned"].forEach(function (value) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value === "done" ? "已修" : "计划修";
    statusSelect.appendChild(option);
  });
  statusSelect.value = course.status;

  const scoreInput = document.createElement("input");
  scoreInput.type = "number";
  scoreInput.className = "edit-score";
  scoreInput.min = "0";
  scoreInput.max = "100";
  scoreInput.step = "1";
  scoreInput.placeholder = "成绩（可选）";
  scoreInput.value = (typeof course.score === "number") ? course.score : "";
  scoreInput.disabled = course.status !== "done";

  statusSelect.addEventListener("change", function () {
    const isDone = statusSelect.value === "done";
    scoreInput.disabled = !isDone;
    if (!isDone) scoreInput.value = "";
  });

  fields.appendChild(nameInput);
  fields.appendChild(creditsInput);
  fields.appendChild(categorySelect);
  fields.appendChild(statusSelect);
  fields.appendChild(scoreInput);
  card.appendChild(fields);

  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(makeButton("保存", "save", "btn"));
  actions.appendChild(makeButton("取消", "cancel", "btn-ghost"));
  card.appendChild(actions);

  return card;
}

function readCourseEditCard(card) {
  const creditsRaw = card.querySelector(".edit-credits").value.trim();
  const scoreRaw = card.querySelector(".edit-score").value.trim();
  const status = card.querySelector(".edit-status").value;
  return {
    name: card.querySelector(".edit-name").value,
    credits: creditsRaw === "" ? null : Number(creditsRaw),
    categoryId: card.querySelector(".edit-category").value,
    status: status,
    score: (status === "done" && scoreRaw !== "") ? Number(scoreRaw) : null
  };
}

// 课程筛选（Day 12）：按关键词 / 板块 / 状态过滤，只影响显示，不改数据
function filterCourses(courses, filter) {
  const keyword = (filter.keyword || "").trim().toLowerCase();
  return courses.filter(function (course) {
    if (keyword && course.name.toLowerCase().indexOf(keyword) === -1) return false;
    if (filter.categoryId && course.categoryId !== filter.categoryId) return false;
    if (filter.status && course.status !== filter.status) return false;
    return true;
  });
}

// 按所属板块分组：组顺序跟随板块列表顺序，"未归类"永远排最后（Day 14）
function groupCoursesByCategory(visible, categories) {
  const known = {};
  categories.forEach(function (c) { known[c.id] = true; });

  const byCategory = {};
  visible.forEach(function (course) {
    // 板块已不存在的"孤儿课程"归入未归类，保证任何课程都不会在列表里消失
    const key = (course.categoryId && known[course.categoryId]) ? course.categoryId : "";
    if (!byCategory[key]) byCategory[key] = [];
    byCategory[key].push(course);
  });

  const groupKeys = [];
  categories.forEach(function (c) {
    if (byCategory[c.id]) groupKeys.push(c.id);
  });
  if (byCategory[""]) groupKeys.push("");

  return { groupKeys: groupKeys, byCategory: byCategory };
}

function resetCourseFilter() {
  courseFilter = { keyword: "", categoryId: "", status: "" };
  const keywordEl = document.getElementById("filter-keyword");
  const categoryEl = document.getElementById("filter-category");
  const statusEl = document.getElementById("filter-status");
  if (keywordEl) keywordEl.value = "";
  if (categoryEl) categoryEl.value = "";
  if (statusEl) statusEl.value = "";
}

function renderCourses() {
  const list = document.getElementById("course-list");
  if (!list) return;

  list.innerHTML = "";

  // 四种状态（Day 13）：加载中 / 正常 / 空 / 错误
  const emptyBox0 = document.getElementById("filter-empty");
  const status = listStatusOf(state.courses.length);

  if (status === "loading") {
    if (emptyBox0) emptyBox0.hidden = true;
    list.appendChild(makeListSkeleton(3));
    return;
  }
  if (status === "error") {
    if (emptyBox0) emptyBox0.hidden = true;
    list.appendChild(makeListError());
    return;
  }
  if (status === "empty") {
    if (emptyBox0) emptyBox0.hidden = true;
    list.appendChild(makeEmpty(
      state.categories.length === 0
        ? "先在左边「学分板块」创建板块，再回来录课程。"
        : "还没有课程。先在上面添加一门已经修过的课，例如“高等数学 / 5 学分 / 必修 / 已修 / 88”。"
    ));
    return;
  }

  const visible = filterCourses(state.courses, courseFilter);
  const emptyBox = emptyBox0;

  if (visible.length === 0) {
    // 有数据但被筛没了：行内空态，说清被隐藏了多少、怎么恢复（Day 12）
    if (emptyBox) {
      emptyBox.textContent = "没有匹配的课程（现有 " + state.courses.length + " 门都被筛掉了）。换个关键词，或点上面的「清空筛选」。";
      emptyBox.hidden = false;
    }
    return;
  }
  if (emptyBox) emptyBox.hidden = true;

  // 按所属板块分组、默认折叠（Day 14·同伴反馈：课程一多要滑很久）
  const grouped = groupCoursesByCategory(visible, state.categories);

  grouped.groupKeys.forEach(function (catId) {
    const courses = grouped.byCategory[catId];
    const cat = state.categories.filter(function (c) { return c.id === catId; })[0];
    const groupName = cat ? cat.name : "未归类";

    // 正在编辑 / 刚添加的课程所在组自动展开，避免"点了修改卡片却不见了"
    const hasSpecial = courses.some(function (c) {
      return c.id === editingCourseId || c.id === lastAddedId;
    });
    if (hasSpecial) expandedCourseGroups[catId] = true;

    const isOpen = !!expandedCourseGroups[catId];

    const group = document.createElement("div");
    group.className = "course-group" + (isOpen ? " is-open" : "");

    const head = document.createElement("button");
    head.type = "button";
    head.className = "course-group-head";
    head.setAttribute("aria-expanded", isOpen ? "true" : "false");

    const title = document.createElement("span");
    title.className = "course-group-title";
    title.textContent = groupName;

    const count = document.createElement("span");
    count.className = "course-group-count";
    // ⚠️ Day 28：这个分组里有几门已被选中。
    // 分组默认折叠，折叠时看不到里面的勾选框 ——
    // 不写出来的话，「全选之后有多少」就只能靠数屏幕上看得到的勾选框，
    // 数出来的必然比实际少（实测报过「全选只选到 91 门」）。
    const pickedInGroup = courses.filter(function (c) { return selectedCourseIds.has(c.id); }).length;
    count.textContent = courses.length + " 门" +
      (pickedInGroup > 0 ? " · 已选 " + pickedInGroup : "");
    if (pickedInGroup > 0) count.classList.add("has-picked");

    const arrow = document.createElement("span");
    arrow.className = "course-group-arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = isOpen ? "▾" : "▸";

    head.appendChild(title);
    head.appendChild(count);
    head.appendChild(arrow);
head.addEventListener("click", function () {
      expandedCourseGroups[catId] = !expandedCourseGroups[catId];
      renderCourses();
      // Day 28：展开/折叠会改变「有几门在折叠的分组里」，
      // 不刷新工具栏的话，「已选 30 门（其中 20 门在折叠的分组里）」
      // 会一直停在这个数字，用户展开完了看到的是过时的信息。
      renderBulkBar();
    });
    group.appendChild(head);

    if (isOpen) {
      const body = document.createElement("div");
      body.className = "course-group-body";
      courses.forEach(function (course) {
        if (course.id === editingCourseId) {
          body.appendChild(buildCourseEditCard(course));
        } else {
          body.appendChild(buildCourseCard(course));
        }
      });
      group.appendChild(body);
    }

    list.appendChild(group);
  });
}

function renderCategoryOptions() {
  const select = document.getElementById("course-category");
  if (!select) return;

  const previous = select.value;
  select.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.categories.length === 0 ? "请先创建板块" : "选择板块";
  select.appendChild(placeholder);

  state.categories.forEach(function (category) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.name;
    select.appendChild(option);
  });

  const stillExists = state.categories.some(function (c) { return c.id === previous; });
  select.value = stillExists ? previous : "";

  // 同步筛选行的板块下拉（Day 12）：选项跟随板块列表，保留当前筛选选择
  const filterSelect = document.getElementById("filter-category");
  if (filterSelect) {
    const prevFilter = courseFilter.categoryId;
    filterSelect.innerHTML = "";
    const allOption = document.createElement("option");
    allOption.value = "";
    allOption.textContent = "全部板块";
    filterSelect.appendChild(allOption);
    state.categories.forEach(function (category) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      filterSelect.appendChild(option);
    });
    const filterStillExists = state.categories.some(function (c) { return c.id === prevFilter; });
    filterSelect.value = filterStillExists ? prevFilter : "";
    if (!filterStillExists) courseFilter.categoryId = "";
  }
}

// ---- 板块③：绩点板块 ----

function renderGpa() {
  const overall = calcOverall(state, gpaRule);

  const totalBox = document.getElementById("stat-total");
  if (totalBox) totalBox.textContent = formatNumber(overall.totalCredits);

  const averageBox = document.getElementById("stat-average");
  if (averageBox) averageBox.textContent = formatNumber(overall.weightedAvg);

  const gpaBox = document.getElementById("stat-gpa");
  if (gpaBox) gpaBox.textContent = formatNumber(overall.gpa);

  const counts = document.getElementById("stat-counts");
  if (counts) {
    counts.textContent = state.categories.length + " 个板块 / " + state.courses.length + " 门课程";
  }

  renderOnboarding();
  renderPlanReconcile(overall);
}

/* 概览页的新手引导（Day 27）
   为什么加：第三方试用者打开网站第一反应是「是不是没加载完？怎么都是空的」。
   数字全是「—」、决策板块空白，看起来就像坏了。
   板块页和课程页本来就有空态文案（见 makeEmpty 那两处），只有概览页没有。

   判据用「板块和课程都为空」——和页面别处的空态保持同一个标准，
   不自己另立一套。只要用户建了任何一个板块或课程，引导就消失，
   免得已经在用的人还被当成新来的。 */
function renderOnboarding() {
  const box = document.getElementById("onboarding");
  if (!box) return;
  const isBlank = state.categories.length === 0 && state.courses.length === 0;
  box.hidden = !isBlank;
}

// ---------------------------------------------------------------------------
// 培养方案对账（Day 26）
// ---------------------------------------------------------------------------
// 三个数容易混在一起说不清，所以这里分开列：
//   方案要求  培养方案原文写的「毕业要修够多少学分」
//   可选      培养方案列出的所有课程加起来（你只要挑一部分修）
//   已修      你实际修完的（默认导入的都是「计划修」，所以刚导入时是 0）
//
// 「可选」必然大于「要求」，因为培养方案列的是所有可以修的课。
// 这个差不是错误，不说清楚会让人以为漏了课。
function renderPlanReconcile(overall) {
  const box = document.getElementById("plan-reconcile");
  if (!box) return;

  const plan = state.plan;
  if (!plan || !plan.totalRequired) {
    box.hidden = true;
    return;
  }
  box.hidden = false;

  const required = Number(plan.totalRequired);
  const picked = state.courses.reduce(function (sum, c) { return sum + (Number(c.credits) || 0); }, 0);
  const done = overall.totalCredits;
  const remain = Math.max(required - done, 0);

  const hint = document.getElementById("plan-reconcile-hint");
  if (hint) {
    hint.textContent = "依据「" + (plan.sourceName || "导入的培养方案") +
   "」写明的毕业要求学分。培养方案列的是所有可以修的课，实际只要挑够要求的学分。";
  }

  const numbers = document.getElementById("plan-numbers");
  if (numbers) {
    numbers.innerHTML =
      '<div><span class="pn-label">方案要求</span><b class="pn-req">' + formatNumber(required) + "</b></div>" +
      '<div><span class="pn-label">全部课程可选</span><b class="pn-pick">' + formatNumber(picked) + "</b></div>" +
      '<div><span class="pn-label">已修</span><b class="pn-done">' + formatNumber(done) + "</b></div>" +
      '<div><span class="pn-label">还差</span><b class="' +
      (remain > 0 ? "pn-remain" : "pn-clear") + '">' + formatNumber(remain) + "</b></div>";
  }

  const note = document.getElementById("plan-note");
  if (note) {
    if (done === 0) {
      note.textContent = "已修 0 分：导入的课都记为「计划修」。" +
    "把修完的课状态改成「已修」，这里就会算出你还差多少。";
    } else if (remain > 0) {
      note.textContent = "距离毕业要求还差 " + formatNumber(remain) + " 分。" +
    "可选学分是够的，重点看下面各板块分别还差多少。";
    } else {
      note.textContent = "已达到毕业要求学分，恭喜。";
    }
  }
}

// ---- 板块④：决策板块 ----

// 把当前进度整理成一段可复制、可分享的文字（Day 11）
// 纯函数：输入数据 + 已算好的板块统计，输出字符串，方便单独测试
function buildSummaryText(data, stats) {
  const lines = [];
  const overall = calcOverall(data, gpaRule);

  lines.push("学分规划助手 · 我的学分进度");
  lines.push("已修总学分 " + formatNumber(overall.totalCredits)
    + "｜加权平均分 " + formatNumber(overall.weightedAvg)
    + "｜GPA " + formatNumber(overall.gpa) + "（" + gpaRule + " 制）");
  lines.push("");

  stats.forEach(function (stat) {
    let line = "【" + stat.name + "】已修 " + formatNumber(stat.doneCredits);

    if (stat.requiredCredits === null) {
      line += " 学分（要求学分未设置，暂不计算缺口）";
    } else {
      line += " / 要求 " + formatNumber(stat.requiredCredits) + " 学分";

      if (stat.gap > 0) {
        line += " → 还差 " + formatNumber(stat.gap) + " 学分";
        const rec = buildRecommendation(stat);
        if (rec) {
          if (rec.level === "none") {
            line += "（还没登记这个板块的计划修课程）";
          } else if (rec.enough) {
            line += "，建议优先选：" + rec.picked.map(function (c) { return c.name; }).join("、")
              + "（至少 " + rec.count + " 门即可补齐）";
          } else {
            line += "，计划修课程加起来仍差 " + formatNumber(rec.remaining) + " 学分";
          }
        }
      } else {
        const extra = stat.doneCredits - stat.requiredCredits;
        line += " → 已修够";
        if (extra > 0) {
          line += "（超出 " + formatNumber(extra) + " 学分）";
        }
      }
    }

    lines.push(line);

    if (stat.note) {
      lines.push("　特殊条件：" + stat.note);
    }
  });

  lines.push("");
  lines.push("（数据仅保存在本机浏览器，未上传服务器）");

  return lines.join("\n");
}

// 老办法复制：临时塞一个看不见的文本框，选中后执行复制命令
function legacyCopy(text) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    return false;
  }
}

function renderDecision() {
  const box = document.getElementById("overview");
  if (!box) return;

  box.innerHTML = "";

  if (gapStats.length === 0) {
    box.appendChild(makeEmpty(
      "先创建板块并录入课程，这里会显示每个板块还差多少学分、以及建议优先选哪几门。"
    ));
    return;
  }

  gapStats.forEach(function (stat) {
    const row = document.createElement("div");
    row.className = "overview-row";

    const head = document.createElement("div");
    head.className = "card-head";

    const name = document.createElement("strong");
    name.className = "card-title";
    name.textContent = stat.name;

    const done = document.createElement("span");
    done.className = "card-credits";
    done.textContent = stat.requiredCredits === null
      ? "已修 " + formatNumber(stat.doneCredits) + " 学分"
      : "已修 " + formatNumber(stat.doneCredits) + " / 要求 " + formatNumber(stat.requiredCredits) + " 学分";

    head.appendChild(name);
    head.appendChild(done);

    let message = "";

    if (stat.requiredCredits === null) {
      head.appendChild(makeBadge("要求未设置", "badge-planned"));
      message = "这个板块还没填要求学分，暂时不参与缺口计算。补上要求学分后就能算出还差多少。";
    } else if (stat.gap > 0) {
      head.appendChild(makeBadge("还差 " + formatNumber(stat.gap) + " 学分", "badge-fail"));
      message = "这个板块的课还要继续选，直到修满 " + formatNumber(stat.gap) + " 学分。";
    } else {
      const extra = stat.doneCredits - stat.requiredCredits;
      head.appendChild(makeBadge("已修够", "badge-done"));
      message = extra > 0
        ? "已修够（超出 " + formatNumber(extra) + " 学分），这个板块的课不必再选。"
        : "已修够，这个板块的课不必再选。";
    }

    row.appendChild(head);

    // 说明 / 特殊条件 / 建议 这三段正是"一滑老长"的元凶：默认收起，只保留上面那行结论（Day 14·同伴反馈）
    const isOpen = !!expandedOverviewRows[stat.categoryId];

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "overview-toggle";
    toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    toggle.textContent = isOpen ? "收起说明" : "展开说明";
    toggle.addEventListener("click", function () {
      expandedOverviewRows[stat.categoryId] = !expandedOverviewRows[stat.categoryId];
      renderDecision();
    });
    row.appendChild(toggle);

    const detail = document.createElement("div");
    detail.className = "overview-detail";
    detail.hidden = !isOpen;

    const text = document.createElement("p");
    text.className = "overview-message";
    text.textContent = message;
    detail.appendChild(text);

    if (stat.note) {
      const note = document.createElement("p");
      note.className = "card-note";
      note.textContent = "特殊条件：" + stat.note;
      detail.appendChild(note);
    }

    const rec = buildRecommendation(stat);

    if (rec) {
      const planned = document.createElement("p");
      planned.className = "overview-planned";

      if (rec.level === "none") {
        planned.textContent = "计划修课程：还没有登记 —— 先把打算修的课加到「课程」页，这里就会给出建议。";
      } else if (rec.enough) {
        planned.classList.add("is-enough");
        planned.textContent = "建议优先选：" + rec.picked.map(function (c) {
          return c.name + "（" + c.credits + " 学分）";
        }).join("、") + " —— 至少 " + rec.count + " 门即可补齐 " + formatNumber(stat.gap) + " 学分。";
      } else {
        planned.textContent = "建议优先选：" + rec.picked.map(function (c) {
          return c.name + "（" + c.credits + " 学分）";
        }).join("、") + " —— 合计只有 " + formatNumber(rec.sum) + " 学分，仍差 "
          + formatNumber(rec.remaining) + " 学分，需要再补其它课程。";
      }
      detail.appendChild(planned);
    } else if (stat.plannedCourses.length > 0) {
      const planned = document.createElement("p");
      planned.className = "overview-planned";
      planned.textContent = "计划修课程：" + stat.plannedCourses.map(function (c) {
        return c.name + "（" + c.credits + " 学分）";
      }).join("、") + " —— 这个板块已修够，可以不用选。";
      detail.appendChild(planned);
    }

    row.appendChild(detail);
    box.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// 八、四种页面状态 + dev 工具（示例数据 / 状态预览）
// ---------------------------------------------------------------------------

function setSkeleton(on) {
  const skeleton = document.getElementById("skeleton");
  const layout = document.getElementById("layout");
  if (skeleton) skeleton.hidden = !on;
  if (layout) layout.hidden = on;
}

function showMockBanner(on) {
  const banner = document.getElementById("mock-banner");
  const loadBtn = document.getElementById("mock-load");
  const clearBtn = document.getElementById("mock-clear");
  if (banner) banner.hidden = !on;
  if (loadBtn) loadBtn.hidden = on;
  if (clearBtn) clearBtn.hidden = !on;
}

// 从本机存储读取真实数据并显示（成功态）
function showRealData() {
  const result = CreditPlanner.loadData();
  state = result.data;
  if (result.error) {
    showGlobalError(result.error);
  } else {
    hideGlobalError();
  }
  setSkeleton(false);
  showView(parseHash()); // 按地址栏 hash 落到对应视图，内部会 renderAll（Day 13）
}

function enterLoading() {
  hideGlobalError();
  setSkeleton(true);
}

// 切换四种状态；value 为 "" 表示回到正常显示
function applyViewState(value) {
  if (value === "loading") {
    enterLoading();
    return;
  }

  if (value === "empty") {
    setSkeleton(false);
    hideGlobalError();
    state = CreditPlanner.emptyData();
    renderAll();
    return;
  }

  if (value === "error") {
    setSkeleton(false);
    state = CreditPlanner.emptyData();
    renderAll();
    showGlobalError("数据读取失败（内容可能已损坏，或本机存储不可用）。已保留原始内容的备份，当前显示为空数据。可以刷新页面重试。");
    return;
  }

  setSkeleton(false);
  if (mockMode) {
    renderAll();
    return;
  }
  showRealData();
}

// ---------------------------------------------------------------------------
// 十、培养方案导入（Day 26）
// ---------------------------------------------------------------------------
// 导入面板（importer-ui.js）只负责「解析文件 → 让用户确认」，
// 真正写数据的事交给这里 —— 这样数据只有一条写入路径，
// 不会出现「表单加的课」和「导入的课」行为不一致的情况。
//
// 入参 items：[{ name, credits, section, term }]
//   section 是解析出来的板块名，可能匹配不上现有板块（比如用户已经改过名字），
//   所以逐条尝试匹配，匹配不上的留给用户手动选。
// 返回 { ok, added, skipped, categories, message }

function findCategoryIdByName(categories, name) {
  if (!name) return "";
  const target = String(name).replace(/\s+/g, "").toLowerCase();
  for (const c of categories) {
    const cn = String(c.name || "").replace(/\s+/g, "").toLowerCase();
    if (cn === target) return c.id;
    // 「专业核心课程」vs「专业核心」这类包含关系也算命中
    if (cn && (cn.indexOf(target) !== -1 || target.indexOf(cn) !== -1)) return c.id;
  }
  return "";
}

// 先按解析出来的板块名建板块；已存在的直接复用
// sectionMeta 是 [{name, required}] —— 培养方案原文写的「要求学分」，
// 建板块时一并填上，这样「还差多少学分」一建好就是准的，
// 不用用户再手动去查培养方案抄数字。
function ensureCategories(data, sectionMeta) {
  const created = [];
  const metas = Array.isArray(sectionMeta) ? sectionMeta : [];
  for (const meta of metas) {
    const name = typeof meta === "string" ? meta : meta.name;
    if (!name) continue;
    const required = typeof meta === "string" ? null : meta.required;
    if (findCategoryIdByName(data.categories, name)) continue;
    const result = addCategory(data, {
      name: name,
      requiredCredits: (required === null || required === undefined) ? null : Number(required),
      note: "由培养方案导入自动创建"
    });
    if (result.ok) {
      data = result.data;
      created.push(result.data.categories[result.data.categories.length - 1].name);
    }
  }
  return { data: data, created: created };
}

function importPlanItems(items) {
  if (mockMode) {
    return { ok: false, message: "示例数据模式下不能导入。请先点「清除示例」回到你自己的数据。" };
  }
  if (!Array.isArray(items) || !items.length) {
    return { ok: false, message: "没有可导入的课程。" };
  }

  let added = 0;
  const skipped = [];
  const unclassified = [];
  // 本次导入里因「与已有课程同名」被跳过的名字（Day 28）
  // 用来在结果提示里把两种跳过原因分开说 ——
  // 「重名」要去删旧的，「学分不合法」要去改学分，处理方式完全相反
  const dupThisRun = [];

  // 先把用到的板块建出来，并把培养方案原文的「要求学分」一起填进去。
  // 每条课程可以带 sectionRequired；同名板块取第一个非空值。
  const requiredBySection = {};
  for (const it of items) {
    if (!it.section) continue;
    if (it.sectionRequired === null || it.sectionRequired === undefined) continue;
    // 同一板块可能有多条课程，各自带的要求学分不同：
    //   通识教育的课分别带 3.5 / 8 / 1（课程类别列里的细分小组）
    // 而「课程模块」列写的是整个模块的总要求 50.5。
    // 取最大值 —— 模块的总要求才是这个板块真正要修够的数。
    requiredBySection[it.section] = Math.max(requiredBySection[it.section] || 0, Number(it.sectionRequired));
  }
  const usedNames = Array.from(new Set(items.map(function (it) { return it.section; }).filter(Boolean)));
  const sectionMeta = usedNames.map(function (name) {
    return { name: name, required: requiredBySection[name] };
  });
  const ensured = ensureCategories(state, sectionMeta);
  state = ensured.data;

for (const it of items) {
    const name = (it.name || "").trim();
    if (!name) continue;

    // 已经有同名课程就跳过，不重复添加
    const dup = state.courses.some(function (c) { return c.name === name; });
    if (dup) {
    skipped.push(name);
      // 记下来：后面要把「重名」和「学分不合法」分开说（Day 28）
      dupThisRun.push(name);
      continue;
    }

    const catId = findCategoryIdByName(state.categories, it.section);
    if (!catId) unclassified.push(name);

    const result = addCourse(state, {
    name: name,
      credits: Number(it.credits),
      categoryId: catId,
      status: "planned",          // 导入的课默认算「计划修」，用户改成「已修」
      score: null,
      term: it.term || ""         // 培养方案里的推荐修读学期，留着给清单页用
    });
    if (result.ok) {
      state = result.data;
      added++;
    } else {
      skipped.push(name);
    }
  }

  // 把培养方案的总要求学分记下来，供概览页对账。
  // totalRequired 就是文档原文写的那个数（这份是天文学 148.5），
  // 它是「毕业要修够多少」，跟「你目前选了多少门课」不是一回事，
  // 有它才能说清「还差多少」。
  if (added > 0) {
    const totalReq = Number(items[0] && items[0].planTotalRequired);
    state.plan = {
      sourceName: (items[0] && items[0].planSourceName) || "",
      totalRequired: (isFinite(totalReq) && totalReq > 0) ? totalReq : null,
      importedAt: new Date().toISOString()
    };
    persist();
    renderAll();
  }

  let message = "已导入 " + added + " 门课程。";
  // ⚠️ Day 28改：把「跳过」的原因分开说。
  //
  // 【为什么要改】原来是「跳过 N 门（已存在或数据不合法）」——
  //   把两种完全不同的原因混在一句里，用户看到「说好的 100，怎么少了 1」，
  //   但既不知道是哪门，也不知道为什么，只能猜。
  //   而且「已存在」和「数据不合法」的处理方式完全相反：
  //   前者要去删掉已有的那门，后者要改学分 —— 不说清就等于没说。
  if (skipped.length) {
    message += " 跳过 " + skipped.length + " 门（";
    // 分类统计：重名 vs 校验不过
    const dupNames = skipped.filter(function (n) { return dupThisRun.indexOf(n) >= 0; });
    const invalidNames = skipped.filter(function (n) { return dupThisRun.indexOf(n) < 0; });
    if (dupNames.length) message += dupNames.length + " 门与已有课程同名";
    if (invalidNames.length) {
      if (dupNames.length) message += "，";
      message += invalidNames.length + " 门没通过学分校验（" +
        invalidNames.slice(0, 3).join("、") + (invalidNames.length > 3 ? " 等" : "") + "）";
    }
    message += "）。";
  }
  if (unclassified.length) {
    // 没归板块的门也算没导入成功，必须在这里说清，
    // 否则摘要上写「可以导入 100」，实际只进了 99，看着像少了一门
    message += " 另有 " + unclassified.length + " 门没归到板块" +
      "（" + unclassified.slice(0, 3).join("、") + (unclassified.length > 3 ? " 等" : "") +
      "），需要你手动选板块后重新导入。";
  }
  // 说明「已修 0 分」不是出错：培养方案列的是「可以修的课」，
  // 不是「你已经修过的课」。默认全记为计划修，用户自己改成已修。
  message += "这些课都记为「计划修」，修过的改成「已修」后概览才会算进已修学分。";

  return {
    ok: true,
    added: added,
    skipped: skipped,
    unclassified: unclassified,
    categoriesCreated: ensured.created,
    message: message
  };
}

// 导入用到的现有板块，供导入面板显示下拉选项
function listCategories() {
  return state.categories.map(function (c) {
    return { id: c.id, name: c.name, requiredCredits: c.requiredCredits };
  });
}

// 导入前查重：告诉用户哪些已经在列表里了
function listExistingCourseNames() {
  return state.courses.map(function (c) { return c.name; });
}

// ---------------------------------------------------------------------------
// 十、凭记忆确认已修（Day 26）
//
// 场景：新生刚导入培养方案，99 门课全是「计划修」，
// 但他其实记得自己已经修过其中三四十门，只是不知道是哪几门。
// 如果让他回课程列表一门门找，等于又做了一遍导入时省下的事。
//
// 所以做成一个独立的清单页：凭记忆点过去，一路确认。
//
// 【三条设计取舍，写在这里免得以后被改回去】
// 1) 默认全部是「还没决定」，不是「已修」。
//    万一只是打开看看，手抖点错了还能立刻重来；
//    反过来默认全标已修的话，一不小心就全标上去了，且看不出原来是什么状态。
// 2) 页面本身不写任何数据，只有点「完成」才落盘。
//    中途关掉、刷新、误按 Esc 都不影响已有数据。
// 3) 标成「已修」的课允许没成绩 —— 这时会算进已修学分但不算 GPA，
//    这是如实反映「你确实修完了但没录成绩」，不是 bug。
// ---------------------------------------------------------------------------

// 清单页要显示的课程：只列「计划修」的（已修的已经确定，不用再回忆）
// 默认按推荐学期排序，没学期的排最后 —— 凭记忆回想时，时间线比板块更好用。
function listForReview() {
  const planned = state.courses.filter(function (c) { return c.status === "planned"; });

  function termKey(c) {
    const t = String(c.term || "");
    if (!t) return Number.MAX_SAFE_INTEGER;
    // 「3,4学期」「第3,4学期」这类多学期写法，取最小的那个学期数
    const nums = t.match(/\d+/g);
    return nums ? Number(nums[0]) : Number.MAX_SAFE_INTEGER;
  }

  const sorted = planned.slice().sort(function (a, b) {
    const ka = termKey(a);
    const kb = termKey(b);
    if (ka !== kb) return ka - kb;
    return a.credits - b.credits;      // 同学期里先看学分小的，先把小额的门清掉
  });

  return sorted.map(function (c) {
    return {
      id: c.id,
      name: c.name,
      credits: c.credits,
      term: c.term || "",
      categoryName: categoryNameOf(state, c.categoryId) || "未归板块"
    };
  });
}

// 应用清单页的确认结果
// 入参 marks：[{ id, isDone: true/false, score: number|null }]
//   isDone=true  → 改成「已修」，score 有值就一起写
//   isDone=false → 明确「没修过」，保持「计划修」（顺便把成绩清掉，避免脏数据）
// 没出现在 marks 里的课一律不动。
function applyReviewMarks(marks) {
  if (mockMode) {
    return { ok: false, message: "示例数据模式下不能改。请先点「清除示例」回到你自己的数据。" };
  }
  if (!Array.isArray(marks)) {
    return { ok: false, message: "数据格式不对。" };
  }

  let markedDone = 0;
  let markedPlanned = 0;
  const notFound = [];
  const invalid = [];

  let next = cloneData(state);
  for (const m of marks) {
    const index = next.courses.findIndex(function (c) { return c.id === m.id; });
    if (index === -1) {
      notFound.push(m.id);
      continue;
    }
    const course = next.courses[index];

    if (m.isDone) {
      let score = null;
      if (m.score !== null && m.score !== undefined && m.score !== "") {
        const n = Number(m.score);
        if (isNaN(n) || n < 0 || n > 100 || Math.round(n) !== n) {
          invalid.push(course.name + "（成绩需为 0–100 的整数）");
          continue;
        }
        score = n;
      }
      course.status = "done";
      course.score = score;
      markedDone++;
    } else {
      course.status = "planned";
      course.score = null;
      markedPlanned++;
    }
  }

  if (markedDone === 0 && markedPlanned === 0) {
    return {
      ok: false,
      message: invalid.length
        ? "成绩填写有误，什么都没改：" + invalid.slice(0, 3).join("、")
        : "没有确认任何课程，数据没有变化。"
    };
  }

  state = next;
  persist();
  renderAll();

  let message = "已把 " + markedDone + " 门课标记为已修。";
  if (markedPlanned) message += markedPlanned + " 门保持计划修。";

  const noScore = state.courses.filter(function (c) {
    return c.status === "done" && (c.score === null || c.score === undefined);
  }).length;
  if (noScore > 0) {
    message += "其中 " + noScore + " 门没填成绩，已修学分会计入，但 GPA / 平均分暂时算不出来（这是正常的，成绩可以之后补）。";
  }
  if (invalid.length) {
    message += " 有 " + invalid.length + " 门因为成绩填错没改成：" + invalid.slice(0, 3).join("、");
  }
  if (notFound.length) {
    message += " 有 " + notFound.length + " 门在列表里找不到了（可能已被删除）。";
  }

  return {
    ok: true,
    markedDone: markedDone,
    markedPlanned: markedPlanned,
    noScore: noScore,
    invalid: invalid,
    message: message
  };
}

// ---------------------------------------------------------------------------
// 九、事件
// ---------------------------------------------------------------------------

function applyCategoryResult(result) {
  if (mockMode) {
    showError("category-error", "当前是示例数据，不能修改。请先点右上角「清除示例」。");
    return false;
  }
  if (!result.ok) {
    showError("category-error", result.error);
    return false;
  }
  state = result.data;
  persist();
  editingId = null;
  showError("category-error", "");
  renderAll();
  return true;
}

function applyCourseResult(result) {
  if (mockMode) {
    showError("course-error", "当前是示例数据，不能修改。请先点右上角「清除示例」。");
    return false;
  }
  if (!result.ok) {
    showError("course-error", result.error);
    return false;
  }
  state = result.data;
  persist();
  editingCourseId = null;
  showError("course-error", "");
  renderAll();
  return true;
}

function bindEvents() {
  attachLiveValidation();
  const categoryForm = document.getElementById("category-form");
  if (categoryForm) {
    categoryForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (mockMode) {
        showError("category-error", "当前是示例数据，不能修改。请先点页面底部「清除示例」。");
        return;
      }

      const submitBtn = categoryForm.querySelector('button[type="submit"]');
      runSubmit(submitBtn, "添加板块", function () {
        const creditsRaw = document.getElementById("category-credits").value.trim();
        const input = {
          name: document.getElementById("category-name").value,
          requiredCredits: creditsRaw === "" ? null : Number(creditsRaw),
          note: document.getElementById("category-note").value
        };

        const result = addCategory(state, input);

        if (!result.ok) {
          showError("category-error", result.error);
          refreshLiveForm("category-form");
          return { ok: false, feedbackId: "category-feedback", message: "✕ " + result.error };
        }

        state = result.data;
        persist();
        showError("category-error", "");

        const added = state.categories[state.categories.length - 1];
        lastAddedId = added.id;
        categoryForm.reset();
        clearLiveValidation("category-form");
        renderAll();
        lastAddedId = null;

        return { ok: true, feedbackId: "category-feedback", message: "✓ 已添加板块：" + added.name };
      });
    });
  }

  const categoryList = document.getElementById("category-list");
  if (categoryList) {
    categoryList.addEventListener("click", function (event) {
      const btn = event.target.closest("button[data-action]");
      if (!btn) return;

      const card = btn.closest(".category-card");
      const id = card.dataset.id;
      const action = btn.dataset.action;

      if (action === "edit") {
        editingId = id;
        showError("category-error", "");
        renderCategories();
        return;
      }

      if (action === "cancel") {
        editingId = null;
        showError("category-error", "");
        renderCategories();
        return;
      }

      if (action === "save") {
        applyCategoryResult(updateCategory(state, id, readEditCard(card)));
        return;
      }

      if (action === "detail") {
        window.location.hash = "#/category/" + id; // 进板块详情（Day 13）
        return;
      }

      if (action === "delete") {
        requestDelete("category", id, card);
      }
    });
  }

  const courseForm = document.getElementById("course-form");
  const scoreInput = document.getElementById("course-score");
  const statusInput = document.getElementById("course-status");

  if (statusInput && scoreInput) {
    const syncScoreDisabled = function () {
      const isDone = statusInput.value === "done";
      scoreInput.disabled = !isDone;
      if (!isDone) scoreInput.value = "";
    };
    statusInput.addEventListener("change", syncScoreDisabled);
    syncScoreDisabled();
  }

  if (courseForm) {
    courseForm.addEventListener("submit", function (event) {
      event.preventDefault();

      if (mockMode) {
        showError("course-error", "当前是示例数据，不能修改。请先点页面底部「清除示例」。");
        return;
      }

      const submitBtn = courseForm.querySelector('button[type="submit"]');
      runSubmit(submitBtn, "添加课程", function () {
        const creditsRaw = document.getElementById("course-credits").value.trim();
        const scoreRaw = document.getElementById("course-score").value.trim();
        const status = document.getElementById("course-status").value;

        const input = {
          name: document.getElementById("course-name").value,
          credits: creditsRaw === "" ? null : Number(creditsRaw),
          categoryId: document.getElementById("course-category").value,
          status: status,
          score: (status === "done" && scoreRaw !== "") ? Number(scoreRaw) : null
        };

        const result = addCourse(state, input);

        if (!result.ok) {
          showError("course-error", result.error);
          refreshLiveForm("course-form");
          return { ok: false, feedbackId: "course-feedback", message: "✕ " + result.error };
        }

        state = result.data;
        persist();
        showError("course-error", "");

        const added = state.courses[state.courses.length - 1];
        lastAddedId = added.id;
        courseForm.reset();
        clearLiveValidation("course-form");
        resetCourseFilter(); // 新加的课程要立刻可见：清掉筛选再渲染（Day 12）
        renderCategoryOptions();
        renderAll();
        lastAddedId = null;
        if (statusInput && scoreInput) {
          scoreInput.disabled = statusInput.value !== "done";
        }

        return { ok: true, feedbackId: "course-feedback", message: "✓ 已添加课程：" + added.name };
      });
    });
  }

  // 课程筛选（Day 12）：输入即过滤，只动显示不动数据；清空一键恢复
  const filterKeyword = document.getElementById("filter-keyword");
  const filterCategory = document.getElementById("filter-category");
  const filterStatus = document.getElementById("filter-status");
  const filterClear = document.getElementById("filter-clear");

  const applyCourseFilter = function () {
    courseFilter.keyword = filterKeyword ? filterKeyword.value : "";
    courseFilter.categoryId = filterCategory ? filterCategory.value : "";
    courseFilter.status = filterStatus ? filterStatus.value : "";
    renderCourses();
  };

  if (filterKeyword) filterKeyword.addEventListener("input", applyCourseFilter);
  if (filterCategory) filterCategory.addEventListener("change", applyCourseFilter);
  if (filterStatus) filterStatus.addEventListener("change", applyCourseFilter);

  if (filterClear) {
    filterClear.addEventListener("click", function () {
      resetCourseFilter();
      renderCourses();
      if (filterKeyword) filterKeyword.focus();
    });
  }

  const courseList = document.getElementById("course-list");
  if (courseList) {
    courseList.addEventListener("click", function (event) {
      const btn = event.target.closest("button[data-action]");
      if (!btn) return;

      const card = btn.closest(".course-card");
      const id = card.dataset.id;
      const action = btn.dataset.action;

      if (action === "edit") {
        const editingCourse = state.courses.filter(function (c) { return c.id === id; })[0];
        if (editingCourse) expandedCourseGroups[editingCourse.categoryId || ""] = true;
        editingCourseId = id;
        showError("course-error", "");
        renderCourses();
        return;
      }

      if (action === "cancel") {
        editingCourseId = null;
        showError("course-error", "");
        renderCourses();
        return;
      }

      if (action === "save") {
        applyCourseResult(updateCourse(state, id, readCourseEditCard(card)));
        return;
      }

      if (action === "delete") {
        requestDelete("course", id, card);
      }
    });
  }

  const ruleSelect = document.getElementById("gpa-rule");
  if (ruleSelect) {
    ruleSelect.value = gpaRule;
    ruleSelect.addEventListener("change", function () {
      gpaRule = ruleSelect.value;
      renderGpa();
    });
  }

  // 交互 B：复制进度结论（Day 11）
  // 处理中：按钮禁用并改文案；成功：按钮变"✓ 已复制"；失败：给出一个可手动复制的文本框
  const copyBtn = document.getElementById("copy-summary");
  const copyFallback = document.getElementById("copy-fallback");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      if (copyBtn.disabled) return;

      const text = buildSummaryText(state, gapStats);
      const idleText = copyBtn.textContent;
      copyBtn.disabled = true;
      copyBtn.textContent = "复制中…";

      const finish = function (ok) {
        copyBtn.disabled = false;
        if (ok) {
          copyBtn.textContent = "✓ 已复制";
          showFeedback("copy-feedback", "✓ 已复制到剪贴板（共 " + text.length + " 个字符）", true);
          window.setTimeout(function () {
            copyBtn.textContent = idleText;
          }, 1500);
          if (copyFallback) copyFallback.hidden = true;
        } else {
          copyBtn.textContent = idleText;
          showFeedback("copy-feedback", "✕ 浏览器不允许自动复制，请从下面的框里手动复制", false);
          if (copyFallback) {
            copyFallback.hidden = false;
            copyFallback.value = text;
            copyFallback.focus();
            copyFallback.select();
          }
        }
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
          .then(function () { finish(true); })
          .catch(function () { finish(legacyCopy(text)); });
      } else {
        finish(legacyCopy(text));
      }
    });
  }

  // dev：载入示例数据（只填页面，不落盘）
  const mockLoad = document.getElementById("mock-load");
  if (mockLoad) {
    mockLoad.addEventListener("click", function () {
      mockMode = true;
      state = cloneData(MOCK_DATA);
      editingId = null;
      editingCourseId = null;
      showMockBanner(true);
      hideGlobalError();
      setSkeleton(false);
      const preview = document.getElementById("state-preview");
      if (preview) preview.value = "";
      renderAll();
    });
  }

  // dev：载入示例数据 2 · 天文学专业（98+2 门，用来压页面的真实规模）
  const mockLoad2 = document.getElementById("mock2-load");
  if (mockLoad2) {
    mockLoad2.addEventListener("click", function () {
      mockMode = true;
      state = cloneData(MOCK_DATA_2);
      editingId = null;
      editingCourseId = null;
      showMockBanner(true);
      hideGlobalError();
      setSkeleton(false);
      const preview2 = document.getElementById("state-preview");
      if (preview2) preview2.value = "";
      renderAll();
    });
  }

  // dev：清除示例，回到真实数据
  const mockClear = document.getElementById("mock-clear");
  if (mockClear) {
    mockClear.addEventListener("click", function () {
      mockMode = false;
      showMockBanner(false);
      const preview = document.getElementById("state-preview");
      if (preview) preview.value = "";
      showRealData();
    });
  }

  // 视图切换：hash 路由（Day 13）——点导航改地址栏 hash，浏览器前进/后退也能用
  window.addEventListener("hashchange", function () {
    showView(parseHash(), { loading: true });
  });

  // 详情页：返回板块列表（Day 13）
  const detailBack = document.getElementById("detail-back");
  if (detailBack) {
    detailBack.addEventListener("click", function () {
      window.location.hash = "#/categories";
    });
  }

  // dev：列表状态（加载中 / 空 / 错误 / 跟随真实数据）
  const listState = document.getElementById("list-state");
  if (listState) {
    listState.addEventListener("change", function () {
      listStateOverride = listState.value;
      renderAll();
    });
  }

  // dev：状态预览
  const statePreview = document.getElementById("state-preview");
  if (statePreview) {
    statePreview.addEventListener("change", function () {
      applyViewState(statePreview.value);
    });
  }

  // dev：模拟删除提交失败（用于测试错误提示）
  const simFailDelete = document.getElementById("sim-fail-delete");
  if (simFailDelete) {
    simFailDelete.addEventListener("change", function () {
      simulateDeleteFail = simFailDelete.checked;
    });
  }

  // 撤销条上的"撤销"按钮（Day 28：批量删除也走这里）
  const undoBtn = document.getElementById("undo-btn");
  if (undoBtn) {
    undoBtn.addEventListener("click", function () {
      // 优先撤销批量删除 —— 它一次能救回全部，优先级高于单条
      if (bulkPending) { undoBulkDelete(); return; }
      undoDelete();
    });
  }

  bindBulkEvents();
}

// 批量工具栏的事件（Day 28）
// 单独一个函数，别把 bindEvents 撑得太长
function bindBulkEvents() {
  const list = document.getElementById("course-list");

  // 勾选框：事件委托（列表会重渲染，绑到每个复选框上会被清掉）
  if (list) {
    list.addEventListener("change", function (e) {
      const box = e.target.closest("input[data-pick-id]");
      if (!box) return;
      toggleCourseSelect(box.dataset.pickId, box.checked);
      // 不走 renderAll —— 重渲染会让列表跳一下，
      // 这里只改这一张卡片 + 工具栏，滚动位置不动
      const card = box.closest(".course-card");
      if (card) card.classList.toggle("is-picked", box.checked);
      renderBulkBar();
    });
  }

  const allBox = document.getElementById("bulk-all");
  if (allBox) {
    allBox.addEventListener("change", function () {
      const on = allBox.checked;
      // 只作用于**当前可见**的课（被筛掉的勾上也没意义，改筛选后会变孤儿）
      filterCourses(state.courses, courseFilter).forEach(function (c) {
        toggleCourseSelect(c.id, on);
      });
      renderAll();
    });
  }

  const assignBtn = document.getElementById("bulk-assign-btn");
  if (assignBtn) assignBtn.addEventListener("click", bulkAssignCategory);

  const delBtn = document.getElementById("bulk-delete-btn");
  if (delBtn) delBtn.addEventListener("click", bulkDeleteCourses);

  const clearBtn = document.getElementById("bulk-clear-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", function () {
      clearCourseSelection();
      renderAll();
    });
  }
}

// 页面加载：先显示"加载中"，再读数据并显示
/* 开发者工具面板：默认隐藏，网址后加 ?dev=1 才显示（Day 27）
   为什么是「隐藏」而不是「删掉」：
   删掉元素后 app.js 里 getElementById("mock-load") 这类代码就拿不到节点，
   「载入示例数据」「状态预览」「模拟删除失败」这些自测手段会一起废掉。
   只用 CSS 隐藏、元素留在 DOM 里，事件照绑，功能全在，随时能打开。 */
function initDevPanel() {
  const panel = document.getElementById("dev-panel");
  if (!panel) return;
  const flag = new URLSearchParams(window.location.search).get("dev");
  // 顺带支持 #dev 锚点：开发时在控制台敲 location.hash = "#dev" 也能开
  if (flag === "1" || window.location.hash === "#dev") {
    panel.classList.add("is-dev-visible");
  }
}

document.addEventListener("DOMContentLoaded", function () {
  initDevPanel();
  bindEvents();
  enterLoading();

  window.setTimeout(function () {
    showRealData();
  }, 600);
});

window.CreditApp = {
  validateCategory: validateCategory,
  addCategory: addCategory,
  updateCategory: updateCategory,
  removeCategory: removeCategory,
  findCategoryCourses: findCategoryCourses,
  validateCourse: validateCourse,
  addCourse: addCourse,
  updateCourse: updateCourse,
  removeCourse: removeCourse,
  isFailed: isFailed,
  countsAsDoneCredits: countsAsDoneCredits,
  categoryNameOf: categoryNameOf,
  calcCategoryStats: calcCategoryStats,
  buildRecommendation: buildRecommendation,
  calcOverall: calcOverall,
  gradePoint: gradePoint,
  cloneData: cloneData,
  buildSummaryText: buildSummaryText,
  importPlanItems: importPlanItems,
  listCategories: listCategories,
  listExistingCourseNames: listExistingCourseNames,
  listForReview: listForReview,
  applyReviewMarks: applyReviewMarks,
  isMockMode: function () { return mockMode; },
  MOCK_DATA: MOCK_DATA,
  MOCK_DATA_2: MOCK_DATA_2
};
