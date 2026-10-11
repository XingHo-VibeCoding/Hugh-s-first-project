// 凭记忆确认已修 · 清单页（Day 26）
//
// 解决的问题：新生导入培养方案后，100 门课全是「计划修」，
// 但他其实记得自己修过其中三四十门，只是想不起是哪几门。
// 回列表一门门找，等于把导入时省下的工夫又还回去了。
//
// 【这个页面最重要的两条规则】
// 1. 不点「完成」就一个字都不写。中途关掉、刷新、误按 Esc 都不影响已有数据。
// 2. 默认全部是「还没决定」。不是默认已修 —— 手抖点错还能立刻重来，
//    反过来默认全标已修的话，用户分不清哪些是自己标的、哪些是默认的。
//
// 【键盘比鼠标快】
// 新生回忆这件事本身是连续的：一路按 y / n 比停下来点按钮顺手得多。
// 所以 j/k 或上下键移动、y 标修过、n 标没修过、回车完成。

(function () {
  "use strict";

  const state = {
    open: false,
    items: [],          // 全部待确认课程
    marks: {},          // { courseId: { isDone: bool, score: string } }
    filter: "all",      // all | todo | done
    cursor: 0,          // 当前光标位置（visibleRows 的下标）
    returnFocus: null   // 关闭后焦点还给谁
  };

  // ---------------------------------------------------------------------
  // 读取 / 写入
  // ---------------------------------------------------------------------

  function rows() {
    return Object.keys(state.marks).filter(function (id) {
      return state.marks[id].decided;
    });
  }

  function visibleRows() {
    if (state.filter === "todo") {
      return state.items.filter(function (it) { return !isMarked(it.id); });
    }
    if (state.filter === "done") {
      return state.items.filter(function (it) { return isMarked(it.id); });
    }
    return state.items;
  }

  function isMarked(id) {
    const m = state.marks[id];
    return !!(m && m.decided);
  }

  function decidedCount() {
    return state.items.filter(function (it) { return isMarked(it.id); }).length;
  }

  function doneCredits() {
    let sum = 0;
    state.items.forEach(function (it) {
      const m = state.marks[it.id];
      if (m && m.decided && m.isDone) sum += it.credits;
    });
    return sum;
  }

  // ---------------------------------------------------------------------
  // 打开 / 关闭
  // ---------------------------------------------------------------------

  function open() {
    if (state.open) return;
    if (!window.CreditApp || !window.CreditApp.listForReview) return;

    const items = window.CreditApp.listForReview() || [];
    // 示例数据模式下改了也不保存（applyReviewMarks 会拦），
    // 所以提前拦在门口，别让人白点一遍。
    // 问 app.js 要状态，不靠 DOM 嗅探 —— 示例数据 2 也有 19 门「计划修」，
    // 光看课程数判断不出来。
    if (window.CreditApp.isMockMode && window.CreditApp.isMockMode()) {
      showOutsideNote("示例数据模式下不能改课程。请先点顶部的「清除示例」回到你自己的数据。");
      return;
    }

    state.items = items;
    state.marks = {};
    state.items.forEach(function (it) {
      state.marks[it.id] = { decided: false, isDone: false, score: "" };
    });
    state.filter = "all";
    state.cursor = 0;
    state.open = true;
    state.returnFocus = document.activeElement;

    const overlay = document.getElementById("review-overlay");
    if (!overlay) return;
    overlay.hidden = false;
    document.body.classList.add("review-locked");
    render();
    // 聚焦到清单容器，才能接键盘
    const box = document.getElementById("review-list");
    if (box) box.focus();
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    const overlay = document.getElementById("review-overlay");
    if (overlay) overlay.hidden = true;
    document.body.classList.remove("review-locked");
    if (state.returnFocus && state.returnFocus.focus) state.returnFocus.focus();
  }

  // ---------------------------------------------------------------------
  // 标记
  // ---------------------------------------------------------------------

  function mark(item, isDone, advance) {
    const m = state.marks[item.id];
    if (!m) return;
    // 再点一次同一个按钮 = 撤销决定（改主意）
    if (m.decided && m.isDone === isDone) {
      m.decided = false;
      if (!isDone) m.score = "";
    } else {
      m.decided = true;
      m.isDone = isDone;
      if (!isDone) m.score = "";
    }
    if (advance) moveCursor(1);
    render();
  }

  function undoLast() {
    const vis = visibleRows();
    // 从当前光标往上找最近一个已决定的
    for (let k = state.cursor; k >= 0; k--) {
      const it = vis[k];
      if (!it) continue;
      const m = state.marks[it.id];
      if (m && m.decided) {
        m.decided = false;
        m.isDone = false;
        m.score = "";
        state.cursor = k;
        render();
        return;
      }
    }
  }

  function resetAll() {
    state.items.forEach(function (it) {
      state.marks[it.id] = { decided: false, isDone: false, score: "" };
    });
    state.cursor = 0;
    render();
  }

  function moveCursor(delta) {
    const vis = visibleRows();
    if (!vis.length) return;
    let next = state.cursor + delta;
    if (next < 0) next = 0;
    if (next > vis.length - 1) next = vis.length - 1;
    state.cursor = next;
    scrollCursorIntoView();
  }

  function jumpToNextTodo() {
    const vis = visibleRows();
    for (let k = state.cursor + 1; k < vis.length; k++) {
      if (!isMarked(vis[k].id)) {
        state.cursor = k;
        scrollCursorIntoView();
        render();
        return;
      }
    }
  }

  function scrollCursorIntoView() {
    // 渲染完再滚，所以用 requestAnimationFrame
    requestAnimationFrame(function () {
      const row = document.querySelector(".rv-row.is-cursor");
      if (row && row.scrollIntoView) {
        row.scrollIntoView({ block: "nearest" });
      }
    });
  }

  // ---------------------------------------------------------------------
  // 应用
  // ---------------------------------------------------------------------

  function confirm() {
    const marks = [];
    state.items.forEach(function (it) {
      const m = state.marks[it.id];
      if (m && m.decided) {
        marks.push({ id: it.id, isDone: m.isDone, score: m.score === "" ? null : m.score });
      }
    });

    if (!marks.length) {
      showNote("还没确认任何课程。如果这批课你确实都没修过，直接关掉就行。", true);
      return;
    }

    const result = window.CreditApp.applyReviewMarks(marks);
    if (!result.ok) {
      showNote(result.message, true);
      return;
    }
    showNote(result.message, false);
    close();
  }

  function showNote(text, isError) {
    const box = document.getElementById("review-note");
    if (!box) return;
    box.textContent = text;
    box.className = isError ? "review-note is-err" : "review-note is-ok";
    box.hidden = !text;
    if (!isError) {
      window.setTimeout(function () {
        if (box.textContent === text) {
          box.hidden = true;
          box.textContent = "";
        }
      }, 12000);
    }
  }

  // 浮层还没打开时的提示，走课程页上方的反馈条（复用现有的 #course-feedback）
  function showOutsideNote(text) {
    const box = document.getElementById("course-feedback");
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
  }

  // ---------------------------------------------------------------------
  // 渲染
  // ---------------------------------------------------------------------

  function esc(s) {
    return String(s === null || s === undefined ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render() {
    const list = document.getElementById("review-list");
    const bar = document.getElementById("review-bar");
    if (!list || !bar) return;

    const total = state.items.length;
    const decided = decidedCount();
    const dc = doneCredits();

    // ---- 顶部进度 ----
    bar.innerHTML =
      '<div class="rv-stat"><b>' + total + "</b><span>待确认课程</span></div>" +
      '<div class="rv-stat"><b>' + decided + "</b><span>已确认</span></div>" +
      '<div class="rv-stat"><b>' + (total - decided) + "</b><span>还没决定</span></div>" +
      '<div class="rv-stat is-good"><b>' + dc.toFixed(2).replace(/\.?0+$/, "") +
      "</b><span>标为已修的学分</span></div>";

    // ---- 空态：全部都已是已修 ----
    if (!total) {
      list.innerHTML =
        '<p class="rv-empty">列表里没有「计划修」的课程。<br>' +
        "如果刚导入完培养方案，先到课程页点「从培养方案导入」把它导进来。</p>";
      const actions = document.getElementById("review-actions");
      if (actions) actions.hidden = true;
      return;
    }
    const actions = document.getElementById("review-actions");
    if (actions) actions.hidden = false;

    // ---- 筛选条 ----
    const vis = visibleRows();
    let html =
      '<div class="rv-filters" role="group" aria-label="筛选课程">' +
      '<button type="button" class="rv-chip' + (state.filter === "all" ? " is-on" : "") +
      '" data-act="f-all">全部 ' + total + "</button>" +
      '<button type="button" class="rv-chip' + (state.filter === "todo" ? " is-on" : "") +
      '" data-act="f-todo">还没决定 ' + (total - decided) + "</button>" +
      '<button type="button" class="rv-chip' + (state.filter === "done" ? " is-on" : "") +
      '" data-act="f-done">已确认 ' + decided + "</button>" +
      "</div>";

    if (!vis.length) {
      html +=
        '<p class="rv-empty">' +
        (state.filter === "todo"
          ? "全部课程都确认过了，收工。"
          : "还没有确认任何课程。") +
        "</p>";
      list.innerHTML = html;
      return;
    }

    if (state.cursor >= vis.length) state.cursor = vis.length - 1;
    if (state.cursor < 0) state.cursor = 0;

    html += '<ol class="rv-rows">';
    vis.forEach(function (it, i) {
      const m = state.marks[it.id];
      const done = isMarked(it.id);
      const cls =
        "rv-row" +
        (i === state.cursor ? " is-cursor" : "") +
        (done ? (m.isDone ? " is-done" : " is-skip") : "");
      html +=
        '<li class="' + cls + '" data-id="' + esc(it.id) + '">' +
        '<div class="rv-main">' +
        '<span class="rv-name">' + esc(it.name) + "</span>" +
        '<span class="rv-meta">' +
        '<span class="rv-credits">' + it.credits + " 学分</span>" +
        (it.term ? '<span class="rv-term">推荐第 ' + esc(it.term) + " 学期</span>" : "") +
        '<span class="rv-cat">' + esc(it.categoryName) + "</span>" +
        "</span></div>" +
        '<div class="rv-btns">' +
        '<button type="button" class="rv-btn rv-yes' + (done && m.isDone ? " is-on" : "") +
        '" data-act="yes" data-id="' + esc(it.id) + '">' +
        (done && m.isDone ? "✓ 修过" : "修过") + "</button>" +
        '<button type="button" class="rv-btn rv-no' + (done && !m.isDone ? " is-on" : "") +
        '" data-act="no" data-id="' + esc(it.id) + '">' +
        (done && !m.isDone ? "✗ 没修过" : "没修过") + "</button>" +
        '<input type="number" class="rv-score" min="0" max="100" step="1" ' +
        'placeholder="成绩" value="' + esc(m.score) + '" data-score="' + esc(it.id) + '"' +
        ' aria-label="' + esc(it.name) + '的成绩">' +
        "</div></li>";
    });
    html += "</ol>";
    list.innerHTML = html;
  }

  // 只刷新顶部四个数，不重绘列表。
  // 打字时不能整体重绘 —— 那会让输入框失焦，一个字都打不进去。
  function refreshBar() {
    const bar = document.getElementById("review-bar");
    if (!bar) return;
    const total = state.items.length;
    const decided = decidedCount();
    bar.innerHTML =
      '<div class="rv-stat"><b>' + total + "</b><span>待确认课程</span></div>" +
      '<div class="rv-stat"><b>' + decided + "</b><span>已确认</span></div>" +
      '<div class="rv-stat"><b>' + (total - decided) + "</b><span>还没决定</span></div>" +
      '<div class="rv-stat is-good"><b>' + trimNum(doneCredits()) +
      "</b><span>标为已修的学分</span></div>";
    const fTodo = bar.parentNode.querySelector('[data-act="f-todo"]');
    const fDone = bar.parentNode.querySelector('[data-act="f-done"]');
    if (fTodo) fTodo.textContent = "还没决定 " + (total - decided);
    if (fDone) fDone.textContent = "已确认 " + decided;
  }

  function trimNum(n) {
    return String(Math.round(n * 100) / 100);
  }

  // ---------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------

  function bind() {
    const btn = document.getElementById("review-open");
    if (btn) btn.addEventListener("click", open);

    const overlay = document.getElementById("review-overlay");
    if (!overlay) return;

    // 点遮罩空白处不关闭 —— 避免误点丢进度。只能点按钮或按 Esc。
    overlay.addEventListener("click", function (e) {
      const act = e.target.closest("[data-act]");
      if (!act) return;
      const action = act.getAttribute("data-act");
      const id = act.getAttribute("data-id");

      switch (action) {
        case "yes": {
          const it = state.items.filter(function (x) { return x.id === id; })[0];
          if (it) mark(it, true, true);
          break;
        }
        case "no": {
          const it = state.items.filter(function (x) { return x.id === id; })[0];
          if (it) mark(it, false, true);
          break;
        }
        case "f-all": state.filter = "all"; state.cursor = 0; render(); break;
        case "f-todo": state.filter = "todo"; state.cursor = 0; render(); break;
        case "f-done": state.filter = "done"; state.cursor = 0; render(); break;
        case "confirm": confirm(); break;
        case "close": close(); break;
        case "reset": resetAll(); break;
        case "undo": undoLast(); break;
        case "next-todo": jumpToNextTodo(); render(); break;
      }
    });

    // 成绩输入框：单独用 input 事件监听，不能塞在 click 里
    // （之前塞进 click，导致输入成绩完全没反应 —— 「填了但没保存」）
    //
    // 填了成绩就默认认为修过了：用户主动填成绩，意图已经很清楚了。
    // 清空成绩则撤销这个推断（可能只是手滑填错了）。
    overlay.addEventListener("input", function (e) {
      const input = e.target.closest("[data-score]");
      if (!input) return;
      const id = input.getAttribute("data-score");
      const m = state.marks[id];
      if (!m) return;
      m.score = input.value;
      if (input.value !== "") {
        m.decided = true;
        m.isDone = true;
      } else {
        m.decided = false;
        m.isDone = false;
      }
      // 同步这一行的底色和两个按钮的高亮，不整体重绘（否则输入框失焦）
      const row = input.closest(".rv-row");
      if (row) {
        row.classList.toggle("is-done", m.decided && m.isDone);
        row.classList.toggle("is-skip", m.decided && !m.isDone);
        const yes = row.querySelector(".rv-yes");
        const no = row.querySelector(".rv-no");
        if (yes) {
          yes.classList.toggle("is-on", m.decided && m.isDone);
          yes.textContent = m.decided && m.isDone ? "✓ 修过" : "修过";
        }
        if (no) {
          no.classList.toggle("is-on", m.decided && !m.isDone);
          no.textContent = m.decided && !m.isDone ? "✗ 没修过" : "没修过";
        }
      }
      refreshBar();
    });

    overlay.addEventListener("keydown", function (e) {
      const t = e.target;
      const typing = t && (t.tagName === "INPUT" || t.tagName === "SELECT");

      if (e.key === "Escape") {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === "Enter" && !typing) {
        e.preventDefault();
        confirm();
        return;
      }
      if (typing) {
        // 在输入框里打字时只处理上下键（数字框里上下键没意义）
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          moveCursor(e.key === "ArrowDown" ? 1 : -1);
          render();
        }
        return;
      }

      const key = e.key.toLowerCase();
      if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault(); moveCursor(1); render();
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault(); moveCursor(-1); render();
      } else if (key === "y") {
        e.preventDefault();
        const it = visibleRows()[state.cursor];
        if (it) mark(it, true, true);
      } else if (key === "n") {
        e.preventDefault();
        const it = visibleRows()[state.cursor];
        if (it) mark(it, false, true);
      } else if (key === "u") {
        e.preventDefault(); undoLast();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();
