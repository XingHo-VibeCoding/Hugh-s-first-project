// 把新生成的课程数组写回 app.js 的 MOCK_DATA_2
const fs = require("fs");
const path = require("path");

const APP = path.join(__dirname, "..", "app.js");
let src = fs.readFileSync(APP, "utf8");
const newCourses = fs.readFileSync(process.argv[2], "utf8").trim();

// 找出 courses: [ ... ] 的范围
// 注意：app.js 是 CRLF 换行，所以不能直接用 \n 去匹配行首
const startMarker = "  courses: [";
const startIdx = src.indexOf(startMarker, src.indexOf("const MOCK_DATA_2"));
if (startIdx === -1) { console.error("找不到 courses: ["); process.exit(1); }
const bodyStart = src.indexOf("\n", startIdx) + 1;
// 数组结尾：换行 + 两个空格 + ]  + 换行 + };
const tailMatch = /\n  \]\r?\n\};/.exec(src.slice(bodyStart));
if (!tailMatch) { console.error("找不到数组结尾"); process.exit(1); }
const endIdx = bodyStart + tailMatch.index;

const before = src.slice(0, bodyStart);
const after = src.slice(endIdx);
// app.js 用 CRLF，保持一致
const newBody = newCourses.replace(/\r?\n/g, "\r\n") + "\r\n";
src = before + newBody + after;

// 同步更新注释
src = src.replace(
  /(\/\/ 示例数据 2 · 天文学专业（Day 10 追加）\n)[\s\S]*?(const MOCK_DATA_2 = \{)/,
  "$1" +
  "// 依据 2025 版培养方案原图逐行核对重建（Day 25 之后修正）：\n" +
  "//   通识必修（一）38 / 通识必修（二）3.5 / 通识选修 8 / 新生研讨 2\n" +
  "//   学科基础 36 / 专业核心 27 / 专业选修 18 / 综合实践 14 / 个性发展（留空）\n" +
  "// 98 门课程（+2 门用于测未归类的课程），学分严格取自 PDF「总学分」列。\n" +
  "// 注意：「要求学分」是「至少要修够多少」，不是该组所有课的总学分，\n" +
  "//      所以各组学分合计超过要求学分是正常的。\n" +
  "// 同一门课只录一条，板块取主要归属，不重复。\n" +
  "$2"
);

fs.writeFileSync(APP, src);
console.log("已更新 app.js：课程 " + newCourses.split("\n").length + " 行");