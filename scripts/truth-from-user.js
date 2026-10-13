/**
 * scripts/truth-from-user.js
 * 把**用户亲手整理的**培养方案归属表转成 JSON 真值。
 *
 * 【为什么这份最重要】
 * 用户自己对着 PDF 整理了 100 门课的完整归属（4 大类 / 14 板块 / 要求学分）。
 * 这是**唯一的权威答案**——比 PDF 原文更好用（PDF 的合并单元格位置不固定，
 * 靠坐标重建表格一直出错）。
 *
 * 它同时承担两个角色：
 *  ① **真值**：自动识别准不准，拿它一跑就知道
 *  ② **兜底数据源**：万一某天解析器又坏了，至少还有一份正确数据可用
 *
 * ⚠️ 以后「自动识别」好不好，只能用这份表验收 —— 不许只看一两个例子。
 */
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2] || "C://Users//w3224//Desktop//新建 文本文档 (2).txt";
const OUT = path.resolve(__dirname, "..", "db", "truth-curriculum.json");

const raw = fs.readFileSync(SRC, "utf8");

/** 已知板块（从这份文件里读出来的，名字必须与 PDF 原文一致）*/
const CATS = {
  "通识教育": { required: 50.5, subs: [
    "通识教育必修课程组（二）", "通识教育选修课程",
    "通识教育必修课程组（一）（2025 级）（本科生院）",
    "通识教育选择性必修课程组 （2025 级）",
  ]},
  "（大类）学科基础": { required: 36, subs: [
    "新生研讨课程", "（大类）学科基础必修课程",
    "“AI+”课程", "（大类）学科基础选修课程",
  ]},
  "专业教育": { required: 59, subs: [
    "专业核心课程", "综合实践课程",
    "专业选修课程（天体物理与理论方向）",
    "专业选修课程（天文数据处理方向）",
    "专业选修课程（天文实验与实践方向）",
  ]},
  "拓展教育": { required: 4, subs: [
    "拓展教育课程",
  ]},
};

// 板块名 → 规范名（用户的文件里有些空格/引号差异，统一掉）
//
// ⚠️ 教训（今天又踩了一次）：归一化函数会**改变长度或字符**，
//   所以 `CATS` 的键名必须用**同一套归一化后的形式**，不能手写。
//   第一版我把中文括号也转成半角，结果 `（大类）学科基础` → `(大类)学科基础`，
//   和手写的键名对不上 → 「未识别的大类」+ 后面 null 报错。
//   现在从 CATS 的键名反推规范名，不再手写第二份。
function norm(s) {
  return s.replace(/\s+/g, "")
          .replace(/[“”]/g, '"')
          .replace(/：/g, ":")
          .replace(/^["']|["']$/g, "");
}
// 预先算出「归一化后」的大类名 → 原始名 的映射
const MAJOR_KEYS = {};
Object.keys(CATS).forEach((k) => { MAJOR_KEYS[norm(k)] = k; });
// 板块名同理：归一化 → 原始
const SUB_KEYS = {};
Object.keys(CATS).forEach((k) => {
  CATS[k].subs.forEach((s) => { SUB_KEYS[norm(s)] = s; });
});

const out = { major: {}, cats: [], generatedFrom: SRC, note: "用户亲手整理，Day 28" };
let currentMajor = null;
let currentCat = null;

raw.split(/\r?\n/).forEach((line) => {
  const t = line.trim();
  if (!t) return;

  // 一级：一，通识教育(要求学分:50.5）
  let m = t.match(/^([一二三四五六七八九十]+)\s*[，,]\s*(.+?)\(?要求学分\s*:?\s*([\d.]+)/);
  if (m) {
    const key = MAJOR_KEYS[norm(m[2])];
    currentMajor = key || null;
    if (!key) { console.error("⚠ 未识别的大类：" + m[2]); return; }
    out.major[key] = { required: Number(m[3]), subs: CATS[key].subs.slice() };
    currentCat = null;
    return;
  }

  // 二级：  1.通识教育必修课程组（二）(要求学分:3.5）
  m = t.match(/^\d+\s*[.、]\s*(.+?)\(?要求学分\s*:?\s*([\d.]+)/);
  if (m && currentMajor) {
    const canon = SUB_KEYS[norm(m[1])];
    if (!canon) {
      console.error("⚠ 未匹配的板块：" + m[1] + "（大类 " + currentMajor + "）");
      return;
    }
    currentCat = norm(canon);
    out.cats.push({
      major: currentMajor,
      name: canon,
      required: Number(m[2]),
      courses: [],
    });
    return;
  }

  // 三级：    A.量子力学 A
  m = t.match(/^[A-Z][0-9]?\s*[.、]\s*(.+)$/);
  if (m && currentCat) {
    const cat = out.cats[out.cats.length - 1];
    if (!cat || norm(cat.name) !== currentCat) return;
    cat.courses.push(m[1].replace(/\s+/g, " ").trim());
    return;
  }
});

const total = out.cats.reduce((a, c) => a + c.courses.length, 0);
console.log("大类 " + Object.keys(out.major).length + " 个　板块 " + out.cats.length +
  " 个　课程 " + total + " 门");
out.cats.forEach((c) => {
  console.log("  " + c.major + " / " + c.name + "(" + c.required + ")" +
    "  " + c.courses.length + " 门");
});
console.log("\n已写出 " + OUT);
fs.writeFileSync(OUT, JSON.stringify(out, null, 2), "utf8");
