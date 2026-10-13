/**
 * scripts/read-user-sheet.js —— 读用户在对照表 G 列填的批注
 *
 * 【为什么不直接看 CSV】
 * CSV 里那些单元格全是引号包裹的长文本，
 * 用 shell/Node -e 内联解析会被转义坑到（今天已经踩了一次：
 * 正则里的 \r\n 被 shell 吃掉，报 "Unterminated regexp literal"）。
 * 写进文件最稳。
 */
const fs = require("fs");

const PATH = process.argv[2] || "C:/Users/w3224/Desktop/deploy/板块归属对照表.csv";

function parseCSV(text) {
  const rows = [];
  let row = [];
  let cur = "";
  let inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') {
        if (text[i + 1] === '"') { cur += '"'; i++; }
        else inq = false;
      } else cur += c;
    } else {
      if (c === '"') inq = true;
      else if (c === ",") { row.push(cur); cur = ""; }
      else if (c === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; }
      else if (c === "\r") { /* ignore */ }
      else cur += c;
    }
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const rows = parseCSV(fs.readFileSync(PATH, "utf8").replace(/^\uFEFF/, ""));
console.log("表头: " + JSON.stringify(rows[0]));
console.log("数据行 " + (rows.length - 1) + "\n");

rows.slice(1).forEach((r, i) => {
  const g = (r[6] || "").trim();
  if (!g) {
    console.log("── 行" + (i + 2) + "｜段" + r[0] + "｜" + r[2] + "门｜G列空（可直接用候选）");
    return;
  }
  console.log("── 行" + (i + 2) + "｜段" + r[0] + "｜" + r[2] + "门");
  console.log("   候选: " + (r[3] || "").slice(0, 70));
  console.log("   批注: " + g);
  console.log("");
});