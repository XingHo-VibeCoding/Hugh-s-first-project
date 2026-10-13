#!/usr/bin/env node
/**
 * scripts/apply-user-fixes.js —— 把用户在校对表 G 列的批注，落成「最终归属清单」
 *
 * 【为什么要有这个】
 * 用户逐段核对 PDF 后，在 G 列写了正确归属（还会指出
 * 「这不是课程」「这两门其实是同一门」「名字应该是 XXX」）。
 * 那些批注是**最可靠的一手信息**——比我的启发式可靠得多。
 * 这个脚本把批注整理成一份可直接照着导入的清单。
 *
 * 【重要原则：不猜】
 * 用户没提到的段，一律标「按候选」而不是替他决定。
 * 宁可留空让人看，也不填一个看起来对的错答案。
 *
 * 用法：node scripts/apply-user-fixes.js
 */
const fs = require("fs");

const SHEET = "C:/Users/w3224/Desktop/deploy/板块归属对照表.csv";
const OUT = "C:/Users/w3224/Desktop/deploy/最终板块归属清单.tsv";

function parseCSV(text) {
  const rows = []; let row = []; let cur = ""; let inq = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inq) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else inq = false; }
      else cur += c;
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

const rows = parseCSV(fs.readFileSync(SHEET, "utf8").replace(/^\uFEFF/, ""));

