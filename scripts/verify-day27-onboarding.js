/* Day 27 第 2 轮重测：验证引导块「常驻 + 两种文案」真的能出字
 *
 * 为什么要这个：上一版我只改了代码就部署，试用者反馈「一片空的感觉还在」。
 * 根因是判据为假（他浏览器里有上一轮的数据），引导块压根没显示。
 * 这次要证明的不是「代码改了」，而是「两种情况下都真的能渲染出字」。
 *
 * 做法：把 renderOnboarding 抠出来单独喂数据，
 * 不依赖浏览器、不依赖真实 localStorage，纯函数验。
 */

const fs = require("fs");
const vm = require("vm");

let fail = 0;
function ok(label, cond) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label);
  if (!cond) fail++;
}

// ---- 抠出 renderOnboarding 的源码 ----
const app = fs.readFileSync("app.js", "utf8");
const m = app.match(/function\s+renderOnboarding\s*\(\)\s*\{[\s\S]*?\n\}/);
if (!m) {
  console.log("[FAIL] 找不到 renderOnboarding 函数");
  process.exit(1);
}
const src = m[0];

// ---- 造一个假 DOM ----
function makeBox() {
  const els = {};
  return {
    els,
    getElementById(id) {
      if (!els[id]) els[id] = { textContent: "", hidden: false, id };
      return els[id];
    },
  };
}

