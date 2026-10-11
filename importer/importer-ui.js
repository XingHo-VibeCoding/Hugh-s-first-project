// 培养方案导入面板 —— 挂在课程页板块列表下方
//
// 分工：
//   本文件只负责「解析文件 → 让用户确认 → 把确认结果交给 app.js」
//   数据写入全在app.js 的 importPlanItems 里，本文件不碰 state
//
// 为什么一定要有「待确认表格」这一步：
//   解析规则再准，也不可能对所有学校的排版都适用。
//   让用户看见结果并能改，比「悄悄塞进一堆错数据」安全得多。
//   尤其是课程名和学分 —— 认错了会直接算错还差多少学分。

(function () {
  "use strict";

  const CDN_PDF = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
  const CDN_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const CDN_JSZIP = "https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js";

  let libsPromise = null;

  // 库按需加载：只有真的要用导入时才去下载，不拖慢页面首屏
  function ensureLibs() {
    if (libsPromise) return libsPromise;
    libsPromise = new Promise(function (resolve, reject) {
      const need = [];
      if (!window.pdfjsLib) needScript(CDN_PDF, need);
      if (!window.JSZip) needScript(CDN_JSZIP, need);
      if (!need.length) return resolve();

      let left = need.length;
      let failed = false;
      need.forEach(function (item) {
        item.el.addEventListener("load", function () {
          if (--left === 0 && !failed) resolve();
        });
        item.el.addEventListener("error", function () {
          if (!failed) {
            failed = true;
            reject(new Error("解析库加载失败，请检查网络后重试"));
          }
        });
      });
    });
    return libsPromise;
  }

  function needScript(src, bucket) {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    document.head.appendChild(el);
    bucket.push({ el: el });
  }

  function esc(s) {
    return String(s === undefined || s === null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---- 面板状态 ----
  let items = [];        // 解析出的课程
  let categories = [];   // 网站现有板块
  let existingNames = [];// 已有课程名，用于标重复

  function parseFile(file) {
    ensureLibs().then(function () {
      const lower = file.name.toLowerCase();
      const isPdf = /\.pdf$/.test(lower) || file.type === "application/pdf";
      const isDocx = /\.docx$/.test(lower) ||
        file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

      if (!isPdf && !isDocx) {
        return showError("目前只支持 .pdf 和 .docx。如果是老的 .doc，请先在 Word 里另存为 .docx。");
      }

      setStatus("正在解析 " + esc(file.name) + "…", "");
      if (isPdf) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = CDN_WORKER;
      }

      const job = isPdf ? window.PDFReader.parse(file) : window.DocxReader.parse(file);
      return job.then(function (res) {
        const ex = window.CourseExtractor.extractCourses(res.matrix);
        if (!ex.rows.length) {
          showError("没认出任何课程。" + (ex.warnings[0] ? ex.warnings[0].text : ""));
          return;
        }
        categories = (window.CreditApp.listCategories() || []);
        existingNames = (window.CreditApp.listExistingCourseNames() || []);
        items = ex.rows.map(function (r) {
          return {
            name: r.name,
            credits: r.credits,
            term: r.term || "",
            section: r.section || "",
            picked: true,
            dup: existingNames.indexOf(r.name) !== -1
          };
        });
        renderTable();
      });
    }).catch(function (err) {
      showError("解析失败：" + (err && err.message ? err.message : String(err)));
    });
  }

  function setStatus(text, cls) {
    const el = document.getElementById("import-status");
    if (!el) return;
    el.innerHTML = '<span class="' + (cls || "") + '">' + text + "</span>";
    el.hidden = !text;
  }

  function showError(text) {
    setStatus(text, "err");
  }

// ---- 渲染待确认表格 ----

  // 用网站自己的校验规则预检，把「导不进去」的标出来而不是静默丢弃。
  // 实测：培养方案里 8 门「形势与政策」是 0.25 学分，
  // 而现有校验只允许 0.5 的整数倍，所以会被拒绝 —— 必须让用户看见原因。
  function markBlocked() {
    if (!window.CreditApp || !window.CreditApp.validateCourse) return;
    const probe = window.CreditApp.cloneData({
      version: 1,
      categories: [{ id: "__probe", name: "__probe", requiredCredits: null, note: "" }],
      courses: []
    });
    items.forEach(function (it) {
      const chk = window.CreditApp.validateCourse({
        name: it.name,
        credits: it.credits,
        categoryId: "__probe",
        status: "planned",
        score: null
      }, probe);
      it.blocked = chk.ok ? "" : chk.error;
    });
  }

  function renderTable() {
    const box = document.getElementById("import-result");
    if (!box) return;

    markBlocked();
    openPanel();

    const picked = items.filter(function (it) { return it.picked; });
    const dupCount = picked.filter(function (it) { return it.dup; }).length;
    const noSection = picked.filter(function (it) { return !it.section; }).length;
    const blockedCount = picked.filter(function (it) { return it.blocked; }).length;
    const importable = picked.filter(function (it) { return !it.blocked; }).length;

    let html = "";

  html += '<div class="import-summary">';
    html += "<div><b>" + items.length + '</b>识别到的课程</div>';
    html += "<div><b>" + importable + "</b>可以导入</div>";
    if (dupCount) html += '<div><b class="warn-text">' + dupCount + "</b>列表里已有</div>";
    if (noSection) html += '<div><b class="warn-text">' + noSection + "</b>未归板块</div>";
    if (blockedCount) html += '<div><b class="bad-text">' + blockedCount + "</b>会被拒绝</div>";
    html += "</div>";

    if (blockedCount) {
      const sample = items.filter(function (it) { return it.blocked; })
        .slice(0, 3).map(function (it) { return "「" + esc(it.name) + "」"; }).join("、");
      html += '<div class="import-warn">有 ' + blockedCount + " 门课导不进去：" +
    esc(sample) + (blockedCount > 3 ? " 等" : "") +
        "。原因是学分不在网站允许的范围内（目前只支持 0.5 的整数倍，" +
        "而培养方案里有些课是 0.25）。可以在表格里改好学分后再导入。</div>";
    }

    html += '<div class="import-bulk">';
    html += '<button type="button" class="btn-ghost" data-act="all">全选</button>';
    html += '<button type="button" class="btn-ghost" data-act="none">全不选</button>';
    html += '<button type="button" class="btn-ghost" data-act="nodup">只选可导入的</button>';
    html += "</div>";

    html += '<div class="import-scroll"><table class="import-table"><thead><tr>';
    html += "<th class='c-pick'>导入</th><th>课程名</th><th class='c-num'>学分</th>";
    html += "<th class='c-num'>学期</th><th>板块</th>";
    html += "</tr></thead><tbody>";

    items.forEach(function (it, i) {
   const opts = ['<option value="">（不归板块）</option>'];
      if (it.section && !categories.some(function (c) { return c.name === it.section; })) {
    opts.push('<option value="' + esc(it.section) + '" selected>' + esc(it.section) + "（新建）</option>");
      }
      categories.forEach(function (c) {
        const sel = it.section === c.name ? " selected" : "";
        opts.push('<option value="' + esc(c.name) + '"' + sel + ">" + esc(c.name) + "</option>");
   });

    const cls = it.blocked ? " class='is-blocked'" : (it.dup ? " class='is-dup'" : "");
      html += "<tr" + cls + ">";
      html += "<td class='c-pick'><input type='checkbox' data-i='" + i + "' data-f='picked'" +
        (it.picked ? " checked" : "") + "></td>";
      html += "<td><input type='text' data-i='" + i + "' data-f='name' value='" + esc(it.name) + "'>";
  if (it.blocked) {
      html += '<span class="blocked-tip" title="' + esc(it.blocked) + '">?</span>';
      }
        html += "</td>";
        html += "<td class='c-num'><input type='number' step='0.25' min='0' data-i='" + i +
          "' data-f='credits' value='" + it.credits + "'></td>";
        html += "<td class='c-num'>" + (it.term ? esc(it.term) : "<span class='muted'>—</span>") + "</td>";
        html += "<td><select data-i='" + i + "' data-f='section'>" + opts.join("") + "</select></td>";
        html += "</tr>";
    });

    html += "</tbody></table></div>";

    html += '<div class="import-actions">';
    html += '<button type="button" class="btn" data-act="confirm"' +
      (importable ? "" : " disabled") + ">确认导入这 " + importable + " 门</button>";
    html += '<button type="button" class="btn-ghost" data-act="cancel">取消</button>';
    html += "</div>";

    html += '<p class="import-note">导入的课默认记为「计划修」，状态、成绩自己改；' +
      "带橙色底的是列表里已经有的同名课程（会跳过），" +
      "标「?」的是学分不合法、导不进去的，改好学分再导入。</p>";

    box.innerHTML = html;
    setStatus("");
  }

// ---- 确认导入 ----
  function confirm() {
    markBlocked();
    const chosen = items.filter(function (it) { return it.picked && it.name.trim(); });
    if (!chosen.length) {
      showError("还没勾选任何课程。");
      return;
    }
    const ok = chosen.filter(function (it) { return !it.blocked; });
    if (!ok.length) {
      showError("勾选的课程都导不进去。先在表格里把学分改成 0.25 的整数倍。");
      return;
    }
    if (!window.CreditApp || !window.CreditApp.importPlanItems) {
      showError("网站还没加载好，刷新页面再试。");
      return;
    }
    const result = window.CreditApp.importPlanItems(ok.map(function (it) {
      return { name: it.name.trim(), credits: it.credits, section: it.section, term: it.term };
    }));

    if (!result.ok) {
      showError(result.message);
      return;
    }
    // 被拦下的部分要明确说，不能悄悄吞掉
    let msg = result.message;
    const blocked = chosen.length - ok.length;
    if (blocked > 0) msg += " 另有 " + blocked + " 门学分不合法，没有导入。";
    setStatus("<b>" + esc(msg) + "</b>", "ok");
    closePanel();
  }

// ---- 打开面板时滚动过去并聚焦，导入完收起 ----
  // 用 details/summary 让面板能折叠：解析出100 行时表格很长，
  // 不折叠会把下面的课程列表挤出视野。
  function openPanel() {
    const zone = document.getElementById("import-zone");
    if (!zone) return;
    zone.open = true;
    const box = document.getElementById("import-result");
    if (box) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function closePanel() {
    const zone = document.getElementById("import-zone");
    if (zone) zone.open = false;
    const box = document.getElementById("import-result");
    if (box) box.innerHTML = "";
    items = [];
    const input = document.getElementById("import-file");
    if (input) input.value = "";
  }

  // ---- 绑定 ----
  function bind() {
    const btn = document.getElementById("import-open");
    if (!btn) return;

btn.addEventListener("click", function () {
      const zone = document.getElementById("import-zone");
      if (zone) zone.open = true;
      const input = document.getElementById("import-file");
      if (input) input.click();
    });

    const input = document.getElementById("import-file");
    if (input) {
      input.addEventListener("change", function () {
        if (input.files && input.files[0]) parseFile(input.files[0]);
      });
    }

    // 结果区用事件委托，表格重绘后不用重新绑
    const box = document.getElementById("import-result");
    if (!box) return;

    box.addEventListener("click", function (e) {
      const act = e.target.getAttribute && e.target.getAttribute("data-act");
      if (!act) return;
      if (act === "all") items.forEach(function (it) { it.picked = true; renderTable(); });
      else if (act === "none") items.forEach(function (it) { it.picked = false; renderTable(); });
      else if (act === "nodup") {
      // 只选「能导入、且列表里还没有」的
        markBlocked();
        items.forEach(function (it) { it.picked = !it.dup && !it.blocked; });
        renderTable();
      } else if (act === "confirm") confirm();
      else if (act === "cancel") closePanel();
    });

    box.addEventListener("change", function (e) {
      const t = e.target;
      const i = t.getAttribute && t.getAttribute("data-i");
      if (i === null || i === undefined) return;
      const field = t.getAttribute("data-f");
      const idx = Number(i);
      if (!field || !items[idx]) return;
      if (field === "picked") items[idx].picked = t.checked;
      else if (field === "name") items[idx].name = t.value;
      else if (field === "credits") items[idx].credits = Number(t.value) || 0;
      else if (field === "section") items[idx].section = t.value;
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bind);
  } else {
    bind();
  }
})();