// 课程提取核心 —— 与文件格式无关
// 输入：已经重建好的表格矩阵（第 0 行是表头），每格 {text}
// 输出：一行行 {课程名, 学分, 板块, 学期}
//
// 实测的真实表头（云南大学 2025 天文学培养方案）：
//   课程模块 | 课程类别 | 课程号 | 课程名 | 修读学期 | 总学分 | 总学时 | 周学时
//
// 板块信息有三个来源，都要用上：
//   1. 课程类别列：「专业核心课程」这种细分
//   2. 课程模块列：「专业教育」这种大类
//   3. 文字里写的要求学分：「专业核心课程(要求学分:27）」

var ExtractorCore = (function () {
  "use strict";

  // 板块识别分两级：
//   1）严格匹配 —— 认「专业核心课程」「学科基础必修课程」这种完整名字
//   2）宽松匹配 —— 认「学科基础」「专业核心」这类简称，只在没有严格匹配时用
// 【为什么分开】
// 分类文字会折行，累积出来的碎片可能是「学分:50.5）」这种半截，
// 宽松规则一旦先命中「通识」，后面所有课程都会被误判成通识教育。
// 所以必须先跑完所有严格规则，都不中才用宽松的。
  var STRICT_MAP = [
    { name: "专业核心课程", words: ["专业核心课程"] },
    { name: "学科基础课程", words: ["学科基础必修课程", "学科基础选修课程"] },
    { name: "拓展教育课程", words: ["拓展教育课程"] },
    { name: "综合实践课程", words: ["综合实践课程"] },
    { name: "通识教育课程", words: ["通识教育必修课程组", "通识教育选择性必修课程组", "通识教育选修课程"] },
    { name: "专业选修课程", words: ["专业选修课程"] }
  ];

  var LOOSE_MAP = [
    { name: "学科基础课程", words: ["学科基础"] },
    { name: "专业核心课程", words: ["专业核心"] },
    { name: "实践教学环节", words: ["实践", "实习", "实训", "毕业实习", "科研训练"] },
    { name: "专业选修课程", words: ["专业选修"] },
    { name: "通识教育课程", words: ["通识教育", "通识必修", "通识选修"] },
    { name: "个性化教育课程", words: ["个性化教育", "拓展教育"] },
    { name: "毕业论文与设计", words: ["毕业论文", "毕业设计"] }
  ];

  function matchStrict(text) {
    if (!text) return null;
    var s = String(text);
    for (var i = 0; i < STRICT_MAP.length; i++) {
      for (var j = 0; j < STRICT_MAP[i].words.length; j++) {
        if (s.indexOf(STRICT_MAP[i].words[j]) !== -1) return STRICT_MAP[i].name;
      }
    }
    return null;
  }

  function matchLoose(text) {
    if (!text) return null;
    var s = String(text);
    for (var i = 0; i < LOOSE_MAP.length; i++) {
      for (var j = 0; j < LOOSE_MAP[i].words.length; j++) {
        if (s.indexOf(LOOSE_MAP[i].words[j]) !== -1) return LOOSE_MAP[i].name;
      }
    }
    return null;
  }

  // 对外只暴露一个：先严格后宽松
  function matchCategory(text) {
    return matchStrict(text) || matchLoose(text);
  }

  // ---- 工具 ----

  // 从一行表头文字里认出关键列的下标
  function colIndexes(headerRow) {
    var idx = { name: -1, credits: -1, term: -1, code: -1, module: -1, category: -1 };
    for (var i = 0; i < (headerRow || []).length; i++) {
      var n = String((headerRow[i] && headerRow[i].text) || "").replace(/\s+/g, "");
      if (idx.name === -1 && /课程名/.test(n)) idx.name = i;
      else if (idx.credits === -1 && /学分/.test(n)) idx.credits = i;
      else if (idx.term === -1 && /学期/.test(n)) idx.term = i;
      else if (idx.code === -1 && /课程号/.test(n)) idx.code = i;
      else if (idx.module === -1 && /课程模块/.test(n)) idx.module = i;
      else if (idx.category === -1 && /课程类别/.test(n)) idx.category = i;
    }
    return idx;
  }

  // 学分数值：允许 4 / 4.0 / 4.5 / （4.0） / 4学分
  function parseCredit(raw) {
    if (raw === undefined || raw === null) return null;
    var s = String(raw).replace(/\s+/g, "");
    if (!s) return null;
    s = s.replace(/学分/g, "").replace(/[()（）]/g, "");
    if (!/^\d{1,2}(\.\d{1,2})?$/.test(s)) return null;
    var n = Number(s);
    if (!isFinite(n) || n <= 0 || n > 30) return null;
    return n;
  }

  function looksLikeCode(raw) {
    if (!raw) return false;
    return /^[A-Za-z]{0,6}\d{6,}$/.test(String(raw).replace(/\s+/g, ""));
  }

  function cleanName(raw) {
    if (!raw) return "";
    return String(raw).replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
  }

  // 像个课程名：有中文或字母，长度 2-40，不是纯数字，不是课程代码，不带「学分」
  function looksLikeCourseName(raw) {
    var s = cleanName(raw);
    if (s.length < 2 || s.length > 40) return false;
    if (/^\d+(\.\d+)?$/.test(s)) return false;
    if (looksLikeCode(s)) return false;
    if (s.indexOf("学分") !== -1) return false;
    return /[一-龥A-Za-z]/.test(s);
  }

  // 从文字里认出板块名（旧定义已合并到上面的 matchStrict/matchLoose）

  // 抽「要求学分:27」里的数字
  function parseRequiredCredits(text) {
    if (!text) return null;
    var m = String(text).match(/要求学分\s*[:：]?\s*([\d.]+)/);
    if (m) {
      var n = Number(m[1]);
      if (isFinite(n) && n > 0) return n;
    }
    return null;
  }

  /**
   * 主入口
   * @param {Array<Array<{text}>>} matrix 第 0 行是表头的表格矩阵
   * @returns {{rows, warnings, sections, stats}}
   */
  function extractCourses(matrix) {
    var rows = [];
    var warnings = [];

    // 找表头：优先相信第 0 行，否则全篇搜一遍
    var headerIdx = 0;
    var colMap = colIndexes(matrix[0]);
    if (colMap.name === -1 || colMap.credits === -1) {
      colMap = null;
      for (var r = 0; r < Math.min(matrix.length, 500); r++) {
        var m = colIndexes(matrix[r]);
        if (m.name !== -1 && m.credits !== -1) { colMap = m; headerIdx = r; break; }
      }
    }

    if (!colMap) {
      return {
        rows: [], warnings: [{
          level: "error",
          text: "没找到课程表表头（需要同时有「课程名」和「学分」两列）。这份文件可能不是表格版培养方案。"
        }],
        stats: { headerFound: false }, sections: []
      };
    }

    function cellOf(row, idx) {
      if (idx < 0 || !row || !row[idx]) return "";
      return String(row[idx].text || "").trim();
    }

    var currentSection = null;
    var sections = {};

    for (var i = headerIdx + 1; i < matrix.length; i++) {
      var row = matrix[i] || [];
      var name = cleanName(cellOf(row, colMap.name));
      var moduleName = cellOf(row, colMap.module);
      var categoryName = cellOf(row, colMap.category);

      // 板块：这一行自己带分类文字就用它，否则沿用上方最近的
      var section = matchCategory(categoryName) || matchCategory(moduleName);

      // 板块要求学分可能写在模块或类别列里，形如「专业核心课程(要求学分:27）」
      [moduleName, categoryName].forEach(function (t) {
        var req = parseRequiredCredits(t);
        var secName = matchCategory(t);
        if (req !== null && secName) sections[secName] = Math.max(sections[secName] || 0, req);
      });

      if (section) currentSection = section;

      if (!name || !looksLikeCourseName(name)) continue;

      var credit = parseCredit(cellOf(row, colMap.credits));
      if (credit === null) {
        warnings.push({ level: "warn", text: "「" + name + "」这一行没读到学分，已跳过（没有猜）。" });
        continue;
      }

      rows.push({
        name: name,
        credits: credit,
        section: section || currentSection || null,
        term: cellOf(row, colMap.term) || null,
        code: cellOf(row, colMap.code) || null,
        raw: row.map(function (c) { return c && c.text ? c.text : ""; })
      });
    }

    if (!rows.length) {
      warnings.push({ level: "error", text: "找到表头了，但一行课程都没读出来。" });
    }

    return {
      rows: rows,
      warnings: warnings,
      sections: Object.keys(sections).map(function (k) { return { name: k, required: sections[k] }; }),
      stats: { headerFound: true, headerRow: headerIdx, colMap: colMap, totalRows: rows.length }
    };
  }

  // 从正文找文档声明的总学分，用于对账
  function findDeclaredTotal(text) {
    if (!text) return null;
    var patterns = [
      /第一课堂\s*([\d.]+)\s*学分/,
      /共需?修满\s*([\d.]+)\s*学分/,
      /修满\s*([\d.]+)\s*学分/,
      /总学分(?:为|是|：|:)?\s*([\d.]+)/
    ];
    for (var i = 0; i < patterns.length; i++) {
      var m = text.match(patterns[i]);
      if (m) {
        var n = Number(m[1]);
        if (isFinite(n) && n > 0 && n < 500) return n;
      }
    }
    return null;
  }

  return {
    extractCourses: extractCourses,
    findDeclaredTotal: findDeclaredTotal,
    colIndexes: colIndexes,
    parseCredit: parseCredit,
    parseRequiredCredits: parseRequiredCredits,
    matchCategory: matchCategory,
    matchStrict: matchStrict,
    matchLoose: matchLoose,
    cleanName: cleanName,
    STRICT_MAP: STRICT_MAP,
    LOOSE_MAP: LOOSE_MAP
  };
})();

if (typeof window !== "undefined") window.CourseExtractor = ExtractorCore;
if (typeof module !== "undefined" && module.exports) module.exports = ExtractorCore;