// ── 人工核对结论（来自用户 G 列批注 + 第9页复查）────────────────────
// 每条写明：课程 → 正确板块。**没写到的课程一律不猜。**
const FIX = {
  // 段2：「涯规划」和「新生研讨与职业生」是**同一门课**被拆成两行
  2: {
    note: "「涯规划」+「新生研讨与职业生」= 同一门（新生研讨与职业生涯规划）",
    cat: "新生研讨课程",
    merge: ["涯规划", "新生研讨与职业生"],
  },
  3: { cat: "通识教育必修课程组（二）" },
  // 段4：是**两门课**被拼成一行
  4: {
    note: "应为两门：人工智能通识集中实践（理工农医类）/ 人工智能通识（理工农医类）",
    cat: "通识教育必修课程组（二）",
    split: "人工智能通识集中人工智能通识（理实践（理工农医工农医类）类）",
  },
  // 段5~8：根本不是课程
  5: { drop: "这不是课程（培养方案的表格标题行）" },
  6: { drop: "不是课程——学科专业课程如何有效支撑培养目标及毕业要求（说明文字）" },
  7: { drop: "不是课程——同上，说明文字" },
  8: { drop: "不是课程——同上，说明文字" },
  // 段10：综合实践课程里混了专业核心课程（**因为跨页被切开**）
  10: {
    note: "跨页被切开：天体物理导论(2)/实测天体物理/天体物理导论(1)/热力学与统计物理 这4门属专业核心课程",
    reassign: {
      "天体物理导论(2)": "专业核心课程",
      "实测天体物理": "专业核心课程",
      "天体物理导论(1)": "专业核心课程",
      "热力学与统计物理": "专业核心课程",
    },
  },
  11: {
    reassign: {
      "广义相对论基础": "专业选修课程（天体物理与理论方向）",
      "高能天体物理": "专业选修课程（天文数据处理方向）",
    },
  },
  12: {
    note: "「大学物理物理学A：原子」应为「大学物理A：原子物理学」",
    fixName: { "大学物理物理学A：原子": "大学物理A：原子物理学" },
    reassign: {
      "电动力学综合训练": "拓展教育课程",
      "普通物理综合训练": "拓展教育课程",
      "量子力学综合训练": "拓展教育课程",
      "星系宇宙学": "拓展教育课程",
      "天体物理前沿专题讲座": "拓展教育课程",
      "天体辐射机制": "拓展教育课程",
      "概率论与数理统计B": "（大类）学科基础必修课程",
      "大学物理物理学A：原子": "（大类）学科基础必修课程",
      "大学物理A：力学": "（大类）学科基础必修课程",
      "大学物理A：光学": "（大类）学科基础必修课程",
    },
  },
  13: {
    note: "AI与天文数据分析属「AI+」课程（要求学分 2）——原PDF 里有独立分组",
    reassign: { "AI与天文数据分析": "AI+课程" },
  },
  14: {
    note: "切段时把「大学生创新创业教育（2）」的括号内容并进了名字；「大学英语读写（2）」是补的",
    cat: "通识教育必修课程组（一）",
    fixName: { "大学生创新创业教（育2）": "大学生创新创业教育（2）" },
    // ⚠️ 只补**确实漏掉**的那 1 门。
    //   「大学英语读写（3）」本来就在 courses 里（段14 只抓到 2 门：
    //   「大学生创新创业教（育2）」和「大学英语读写（3）」），
    //   再补一次会出现重复 —— 第一版就是这么错的，
    //   结果段14 出现两个「大学英语读写（3）」，总数虚增到 100。
    add: ["大学英语读写（2）"],
  },
  15: {
    reassign: {
      "体育（4）": "通识教育必修课程组（一）",
      "光电子学基础": "专业选修课程（天文实验与实践方向）",
      "大学物理实验A(3)": "专业选修课程（天文实验与实践方向）",
      "计算物理": "专业选修课程（天文数据处理方向）",
      "计算物理实验（1）": "专业选修课程（天文数据处理方向）",
      "近代物理实验（2）": "专业选修课程（天文实验与实践方向）",
    },
  },
  16: { drop: "PDF 里没有这堂课（切错了）" },
  17: {
    note: "应为两门：高能天体物理数据处理 / 恒星结构与演化",
    split: "高能天体物理数据恒星结构与演化",
    reassign: {
      "高能天体物理数据处理": "专业选修课程（天文数据处理方向）",
      "恒星结构与演化": "拓展教育课程",
    },
  },
  18: { cat: "专业选修课程（天体物理与理论方向）" },
  19: { reassign: { "理论天体物理": "拓展教育课程" } },
  20: {
    note: "应为「高能天体物理数据处理实验」",
    fixName: { "处理实验": "高能天体物理数据处理实验" },
    cat: "专业选修课程（天文数据处理方向）",
  },
  21: {
    reassign: {
      "等离子体天体物理": "拓展教育课程",
      "专业英语": "专业选修课程（天文实验与实践方向）",
      "射电天文学": "专业选修课程（天体物理与理论方向）",
      "光电子技术实验": "专业选修课程（天文实验与实践方向）",
      "天体光谱学": "专业选修课程（天体物理与理论方向）",
      "天体力学基础": "专业选修课程（天文数据处理方向）",
    },
  },
  23: {
    note: "形势与政策(1)~(8) 与 其他属通识教育必修一组；新中国史/党史/改革开放史/社会主义发展史属选择性必修",
    // ⚠️ 三处**实测查证过**的修（不是猜，坐标见 SECTION_TRUTH.md）：
    //  ① 「形势与政策（形势与政策（86））」→ 两行被拼在一起，真名「形势与政策（6）」
    //  ② 「习近平新时代中国」(y=200) + 「特色社会主义思想」(y=212) = **同一门课**
    //     → 「习近平新时代中国特色社会主义思想概论」（学分行在 y=212，3.0 学分）
    //  ③ 「特色社会主义思想毛泽东思想和中国概论」= **两门课被粘在一起**：
    //       y=244「特色社会主义理论」+ y=256「体系概论」 → 特色社会主义理论体系概论
    //       y=232「毛泽东思想和中国」+ y=224「概论」       → 毛泽东思想和中国概论
    //     → 拆成两门：前者在 courses 里已有（不用管），后者是**新增**
    fixName: {
      "形势与政策（形势与政策（86））": "形势与政策（6）",
      "习近平新时代中国": "",
      "特色社会主义思想毛泽东思想和中国概论": "",
    },
    splitInto: [
      ["特色社会主义理论体系概论", "通识教育必修课程组（一）", "从粘连里拆出：y=244+y=256"],
      ["毛泽东思想和中国概论", "通识教育必修课程组（一）", "从粘连里拆出：y=232+y=224"],
    ],
    reassign: {
      "形势与政策（形势与政策（86））": "通识教育必修课程组（一）",
      "形势与政策（1）": "通识教育必修课程组（一）",
      "形势与政策（2）": "通识教育必修课程组（一）",
      "形势与政策（3）": "通识教育必修课程组（一）",
      "形势与政策（4）": "通识教育必修课程组（一）",
      "形势与政策（5）": "通识教育必修课程组（一）",
      "形势与政策（7）": "通识教育必修课程组（一）",
      "形势与政策（8）": "通识教育必修课程组（一）",
      "习近平新时代中国特色社会主义思想概论": "通识教育必修课程组（一）",
      "习近平新时代中国": "通识教育必修课程组（一）",
      "特色社会主义思想毛泽东思想和中国概论": "通识教育必修课程组（一）",
      // 「思想政治」类按用户批注：新中国史/党史/改革开放史/社会主义发展史 → 选择性必修
      "改革开放史": "通识教育选择性必修课程组",
      "社会主义发展史": "通识教育选择性必修课程组",
      "党史": "通识教育选择性必修课程组",
      "新中国史": "通识教育选择性必修课程组",
      // 其余思政/理论课 → 必修一组
      "中华民族共同体概论": "通识教育必修课程组（一）",
      "马克思主义基本原理": "通识教育必修课程组（一）",
      "思想道德与法治": "通识教育必修课程组（一）",
      "中国近现代史纲要": "通识教育必修课程组（一）",
      "特色社会主义理论体系概论": "通识教育必修课程组（一）",
    },
    add: ["形势与政策（7）", "形势与政策（8）"],
  },
};

