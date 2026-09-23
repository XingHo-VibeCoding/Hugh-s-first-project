// 学分规划助手 —— 页面交互与计算逻辑（Day 7）
// 步骤 2：接入本机存储
// 步骤 3：板块管理（F1）
// 步骤 4：课程录入（F2）
// 步骤 5：板块缺口与选课结论（F3）+ 总分与 GPA（F4）
//
// 代码分两层：
//   1) 数据与计算层（不碰页面，可单独测试）
//   2) 渲染与事件层（把结果画到页面上）

// ---------------------------------------------------------------------------
// 一、通用
// ---------------------------------------------------------------------------

function cloneData(data) {
  return {
    version: data.version,
    categories: data.categories.map(function (c) { return Object.assign({}, c); }),
    courses: data.courses.map(function (c) { return Object.assign({}, c); })
  };
}

function makeId() {
  return "id-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1000).toString(36);
}

// 把数字显示成好读的样子（最多两位小数，去掉多余的 0）
function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

// ---------------------------------------------------------------------------
// 二、板块（F1）
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
    if (Math.round(credits * 2) !== credits * 2) {
      return { ok: false, error: "要求学分需为 0.5 的整数倍（如 0.5 / 1.5 / 12）。" };
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
// 三、课程（F2）
// ---------------------------------------------------------------------------

// 已修 + 有成绩 + 低于 60 分 = 不及格（不计入已修学分）
function isFailed(course) {
  return course.status === "done"
    && typeof course.score === "number"
    && course.score < 60;
}

// 这门课算不算"已修学分"（不及格的课不算）
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
    return { ok: false, error: "请填写学分（可填 0.5 的整数倍，如 3 或 1.5）。" };
  }
  if (credits <= 0) {
    return { ok: false, error: "学分要大于 0。" };
  }
  if (Math.round(credits * 2) !== credits * 2) {
    return { ok: false, error: "学分需为 0.5 的整数倍（如 0.5 / 1.5 / 3）。" };
  }

  if (!input.categoryId) {
    return { ok: false, error: "请选择所属板块。" };
  }
  const categoryExists = data.categories.some(function (c) { return c.id === input.categoryId; });
  if (!categoryExists) {
    return { ok: false, error: "所属板块不存在，请先到“我的板块”里创建。" };
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

function buildCourseRecord(input) {
  const hasScore = input.score !== null && input.score !== undefined;
  return {
    id: makeId(),
    name: (input.name || "").trim(),
    credits: input.credits,
    categoryId: input.categoryId,
    status: input.status,
    score: (input.status === "done" && hasScore) ? input.score : null
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
// 四、计算层：板块缺口（F3）与总分 GPA（F4）
// ---------------------------------------------------------------------------

// 各板块的缺口
// 返回 [{ categoryId, name, note, requiredCredits, doneCredits, gap, plannedCourses }]
// 说明：requiredCredits 为 null 表示"未设置"，不参与缺口计算
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

    // 缺口 = 要求 - 已修；已修超出时按 0 处理（页面不出现负数）
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

// GPA 换算表（各校规则不同，这里给三套常见口径，页面已标注"以本校规定为准"）
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

// 已修总学分、加权平均分、GPA
// 规则：只统计"计入已修学分"的课程（不及格不计）；成绩为空的课只计学分，不参与平均分与 GPA
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
// 五、渲染与事件层
// ---------------------------------------------------------------------------

let state = null;
let editingId = null;
let editingCourseId = null;
let gapStats = [];                    // 各板块缺口（渲染课程卡片时也要用）
let gpaRule = "4.0";                  // 当前 GPA 换算规则

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

function showStorageError(message) {
  const notice = document.getElementById("storage-notice");
  if (!notice) return;
  notice.textContent = message;
  notice.classList.add("notice-error");
}

function persist() {
  const result = CreditPlanner.saveData(state);
  if (!result.ok) {
    showStorageError(result.message);
  }
}

function renderAll() {
  gapStats = calcCategoryStats(state);
  renderCategoryOptions();
  renderCategories();
  renderCourses();
  renderOverview();
  renderCounts();
}

function renderCounts() {
  const counts = document.getElementById("stat-counts");
  if (counts) {
    counts.textContent = state.categories.length + " 个板块 / " + state.courses.length + " 门课程";
  }
}

function makeButton(label, action, className) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.dataset.action = action;
  btn.textContent = label;
  return btn;
}

function makeBadge(text, className) {
  const badge = document.createElement("span");
  badge.className = "badge " + className;
  badge.textContent = text;
  return badge;
}

// 某板块是不是"已修够"（要求未设置时不判定）
function isCategorySatisfied(categoryId) {
  const stat = gapStats.find(function (s) { return s.categoryId === categoryId; });
  return !!stat && stat.requiredCredits !== null && stat.gap === 0;
}

// ---- 板块 ----

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

  if (state.categories.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "还没有板块。先在上面添加第一个板块，例如“专业选修”。";
    list.appendChild(empty);
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

function readEditCard(card) {
  const creditsRaw = card.querySelector(".edit-credits").value.trim();
  return {
    name: card.querySelector(".edit-name").value,
    requiredCredits: creditsRaw === "" ? null : Number(creditsRaw),
    note: card.querySelector(".edit-note").value
  };
}

// ---- 课程 ----

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

  const head = document.createElement("div");
  head.className = "card-head";

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
  // 所属板块已经修够了 → 这门计划修的课"可不选"
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

function renderCourses() {
  const list = document.getElementById("course-list");
  if (!list) return;

  list.innerHTML = "";

  if (state.courses.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.categories.length === 0
      ? "先在左边创建板块，再回来录课程。"
      : "还没有课程。先在上面添加一门已经修过的课吧。";
    list.appendChild(empty);
    return;
  }

  state.courses.forEach(function (course) {
    if (course.id === editingCourseId) {
      list.appendChild(buildCourseEditCard(course));
    } else {
      list.appendChild(buildCourseCard(course));
    }
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
}

// ---- 进度总览（缺口 + 选课结论 + GPA） ----

function renderOverview() {
  const box = document.getElementById("overview");
  if (!box) return;

  box.innerHTML = "";

  if (gapStats.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "先创建板块并录入课程，这里会显示每个板块还差多少学分。";
    box.appendChild(empty);
  } else {
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
        message = "这个板块还没填要求学分，暂时不参与缺口计算。";
      } else if (stat.gap > 0) {
        head.appendChild(makeBadge("还差 " + formatNumber(stat.gap) + " 学分", "badge-fail"));
        message = "需从计划修课程中自行挑选，修满 " + formatNumber(stat.gap) + " 学分。";
      } else {
        const extra = stat.doneCredits - stat.requiredCredits;
        head.appendChild(makeBadge("已修够", "badge-done"));
        message = extra > 0
          ? "已修够（超出 " + formatNumber(extra) + " 学分），这个板块的课不必再选。"
          : "已修够，这个板块的课不必再选。";
      }

      row.appendChild(head);

      const text = document.createElement("p");
      text.className = "overview-message";
      text.textContent = message;
      row.appendChild(text);

      if (stat.note) {
        const note = document.createElement("p");
        note.className = "card-note";
        note.textContent = "特殊条件：" + stat.note;
        row.appendChild(note);
      }

      if (stat.plannedCourses.length > 0) {
        const planned = document.createElement("p");
        planned.className = "overview-planned";
        planned.textContent = "计划修课程：" + stat.plannedCourses.map(function (c) {
          return c.name + "（" + c.credits + " 学分）";
        }).join("、") + (stat.gap !== null && stat.gap === 0 ? " —— 可以不用选" : "");
        row.appendChild(planned);
      }

      box.appendChild(row);
    });
  }

  // 数字区
  const overall = calcOverall(state, gpaRule);

  const totalBox = document.getElementById("stat-total");
  if (totalBox) totalBox.textContent = formatNumber(overall.totalCredits);

  const averageBox = document.getElementById("stat-average");
  if (averageBox) averageBox.textContent = formatNumber(overall.weightedAvg);

  const gpaBox = document.getElementById("stat-gpa");
  if (gpaBox) gpaBox.textContent = formatNumber(overall.gpa);
}

// ---- 事件 ----

function applyCategoryResult(result) {
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
  const categoryForm = document.getElementById("category-form");
  if (categoryForm) {
    categoryForm.addEventListener("submit", function (event) {
      event.preventDefault();
      const creditsRaw = document.getElementById("category-credits").value.trim();
      const input = {
        name: document.getElementById("category-name").value,
        requiredCredits: creditsRaw === "" ? null : Number(creditsRaw),
        note: document.getElementById("category-note").value
      };

      if (applyCategoryResult(addCategory(state, input))) {
        categoryForm.reset();
      }
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

      if (action === "delete") {
        const affected = findCategoryCourses(state, id).length;
        const message = affected > 0
          ? "该板块下有 " + affected + " 门课程，删除后这些课程会变成“未归类”。确定删除？"
          : "确定删除这个板块？";
        if (!window.confirm(message)) return;
        applyCategoryResult(removeCategory(state, id));
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

      if (applyCourseResult(addCourse(state, input))) {
        courseForm.reset();
        renderCategoryOptions();
        if (statusInput && scoreInput) {
          scoreInput.disabled = statusInput.value !== "done";
        }
      }
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
        if (!window.confirm("确定删除这门课程？")) return;
        applyCourseResult(removeCourse(state, id));
      }
    });
  }

  // GPA 换算规则切换
  const ruleSelect = document.getElementById("gpa-rule");
  if (ruleSelect) {
    ruleSelect.value = gpaRule;
    ruleSelect.addEventListener("change", function () {
      gpaRule = ruleSelect.value;
      renderOverview();
    });
  }
}

document.addEventListener("DOMContentLoaded", function () {
  const result = CreditPlanner.loadData();
  state = result.data;

  if (result.error) {
    showStorageError(result.error);
  }

  renderAll();
  bindEvents();
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
  calcOverall: calcOverall,
  gradePoint: gradePoint,
  cloneData: cloneData
};
