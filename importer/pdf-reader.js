// PDF 解析 —— 把 pdf.js 输出的文字片段重组成规整的课程表
//
// ============================================================================
// 【实现前提 1：必须按页处理】
// ============================================================================
// 踩过的坑：最早把所有页的片段混在一起聚行，结果不同页的文字串到同一行，
// y 坐标完全失去意义 —— 表现为一行里塞了几十个学分数字。
// 原因：pdf.js 每页的坐标系是独立的，跨页比较 y 没有意义。
// 现在改成「先按页分组 → 页内聚行 → 页内做课程配对 → 全局按 (页, y) 排序」。
//
// ============================================================================
// 【实现前提 2：这一行结构的 y 必须一路带下来】
// ============================================================================
// rowToCells 只返回单元格数组，丢掉了行 y。
// 下游的名字配对、分类继承全靠 y 判断，y 一丢全部变undefined，
// 排序静默失效（不报错，但结果全错）。所以 pages[].rows 里存的是 {y, cells}。
//
// ============================================================================
// 【名字与学分的位置关系（实测第 5 页原样）】
// ============================================================================
//   y725 | 285>YN2530081                        ← 课程号前半
//   y719 | 340>热力学与统计物理 441>5 482>3.0 …   ← 名字 + 学分，同一行
//   y714 | 294>80012                            ← 课程号后半
//
//   y609 | 285>YN2530081  340>毕业实习与社会调    ← 名字前半
//   y604 | 441>6  482>2.0  528>48 …← 学分在下一行
//   y598 | 294>70007  371>查              ← 名字后半
//
// 结论：学分总在某一行；名字在同一行或紧邻行（上下各 1 行）。
// 所以找名字时只看本行 / 上一行 / 下一行，绝不往外找更多 ——
// 找太多会把下一门课的学分配到上一门课的名字上。
//
// ============================================================================
// 【课程名的折行】
// ============================================================================
//   「毕业实习与社会调查」被拆成三段，学分行正好夹在中间：
//     y609.2 毕业实习与社会调
//     y603.8 6 2.0 48          ← 学分
//     y598.4 查
//   所以续行可能在名字下方也可能在上方，两个方向都要试。
//
// ============================================================================
// 【分类（课程模块/课程类别）是纵向合并单元格】
// ============================================================================
// 值只写在该分组第一行，后面连续很多行都空着 → 每门课继承「上方最近的那个分类」。
// 实测第 5 页整页没有分类文字，但它的课程属于第 4 页定义的分组，
// 所以继承要跨页，不能按页重置。