// 第 9 页那6 门 —— 用户指出「我好像没有」，实测确实在
//
// ⚠️ **第 9 页是独立的表格**，不是第 8 页的延续 —— 实测第9 页打印结果：
//   y=295 [163]「（大类）学科基础选修课程」  ← 它自己的类别列
//   y=125 [358]「思政实践」 [483]"2.0"
//   y=150 [349]「国家安全教育」 [483]"1.0"
//   y=180 [358]「军事理论」 [483]"2.0"
//   y=210 [349]「军事技能训练」 [483]"2.0"
//   y=235 [340]「大学生心理健康教」 + y=245 [363]「育实践」  ← **折行**
//   y=260 [340]「大学生心理健康教」 + y=270 [363]「育理论」  ← **折行**
// 所以这 6 门**学分从 x=483 列读，不是猜的**；
// 而「大学生心理健康教育实践/理论」的名字**要合并两行**。
const PAGE9 = [
  ["思政实践", "2.0", "（大类）学科基础选修课程"],
  ["国家安全教育", "1.0", "（大类）学科基础选修课程"],
  ["军事理论", "2.0", "（大类）学科基础选修课程"],
  ["军事技能训练", "2.0", "（大类）学科基础选修课程"],
  ["大学生心理健康教育实践", "1.0", "（大类）学科基础选修课程"],
  ["大学生心理健康教育理论", "1.0", "（大类）学科基础选修课程"],
];

const KNOWN_CATS = [
  "（大类）学科基础必修课程", "（大类）学科基础选修课程", "专业核心课程",
  "通识教育必修课程组（一）", "通识教育必修课程组（二）", "通识教育选择性必修课程组",
  "通识教育选修课程", "新生研讨课程", "综合实践课程", "拓展教育课程", "AI+课程",
  "专业选修课程（天文数据处理方向）", "专业选修课程（天文实验与实践方向）",
  "专业选修课程（天体物理与理论方向）",
];

const out = [];
const stats = { fixed: 0, byCandidate: 0, drop: 0, unresolved: 0 };