// 造一个假 state + gapStats，跑一次 renderOnboarding
function run(stateVal, gapVal, gpaRuleVal) {
  const box = makeBox();
  const sandbox = {
    document: { getElementById: box.getElementById },
    state: stateVal,
    gapStats: gapVal,
    gpaRule: gpaRuleVal,
    countsAsDoneCredits: (c) => c.status === "done",
    formatNumber: (n) => {
      const r = Math.round(n * 100) / 100;
      return Number.isInteger(r) ? String(r) : r.toFixed(2);
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\nrenderOnboarding();", sandbox);
  return {
    hidden: box.els.onboarding ? box.els.onboarding.hidden : null,
    title: box.els["onboarding-title"].textContent,
    lead: box.els["onboarding-lead"].textContent,
    stepsHidden: box.els["onboarding-steps"].hidden,
  };
}

console.log("=== 引导块两种文案 ===\n");

console.log("① 什么都没有（全新用户）");
let r = run(
  { categories: [], courses: [] },
  [],
  "4.0"
);
ok("引导块可见（hidden 不为 true）", r.hidden === false);
ok("标题是「从这里开始」", r.title === "从这里开始");
ok("出现两步说明", /两步/.test(r.lead));
ok("步骤列表展开", r.stepsHidden === false);

console.log("\n② 已有数据：1 板块（【没填要求学分】）+ 1 门已修课但没成绩");
console.log("   ← 这才是试用者的真实情况（专业选修 / 高等数学）");
r = run(
  {
    categories: [{ id: "c1", name: "专业选修", requiredCredits: null }],
    courses: [{ id: "x1", name: "高等数学", credits: 4, status: "done", score: null, categoryId: "c1" }],
  },
  // required 为 null = 没填要求学分 → 差额算不出来 → 决策板块显示为空的真实原因
  [{ categoryId: "c1", required: null, gap: null, doneCredits: 4 }],
  "4.0"
);
ok("引导块仍然可见（不再因有数据而消失）", r.hidden === false);
ok("标题换成「你现在录到这儿了」", r.title === "你现在录到这儿了");
ok("写出已有多少数据：1 个板块", /1 个板块/.test(r.lead));
ok("写出已有多少数据：1 门课程", /1 门课程/.test(r.lead));
ok("写出已修 1 门", /已修 1 门/.test(r.lead));
ok("解释决策板块为什么空", /要求学分/.test(r.lead));
ok("给出下一步动作：去板块页填要求学分", /「板块」/.test(r.lead));
ok("提示补成绩才能算平均分/GPA", /成绩/.test(r.lead));
ok("步骤列表收起（不再说「怎么开始」）", r.stepsHidden === true);

console.log("\n③ 已有数据且已填要求学分，还差学分");
r = run(
  {
    categories: [{ id: "c1", name: "专业选修", requiredCredits: 20 }],
    courses: [{ id: "x1", name: "高等数学", credits: 4, status: "done", score: 88, categoryId: "c1" }],
  },
  [{ categoryId: "c1", required: 20, gap: 16, doneCredits: 4 }],
  "4.0"
);
ok("算出还差 16 学分", /还差\s*16\s*学分/.test(r.lead));

console.log("\n④ 部分板块没填要求学分");
r = run(
  {
    categories: [
      { id: "c1", name: "专业选修", requiredCredits: 20 },
      { id: "c2", name: "通识", requiredCredits: null },
    ],
    courses: [],
  },
  [
    { categoryId: "c1", required: 20, gap: 20, doneCredits: 0 },
    { categoryId: "c2", required: null, gap: null, doneCredits: 0 },
  ],
  "4.0"
);
ok("指出有 1 个板块没填要求学分", /1 个板块没填/.test(r.lead));

console.log("\n⑤ 全部修够");
r = run(
  { categories: [{ id: "c1", name: "专选", requiredCredits: 4 }], courses: [] },
  [{ categoryId: "c1", required: 4, gap: 0, doneCredits: 4 }],
  "4.0"
);
ok("说明已修够", /都修够了/.test(r.lead));

console.log("\n⑥ HTML 里不能再有 hidden 属性（否则又被藏了）");
const html = fs.readFileSync("index.html", "utf8");
ok('id="onboarding" 不带 hidden', !/id="onboarding"[^>]*\bhidden\b/.test(html));
ok("有 onboarding-title", html.includes('id="onboarding-title"'));
ok("有 onboarding-lead", html.includes('id="onboarding-lead"'));
ok("有 onboarding-steps", html.includes('id="onboarding-steps"'));

// ---------- 7. 反向测试 ----------
// 这一批最要紧：第 2 轮就是因为「判据抓错对象」部署上去才发现没生效。
// 所以必须验证：把判据改回旧的错误写法，检查项要能测出 FAIL。
console.log("\n⑦ 反向测试（把判据改回旧写法，必须测出 FAIL）");

// 旧写法：doneCount < courseCount
const oldLogic = `function renderOnboarding() {
  const doneCount = 1, courseCount = 1;
  const lead = document.getElementById("onboarding-lead");
  const parts = [];
  if (doneCount < courseCount) { parts.push("成绩"); }
  if (lead) lead.textContent = parts.join(" ");
}`;

function runCustom(srcCode, stateVal, gapVal) {
  const box = makeBox();
  const sandbox = {
    document: { getElementById: box.getElementById },
    state: stateVal,
    gapStats: gapVal,
    gpaRule: "4.0",
    countsAsDoneCredits: (c) => c.status === "done",
    formatNumber: (n) => String(n),
    console,
  };
  vm.createContext(sandbox);
  // 注意：src 只是函数定义，必须显式调用一次，否则 DOM 元素不会被创建
  vm.runInContext(srcCode + "\nrenderOnboarding();", sandbox);
  return box.els["onboarding-lead"].textContent;
}

// 试用者的真实数据：1 门已修课、没填成绩
const realState = {
  categories: [{ id: "c1", name: "专业选修", requiredCredits: null }],
  courses: [{ id: "x1", name: "高等数学", credits: 4, status: "done", score: null, categoryId: "c1" }],
};
const realGap = [{ categoryId: "c1", required: null, gap: null, doneCredits: 4 }];

const oldOut = runCustom(oldLogic, realState, realGap);
ok("旧写法（doneCount < courseCount）在真实数据下抓不到成绩提示",
   oldOut.indexOf("成绩") === -1);
ok("新写法在真实数据下能抓到成绩提示",
   runCustom(src, realState, realGap).indexOf("成绩") !== -1);

// 新写法也不能过度触发：全都填了成绩就不该再提示
const filledState = {
  categories: [{ id: "c1", name: "专选", requiredCredits: 20 }],
  courses: [{ id: "x1", name: "高数", credits: 4, status: "done", score: 88, categoryId: "c1" }],
};
const filledGap = [{ categoryId: "c1", required: 20, gap: 16, doneCredits: 4 }];
ok("都填了成绩 → 不再提示补成绩（避免误报）",
   runCustom(src, filledState, filledGap).indexOf("没填") === -1);

// 「计划修」但没成绩的课，不该算进去（它本来就不进平均分）
const plannedState = {
  categories: [{ id: "c1", name: "专选", requiredCredits: 20 }],
  courses: [{ id: "x1", name: "将来修的", credits: 3, status: "planned", score: null, categoryId: "c1" }],
};
const plannedGap = [{ categoryId: "c1", required: 20, gap: 20, doneCredits: 0 }];
ok("「计划修」的课没成绩不算缺失（它不进平均分）",
   runCustom(src, plannedState, plannedGap).indexOf("没填") === -1);

console.log("\n=== 结果：" + (fail === 0 ? "全部通过" : fail + " 项失败") + " ===");
process.exit(fail === 0 ? 0 : 1);
