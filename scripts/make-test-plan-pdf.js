// 造一份「长得像真实培养方案」的 PDF，用来跑完整导入链路。
//
// 【为什么需要造，而不是直接用原始 PDF】
// 原始的《2025版天文学专业本科人才培养方案.pdf》现在不在电脑上了。
// 但 scripts/truth-2025.js 里存着**从那份 PDF 原图逐行核对出来的真实课程清单**
// （课程名 + 学分都是真的，是比 app.js 示例数据更权威的版本）。
//
// 【这一份能测到什么、测不到什么】
// ✅ 能测：PDF 解析（坐标 → 行 → 单元格）、表头识别、课程名/学分提取、
//         0.25 学分处理、待确认表格、确认导入、学分对账 —— 也就是完整链路
// ❌ 测不到：真实 PDF 特有的排版怪癖（合并单元格、跨页断行、字体子集乱码）
//         那些只能等找到原始 PDF 再验。
//
// 所以这份测试**不能替代**对真实文件的一次验证，只能证明「代码链路是通的」。

const fs = require("fs");
const path = require("path");

const TRUTH = require("./truth-2025.js").TRUTH_2025 || require("./truth-2025.js");

// 板块 id → 中文名 + 要求学分（与 truth-2025.js 的注释一致）
const GROUPS = [
  ["g1", "通识教育必修课程组（一）", 38],
  ["g2", "通识教育必修课程组（二）", 36],
  ["g3", "通识教育选修课程组", 12],
  ["g4", "新生研讨课程组", 2],
  ["m1", "学科基础课程组", 30],
  ["m2", "专业核心课程组", 42],
  ["m3", "专业选修课程组", 28],
  ["m4", "综合实践课程组", 16],
  ["x1", "个性发展课程组", 8],
];

// ---------- 极简 PDF 写出器 ----------
// 只做一件事：把文字画到页面上。够测试用了，不追求排版精美。
// 关键是**分列摆放**（课程名在一列、学分在另一列），
// 因为解析器的核心难点就是「用坐标把同一条记录的多个字段拼回去」。

function esc(s) {
  // PDF 字符串里 \ ( ) 要转义；中文交给外部字库，这里不用管
  return String(s).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// WinAnsi 里没有的字符 → 问号（真实中文需要嵌入字体，这里只测结构）
function toWinAnsi(s) {
  return String(s).replace(/[^\x20-\x7E]/g, "?");
}

class PdfBuilder {
  constructor() {
    this.objects = [];
  }
  add(obj) {
    this.objects.push(obj);
    return this.objects.length; // 对象号从 1 开始
  }

  build(pages) {
    // pages: [{ lines: [{x, y, size, text}] }]，y 从上往下递减
    const fontObj = this.add(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
    );

    const pageRefs = [];
    for (const pg of pages) {
      let content = "BT\n";
      for (const l of pg.lines) {
        content += `/F1 ${l.size || 11} Tf\n`;
        content += `1 0 0 1 ${l.x} ${l.y} Tm\n`;
        content += `(${esc(toWinAnsi(l.text))}) Tj\n`;
      }
      content += "ET\n";
      const contentObj = this.add(`<< /Length ${content.length} >>\nstream\n${content}endstream`);

      // ⚠️ 这里必须先 add 再取引号。
      //   踩过的坑：先算 `this.objects.length + 2` 当页号，
      //   但 pages 对象是循环结束后才 add 的，中间隔了 N 个 content 对象 ——
      //   算出来的号全错，PDF 里的 /Kids 指向不存在的对象，
      //   pdf.js 只能读到第 1 页（不报错，静默少内容，最难查）。
      const pageObjNo = this.add(
        `<< /Type /Page /Parent 0 0 R /MediaBox [0 0 595 842] ` +
          `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
      );
      pageRefs.push(pageObjNo);
    }

    const pagesObjNo2 = this.add(
      `<< /Type /Pages /Count ${pageRefs.length} /Kids [${pageRefs
        .map((r) => r + " 0 R")
        .join(" ")}] >>`
    );
    // 回填真实的 Pages 号
    pageRefs.forEach((r) => {
      this.objects[r - 1] = this.objects[r - 1].replace(
        /\/Parent 0 0 R/,
        "/Parent " + pagesObjNo2 + " 0 R"
      );
    });

    const catalogObj = this.add(
      `<< /Type /Catalog /Pages ${pagesObjNo2} 0 R >>`
    );

    let out = "%PDF-1.4\n";
    const offsets = [0];
    this.objects.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xrefPos = out.length;
    out += `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= this.objects.length; i++) {
      out += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
    }
    out += `trailer\n<< /Size ${this.objects.length + 1} /Root ${catalogObj} 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    return out;
  }
}

// ---------- 组装培养方案页面 ----------
function makePages() {
  const pages = [];
  let cur = { lines: [] };
  let y = 800;

  const put = (x, text, size) => {
    cur.lines.push({ x, y, text, size: size || 11 });
    y -= size ? size * 1.6 : 18;
  };

  const newPage = () => {
    if (cur.lines.length) pages.push(cur);
    cur = { lines: [] };
    y = 800;
  };

  put(60, "2025 Version Undergraduate Cultivation Plan", 16);
  put(60, "Astronomy Major", 13);
  put(60, "Total Credits Required: 172.0", 12);
  y -= 10;

  const COURSE_X = 60;   // 课程名列
  const CREDIT_X = 420;  // 学分列（离得足够远，必须靠坐标拼行）
  const TERM_X = 330;    // 学期列

  for (const [gid, gname, req] of GROUPS) {
    if (y < 90) newPage();
    put(60, `${gname}  (Required Credits: ${req})`, 13);
    put(COURSE_X, "Course Name", 10);
    put(TERM_X, "Term", 10);
    put(CREDIT_X, "Credits", 10);
    y -= 4;

    const list = TRUTH[gid] || [];
    let idx = 0;
    for (const item of list) {
      // 兼容 ["名称", 学分] 与 ["名称", 学分, 学期] 两种写法
      const [name, credits, term] = item;
      if (y < 70) newPage();
      const lineY = y;
      // 关键：三个字段放在同一 y、不同 x —— 解析器必须靠坐标合并
      cur.lines.push({ x: COURSE_X, y: lineY, text: name, size: 11 });
      cur.lines.push({ x: TERM_X, y: lineY, text: String(term || idx + 1), size: 11 });
      cur.lines.push({ x: CREDIT_X, y: lineY, text: String(credits), size: 11 });
      y -= 19;
      idx++;
    }
    y -= 8;
  }
  if (cur.lines.length) pages.push(cur);
  return pages;
}

const out = new PdfBuilder().build(makePages());
const target = process.argv[2] || path.join(__dirname, "..", "testdata", "培养方案-测试.pdf");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out, "latin1");

let total = 0;
for (const g of GROUPS) total += (TRUTH[g[0]] || []).length;
console.log("已生成：" + target);
console.log("页数：" + new PdfBuilder && (out.match(/\/Type \/Page[^s]/g) || []).length);
console.log("课程门数：" + total);
console.log("板块数：" + GROUPS.length);