rows.slice(1).forEach((r) => {
  const segNo = Number(r[0]);
  if (!segNo) return;
  const cands = (r[3] || "").split(/\s*\|\s*/).filter(Boolean);
  const fx = FIX[segNo];
  const courses = (r[4] || "").split(" / ").map((s) => s.trim()).filter(Boolean);

  // 整段丢弃
  if (fx && fx.drop) {
    stats.drop += courses.length;
    out.push(["段" + segNo, "页" + r[1], "0", "（丢弃）", fx.drop, ""].join("\t"));
    return;
  }

const emit = (name, cat, note) => {
  const renamed = fx && fx.fixName ? fx.fixName[name] : undefined;
  // fixName 里给空字符串 = 这一行是错的（比如两门课被粘成一行），丢掉
  if (renamed === "") {
    stats.drop++;
    out.push(["段" + segNo, "页" + r[1], "0", "（丢弃）", name, "两行粘在一起，不是独立课程"].join("\t"));
    return;
  }
  const fixedName = renamed || name;
  const fixedCat = (fx && fx.reassign && fx.reassign[name]) || cat;
  stats.fixed++;
  out.push(["段" + segNo, "页" + r[1], "0", fixedCat, fixedName, note || ""].join("\t"));
};

  // 段级指定板块
  if (fx && fx.cat) {
    // 段4/17 是「一门被拼成两门」，需要拆
    if (fx.split) {
      out.push(["段" + segNo, "页" + r[1], "0", fx.cat, "⚠需拆成两门", fx.note || ""].join("\t"));
      (fx.reassign ? Object.keys(fx.reassign) : []).forEach((n) => emit(n, fx.cat, fx.note));
      return;
    }
    if (fx.merge) {
      stats.drop++;
      out.push(["段" + segNo, "页" + r[1], "0", "（合并）", fx.merge.join(" + "), fx.note || ""].join("\t"));
    }
    courses.forEach((c) => {
      const nm = c.replace(/\s+[\d.]+$/, "");
      if (fx.merge && fx.merge.some((m) => nm.indexOf(m) >= 0)) return;
      emit(nm, fx.cat, fx.note);
    });
    if (fx.add) fx.add.forEach((a) => emit(a, fx.cat, "补：切段时漏了"));
    return;
  }

  // 有 reassign：逐门定
  if (fx && fx.reassign) {
    courses.forEach((c) => {
      const nm = c.replace(/\s+[\d.]+$/, "");
      // ⚠️ key 匹配必须**优先全等**，再退回包含。
      //   用包含的话，「形势与政策（形势与政策（86））」会先命中 key
      //   「形势与政策（1）」… 之类的前缀，导致 fixName 查不到、改名失效。
      const keys = Object.keys(fx.reassign);
      const exact = keys.find((k) => k === nm);
      const hit = exact || keys.find((k) => nm.indexOf(k) >= 0);
      if (hit) emit(nm, fx.reassign[hit], fx.note);
      else { stats.byCandidate++; out.push(["段" + segNo, "页" + r[1], "0", cands[0] || "（按候选）", nm, "本段内其它课"].join("\t")); }
    });
    // ⚠️ reassign 分支以前**漏了 add** —— 补的课（形势与政策 7/8）压根没进结果，
    //   表现是「条目数比预期少 2」。别再漏。
    if (fx.add) {
      fx.add.forEach((a) => {
        const cat = fx.reassign[a];
        if (cat) emit(a, cat, "补：PDF 里这行没被行框框住");
        else { stats.unresolved++; out.push(["段" + segNo, "页" + r[1], "0", "⚠待定", a, "补的课但没定板块"].join("\t")); }
      });
    }
    // 粘连成一行的课要拆成多门
    // ⚠️ 只拆**清单里没有的**那门。「特色社会主义理论体系概论」courses 里本来就有
    //   （段23 抓到了它），再拆一次就重复了 —— 体检抓到「×2」。
    //   真正缺的只有「毛泽东思想和中国概论」（y=232 + y=224）。
    if (fx.splitInto) {
      const existing = new Set(courses.map((c) => c.replace(/\s+[\d.]+$/, "")));
      fx.splitInto.forEach((t) => {
        if (existing.has(t[0])) return;
        stats.fixed++;
        out.push(["段" + segNo, "页" + r[1], "0", t[1], t[0], t[2]].join("\t"));
      });
    }
    return;
  }

  // 段2：merge 特例
  if (fx && fx.merge) {
    stats.drop++;
    out.push(["段" + segNo, "页" + r[1], "0", "（合并）", fx.merge.join(" + "), fx.note].join("\t"));
    fx.merge.forEach((m) => emit(m, fx.cat, fx.note));
    courses.filter((c) => !fx.merge.some((m) => c.indexOf(m) >= 0))
      .forEach((c) => emit(c.replace(/\s+[\d.]+$/, ""), fx.cat, ""));
    return;
  }

  // 用户没批注：G 列空 → 只有一个候选就直接用
  if (cands.length === 1 && cands[0] !== "⚠ 原文读不出，请看 PDF") {
    courses.forEach((c) => { stats.fixed++; out.push(["段" + segNo, "页" + r[1], "0", cands[0], c.replace(/\s+[\d.]+$/, ""), "按唯一候选"].join("\t")); });
    return;
  }

  stats.unresolved += courses.length;
  courses.forEach((c) => {
    out.push(["段" + segNo, "页" + r[1], "0", cands.join(" | ") || "⚠读不出", c.replace(/\s+[\d.]+$/, ""), "⚠待你确认"].join("\t"));
  });
});

// 补第 9 页的 6 门
PAGE9.forEach(([name, cr, cat]) => {
  stats.fixed++;
  out.push(["补-页9", "页9", "0", cat, name, "第9页切不出行框，这6门之前漏了"].join("\t"));
});

const header = ["来源段", "页", "框高", "→ 板块", "→ 课程名", "备注"].join("\t");
fs.writeFileSync(OUT, "﻿" + header + "\n" + out.join("\n"), "utf8");

// 汇总：每个板块各多少门
const byCat = {};
out.forEach((l) => {
  const p = l.split("\t");
  const cat = p[3];
  if (!cat || cat === "（合并）" || cat === "（丢弃）") return;
  if (/\|/.test(cat) || cat.indexOf("⚠") >= 0 || cat === "（按候选）") return;
  byCat[cat] = (byCat[cat] || 0) + 1;
});

console.log("已写出 " + OUT);
console.log("条目 " + out.length + "　已定归属 " + stats.fixed +
  "　丢弃/合并 " + stats.drop + "　待确认 " + stats.unresolved);
console.log("\n=== 各板块门数 ===");
Object.keys(byCat).sort((a, b) => byCat[b] - byCat[a]).forEach((k) => {
  const known = KNOWN_CATS.indexOf(k) >= 0 ? "" : "  ⚠不在已知板块清单里";
  console.log("  " + String(byCat[k]).padStart(3) + " 门  " + k + known);
});
console.log("\n=== 待你确认的（多候选或读不出）===");
out.forEach((l) => {
  const p = l.split("\t");
  if (/\|/.test(p[3]) || p[3].indexOf("⚠") >= 0 || p[3] === "（按候选）")
    console.log("  " + p[0] + "  " + p[4] + "  → " + p[3].slice(0, 60));
});