var PDFReader = (function () {
  "use strict";

  // 本类 PDF 的标准行高（实测约 10.8）。
  // 「同一个单元格内折行」的行距就是一个行高，
  // 所以凡是判断「这两段文字是不是一行的」都以此为基准。
  var LINE_H = 11;

  var ROW_TOLERANCE = 3.0;    // 一行之内 y 的最大抖动
  var COL_GAP = 6.0;      // 同行内切开两列的最小 x 间隔

  // ---------- 按 y 聚成行 ----------
  function groupIntoRows(items) {
    var rows = [];
    var sorted = items.slice().sort(function (a, b) {
      if (Math.abs(b.y - a.y) > ROW_TOLERANCE) return b.y - a.y;
      return a.x - b.x;
    });
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var target = null;
      for (var r = 0; r < rows.length; r++) {
        if (Math.abs(rows[r].y - it.y) <= ROW_TOLERANCE) { target = rows[r]; break; }
      }
      if (target) {
        target.items.push(it);
        target.y = (target.y * (target.items.length - 1) + it.y) / target.items.length;
      } else {
        rows.push({ y: it.y, items: [it] });
      }
    }
    return rows;
  }

  // ---------- 行内按 x 切单元格 ----------
  function rowToCells(items) {
    var sorted = items.slice().sort(function (a, b) { return a.x - b.x; });
    var cells = [];
    var cur = null;
    var prevEnd = null;
    for (var i = 0; i < sorted.length; i++) {
      var it = sorted[i];
      var gap = prevEnd === null ? 0 : it.x - prevEnd;
      if (cur === null || gap > COL_GAP) {
        cur = { x: it.x, text: "", items: [] };
        cells.push(cur);
      }
      cur.text += it.text;
      cur.items.push(it);
      prevEnd = Math.max(prevEnd === null ? it.x + it.width : prevEnd, it.x + (it.width || 0));
    }
    return cells.map(function (c) {
      return { x: c.x, text: c.text.replace(/\s+/g, " ").trim(), items: c.items };
    });
  }

  // ---------- 从表头文字认出关键列的下标 ----------
  function colIndexes(names) {
    var idx = { name: -1, credits: -1, term: -1, code: -1, module: -1, category: -1 };
    for (var i = 0; i < names.length; i++) {
      var n = names[i];
      if (idx.name === -1 && /课程名/.test(n)) idx.name = i;
      else if (idx.credits === -1 && /学分/.test(n)) idx.credits = i;
      else if (idx.term === -1 && /学期/.test(n)) idx.term = i;
      else if (idx.code === -1 && /课程号/.test(n)) idx.code = i;
      else if (idx.module === -1 && /课程模块/.test(n)) idx.module = i;
      else if (idx.category === -1 && /课程类别/.test(n)) idx.category = i;
    }
    return idx;
  }

  function isNumeric(s) {
    return /^\d+(\.\d+)?$/.test(String(s || "").replace(/\s+/g, ""));
  }

  // ---------- 找表头（全篇搜，前面常有很长的文字介绍）----------
  function findHeader(pageRows) {
    for (var r = 0; r < pageRows.length; r++) {
      var row = pageRows[r].cells;
      if (!row || row.length < 3) continue;
      var joined = row.map(function (c) {
        return String(c.text || "").replace(/\s+/g, "");
      }).join("");
      if (/课程名/.test(joined) && /学分/.test(joined)) {
        return {
          rowIndex: r,
          cols: row.map(function (c, i) {
            return { index: i, x: c.x, name: String(c.text || "").trim() };
          })
        };
      }
    }
    return null;
  }

  /**
   * 重建表格
   * @param {Array<{pageNo, rows: Array<{y, cells}>}>} pages
   */
  function reflow(pages) {
    // 1) 找表头（跨页找）
    var header = null, headerPageIdx = -1;
    for (var p = 0; p < pages.length && !header; p++) {
      var h = findHeader(pages[p].rows);
      if (h) { header = h; headerPageIdx = p; }
    }
    if (!header) return { matrix: [], header: null };

    var colCount = header.cols.length;
    var xs = header.cols.map(function (c) { return c.x; });
    var bounds = [];
    for (var i = 0; i < xs.length - 1; i++) bounds.push((xs[i] + xs[i + 1]) / 2);

    function colOf(x) {
      for (var k = 0; k < bounds.length; k++) if (x < bounds[k]) return k;
      return bounds.length;
    }

    var ci = colIndexes(header.cols.map(function (c) {
      return c.name.replace(/\s+/g, "");
    }));

    // 2) 每页的每一行归到各列（带上 y！）
    var pagesData = [];
    for (var p2 = headerPageIdx; p2 < pages.length; p2++) {
      var rows = pages[p2].rows;
      var startRow = (p2 === headerPageIdx) ? header.rowIndex + 1 : 0;
      var grid = [];
      for (var r = startRow; r < rows.length; r++) {
        var rowCells = rows[r].cells;
        var cells = [];
        for (var c = 0; c < colCount; c++) cells.push("");
        for (var k3 = 0; k3 < rowCells.length; k3++) {
          var cell = rowCells[k3];
          var kc = colOf(cell.x);
          if (kc >= colCount) kc = colCount - 1;
          cells[kc] += cell.text;
        }
        grid.push({ y: rows[r].y, cells: cells });
      }
      pagesData.push({ pageNo: pages[p2].pageNo, grid: grid });
    }

    // 3) 「学分列是纯数字」的行 = 一门课的开始
    var anchors = [];
    pagesData.forEach(function (pd) {
      pd.grid.forEach(function (g, gi) {
        if (ci.credits >= 0 && isNumeric(g.cells[ci.credits])) {
          anchors.push({ pd: pd, grid: g, gi: gi });
        }
      });
    });

// 4) 给每个学分行配名字
    //
    // 【为什么用 gridIndex 而不是 y】
    // y 会被「学分在名字的下一行」这种情况打乱：
    // 分类文字写在该分组第一行的 y，而第一门课的记录用的是学分行的 y，
    // 两者差一个行高，结果分类永远被判为「在课程下方」。
    // 而 gridIndex 是 grid 数组的下标，顺序严格等于页面视觉顺序（自上而下），
    // 不会受学分偏移影响 —— 这是最可靠的排序依据。
    var records = [];
    var usedNameRows = new Set();

    anchors.forEach(function (a) {
      var pd = a.pd, g = a.grid, nameIdx = a.gi;

    var chosen = -1;
    // 本行 → 上一行 → 下一行。只这三个，实测够了。
  var offsets = [0, -1, 1];
      for (var oi = 0; oi < offsets.length && chosen === -1; oi++) {
      var idx = nameIdx + offsets[oi];
 if (idx < 0 || idx >= pd.grid.length) continue;
        if (usedNameRows.has(pd.pageNo + ":" + idx)) continue;
        var txt = pd.grid[idx].cells[ci.name];
        if (!txt || isNumeric(txt)) continue;
        if (/^\d{1,2}$/.test(txt)) continue;      // 修读学期那列的值
        chosen = idx;
   }
      if (chosen === -1) return;

      usedNameRows.add(pd.pageNo + ":" + chosen);
      var name = pd.grid[chosen].cells[ci.name];

// 折行的另一半
      //
      // 实测「人工智能通识集中实践（理工农医类）」被拆成三段，
      // 而学分夹在中间那段：
      //   y383.9  人工智能通识集中          ← 首段
      //   y373.1  实践（理工农医   1.0 …   ← 续段 + 学分（锚点在这行）
      //   y362.3  类）← 尾段
      //
      // 【为什么用「y 距离」判断，不能用长度】
      // 折行片段可以很长（「人工智能通识集中」8 个字），
      // 独立的课程名也可能很短（「讲座」「哲学」），
      // 只看长度会把「概率论与数理统计」和上一门课拼在一起。
      //
      // 真正可靠的判据是 **y 距离**：
      // 同一个单元格内折行，行距就是一个行高（实测约 10~11）；
      // 两门独立课程之间还隔着学分行、课程号行，距离明显更大。
      // 所以：只接 y 相差在 1.4 个行高以内的行。
      var MAX_TAIL_DIST = LINE_H * 1.4;
      // 上下两个方向都要接
      var offsets2 = [-1, 1, -2, 2, -3, 3];
      if (name.length <= 14) {
        // 上下两个方向都要接：实测「人工智能通识集中实践（理工农医类）」
        // 被拆成三段，分��在中间那段，上下各有一段：
        //   y383.9  人工智能通识集中      ← 上方，接
        //   y373.1  实践（理工农医 1.0    ← 锚点
        //   y362.3  类）← 下方，接
        // 先按距离由近及远，两边轮流试；每接一段就重新从最近的位置找起，
        // 直到再也接不上为止（最多接 3 段，防止无限拼接）。
        var joined = 0;
        var progressed = true;
        while (name.length <= 30 && joined < 3 && progressed) {
          progressed = false;
          for (var oi2 = 0; oi2 < offsets2.length; oi2++) {
            var n2 = chosen + offsets2[oi2];
            if (n2 < 0 || n2 >= pd.grid.length) continue;
            var key2 = pd.pageNo + ":" + n2;
            if (usedNameRows.has(key2)) continue;
            var cand2 = pd.grid[n2];
            // 这一行自己带学分 → 它是另一门课，不是我的续行
            if (ci.credits >= 0 && isNumeric(cand2.cells[ci.credits])) continue;
// y 距离超过一个行高 → 不是同一个单元格的折行
            var dist = Math.abs(cand2.y - g.y);
            if (dist > MAX_TAIL_DIST) continue;
            var tail = cand2.cells[ci.name];
            if (!tail || isNumeric(tail)) continue;
            if (tail.length > 12) continue;
            if (/^(课程|实验|实习|实践|训练|教育|概论|研究|分析|英语|数学|物理)/.test(tail)) continue;
            // 上方的片段拼在前面，下方的片段拼在后面
            if (offsets2[oi2] < 0) name = tail + name;
            else name = name + tail;
            usedNameRows.add(key2);
            joined++;
            progressed = true;
            break;
          }
        }
      }

  var cellsOut = g.cells.slice();
      if (ci.name >= 0) cellsOut[ci.name] = name;
      // 名字行可能带着分类信息（学分在下一行的情况），并进来
      if (chosen !== nameIdx) {
        var src = pd.grid[chosen].cells;
        [ci.module, ci.category, ci.term, ci.code].forEach(function (k) {
          if (k >= 0 && src[k] && !cellsOut[k]) cellsOut[k] = src[k];
        });
      }
      // seq = 视觉顺序（页, gridIndex），用于分类继承
      records.push({
   pageNo: pd.pageNo, cells: cellsOut, y: g.y,
        seqPage: pd.pageNo, seqIndex: nameIdx
      });
    });

    // 5) 分类继承
    //
    // 分类文字本身会折行，实测一次分组被切成好几段：
    //   「通识教育必修课程组（二）」（类别列）
    //   「(要求学」+「分」+「:3.5）」（同一列的后续行）
    //   「通识教育」+「(要求」+「学分」+「:50.5）」（模块列）
    // 所以每门课继承的不是「某一行的一个碎片」，
    // 而是「把该分组所有碎片按视觉顺序拼起来」的完整字符串。
    var CAT_EVENTS = [];
    pagesData.forEach(function (pd) {
      for (var gi = 0; gi < pd.grid.length; gi++) {
    var g = pd.grid[gi];
        var m = ci.module >= 0 ? (g.cells[ci.module] || "") : "";
        var c = ci.category >= 0 ? (g.cells[ci.category] || "") : "";
        if (!m && !c) continue;
CAT_EVENTS.push({
    pageNo: pd.pageNo, gridIndex: gi, y: g.y, module: m, category: c
        });
   }
    });
    CAT_EVENTS.sort(function (a, b) {
      if (a.pageNo !== b.pageNo) return a.pageNo - b.pageNo;
   return a.gridIndex - b.gridIndex;   // 同页：下标小 = 靠上
    });

// 把相邻的碎片行合并成一个完整分类。
    //
    // 【为什么要分列合并】
    // 「课程模块」列和「课程类别」列的碎片是**交错**在页面上的：
    //   gridIndex 30: 模块列「通识教育」  类别列「通识教育必修课程组（二）」
    //   gridIndex 31: 模块列「(要求」        类别列「(要求学」
    //   gridIndex 32: 模块列「学分」类别列「分」
    //   gridIndex 33: 模块列「:50.5）」  类别列「:3.5）」
    // 跨列拼接会得到「通识教育(要求通识教育必修课程组（二）(要求学…」这种乱码，
    // 所以两列必须各自独立合并。
    //
    // 判据：同列相邻碎片行 gridIndex 相差 <= 2（再宽就会把两个分组混起来）。
    // 把同一个单元格内的碎片合并。
    //
    // 【为什么不能用「gridIndex 相差 <= 2」】
    // 分类文字折行后，同一个分组会占好几行；但**相邻两个分组之间也只隔 1~2 行**
    // （中间是表格线的空白）。用 <= 2 会把两三个分组的碎片串成：
    //   「专业选修课程（天体物理与理论方向）(要求学分:0-18）
    //     专业选修课程（天文数据处理方向）(要求学分:0-11）
    //     专业选修课程（天文实验与实践方向）(要求学分:0-11）」
    // 于是所有课都被判成第一个方向，方向拆分就失效了。
    //
    // 正确判据是 **y 距离**：同一个单元格内折行，行距就是一个行高（约 11）。
    // 相邻分组之间还隔着课程行，距离明显更大。
    function mergeFragments(key) {
      var out = [];
      CAT_EVENTS.forEach(function (ev) {
        var frag = ev[key];
        if (!frag) return;
        var last = out[out.length - 1];
        // y 相差在 1.5 个行高内 = 同一个单元格的折行碎片
        var sameCell = last &&
          last.pageNo === ev.pageNo &&
          Math.abs(ev.y - last.lastY) <= LINE_H * 1.5;
        if (sameCell) {
          last.text += frag;
          last.lastY = ev.y;
        } else {
          out.push({
            pageNo: ev.pageNo, gridIndex: ev.gridIndex,
            lastY: ev.y, text: frag
          });
        }
      });
      return out;
    }

    var MODULE_GROUPS = mergeFragments("module");
    var CATEGORY_GROUPS = mergeFragments("category");

    // 找「视觉顺序在某门课前面、且最近的那个片段组」
    function nearestOf(groups, pageNo, gridIndex) {
      var best = null;
      for (var e = 0; e < groups.length; e++) {
        var gp = groups[e];
        var ok;
        if (gp.pageNo < pageNo) ok = true;
        else if (gp.pageNo > pageNo) ok = false;
        else ok = gp.gridIndex <= gridIndex;
        if (!ok) continue;
        if (!best) { best = gp; continue; }
        if (gp.pageNo === pageNo) {
          if (best.pageNo !== pageNo) best = gp;
          else if (gp.gridIndex > best.gridIndex) best = gp;
        } else if (best.pageNo < pageNo) {
          best = gp;
        }
      }
      return best;
    }

    records.forEach(function (r) {
      var mg = nearestOf(MODULE_GROUPS, r.seqPage, r.seqIndex);
      var cg = nearestOf(CATEGORY_GROUPS, r.seqPage, r.seqIndex);
      if (ci.module >= 0) r.cells[ci.module] = mg ? mg.text : "";
      if (ci.category >= 0) r.cells[ci.category] = cg ? cg.text : "";
    });

    // 6) 输出
    var out = [];
    out.push(header.cols.map(function (c) { return { x: c.x, text: c.name }; }));
    records.forEach(function (r) {
      out.push(r.cells.map(function (t, k) {
        return { x: header.cols[k] ? header.cols[k].x : k * 100, text: t };
      }));
    });
    return { matrix: out, header: header };
  }

  /**
   * 解析 PDF
   * @returns {Promise<{matrix, header, pages}>}
   */
  function parse(input, opts) {
    opts = opts || {};
    var pdfjsLib = window.pdfjsLib;
    if (!pdfjsLib) return Promise.reject(new Error("pdf.js 还没加载好，请检查网络后刷新页面"));

    var dataPromise = (input instanceof ArrayBuffer)
      ? Promise.resolve(new Uint8Array(input))
      : input.arrayBuffer().then(function (b) { return new Uint8Array(b); });

    return dataPromise
      .then(function (data) { return pdfjsLib.getDocument({ data: data }).promise; })
      .then(function (doc) {
        var pageCount = doc.numPages;
        var chain = Promise.resolve();
        var pages = [];

        // 【关键】逐页取、逐页聚行，绝不跨页比较坐标
        for (var p = 1; p <= pageCount; p++) {
          (function (pageNo) {
            chain = chain.then(function () {
              if (opts.onProgress) opts.onProgress(pageNo, pageCount);
              return doc.getPage(pageNo).then(function (pg) { return pg.getTextContent(); });
            }).then(function (tc) {
              var items = [];
              for (var i = 0; i < tc.items.length; i++) {
                var it = tc.items[i];
                if (it.str === undefined || !it.str || !it.str.trim()) continue;
                items.push({
                  text: it.str, x: it.transform[4], y: it.transform[5],
                  width: it.width || 0
                });
              }
pages.push({
       pageNo: pageNo,
       // 全文（含表头之前的段落）——
       // 「毕业要求修满第一课堂 148.5 学分」这类关键信息在第 3 页的正文里，
    // 不在课程表里，所以要单独留一份给对账用
       text: items.map(function (it) { return it.text; }).join(""),
           // 【关键】y 必须一起带上，下游全靠它
      rows: groupIntoRows(items).map(function (r) {
    return { y: r.y, cells: rowToCells(r.items) };
      })
              });
            });
          })(p);
        }

return chain.then(function () {
          var out = reflow(pages);
    // 全文：表头之前的段落里常有毕业要求（总学分）这类信息，
          // 课程表里没有，所以单独返回给对账用
          var fullText = pages.map(function (pg) { return pg.text || ""; }).join("");
          return {
            matrix: out.matrix,
            header: out.header,
            text: fullText,
            pages: pageCount
          };
        });
      });
  }

  function debugRows(matrix, from, count) {
    var out = [];
    for (var i = from || 0; i < Math.min(matrix.length, (from || 0) + (count || 20)); i++) {
      out.push(i + ": " + (matrix[i] || []).map(function (c) { return c.text; }).join(" | "));
    }
    return out.join("\n");
  }

  return {
    parse: parse,
    reflow: reflow,
    findHeader: findHeader,
    colIndexes: colIndexes,
    groupIntoRows: groupIntoRows,
    rowToCells: rowToCells,
    debugRows: debugRows
  };
})();

if (typeof window !== "undefined") window.PDFReader = PDFReader;
if (typeof module !== "undefined" && module.exports) module.exports = PDFReader;