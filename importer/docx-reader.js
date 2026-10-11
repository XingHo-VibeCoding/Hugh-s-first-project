// Word (.docx) 解析 —— 比 PDF 简单得多，因为 docx 里的表格是「真表格」
//
// docx 本质是个 zip 包，核心内容在 word/document.xml，
// 表格是 <w:tbl>，行是 <w:tr>，格子是 <w:tc>，文字在 <w:t> 里。
// 结构都是明确的，不需要像 PDF 那样靠坐标猜。

var DocxReader = (function () {
  "use strict";

  // 取元素内所有 <w:t> 的文字，兼容命名空间前缀的各种写法
  function textOf(el) {
    if (!el) return "";
    var nodes = el.getElementsByTagName("*");
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      var tag = (nodes[i].localName || nodes[i].nodeName || "").toLowerCase();
      // 只要正文文字节点，跳过其他
      if (tag === "t" && nodes[i].textContent) {
        out.push(nodes[i].textContent);
      }
    }
    return out.join("").replace(/\s+/g, " ").trim();
  }

  function childrenByLocalName(parent, localName) {
    var out = [];
    if (!parent) return out;
    var kids = parent.childNodes;
    for (var i = 0; i < kids.length; i++) {
      var n = kids[i];
      if (n.nodeType !== 1) continue;
      var tag = (n.localName || n.nodeName || "").toLowerCase();
      // 去掉命名空间前缀
      if (tag.indexOf(":") !== -1) tag = tag.split(":").pop();
      if (tag === localName) out.push(n);
    }
    return out;
  }

  // 递归收集所有指定类型的元素（处理嵌套表格）
  function collectAll(root, localName) {
    var out = [];
    var nodes = root.getElementsByTagName("*");
    for (var i = 0; i < nodes.length; i++) {
      var tag = (nodes[i].localName || nodes[i].nodeName || "").toLowerCase();
      if (tag.indexOf(":") !== -1) tag = tag.split(":").pop();
      if (tag === localName) out.push(nodes[i]);
    }
    return out;
  }

  /**
   * 解析 docx
   * @param {File|ArrayBuffer} input
   * @returns {Promise<{matrix: Array, text: string, tables: number}>}
   */
  function parse(input) {
    var JSZipRef = window.JSZip;
    if (!JSZipRef) {
      return Promise.reject(new Error("JSZip 还没加载好，请检查网络后刷新页面"));
    }

    var bufPromise = (input instanceof ArrayBuffer)
      ? Promise.resolve(input)
      : input.arrayBuffer();

    return bufPromise.then(function (buf) {
      return JSZipRef.loadAsync(buf);
    }).then(function (zip) {
      var file = zip.file("word/document.xml");
      if (!file) {
        throw new Error("这个文件里找不到 word/document.xml，可能不是 .docx（如果是老的 .doc，请先另存为 .docx）");
      }
      return file.async("string");
    }).then(function (xml) {
      var doc = new DOMParser().parseFromString(xml, "application/xml");

      // 检查解析错误
      if (doc.getElementsByTagName("parsererror").length > 0) {
        throw new Error("Word 文件内容解析失败，文件可能已损坏");
      }

      var body = doc.documentElement;
      var tables = collectAll(body, "tbl");
      var matrix = [];
      var plain = textOf(body);

      for (var t = 0; t < tables.length; t++) {
        var trs = childrenByLocalName(tables[t], "tr");
        for (var r = 0; r < trs.length; r++) {
          var tcs = childrenByLocalName(trs[r], "tc");
          var cells = [];
          for (var c = 0; c < tcs.length; c++) {
            cells.push({ x: c * 100, text: textOf(tcs[c]) });
          }
          matrix.push(cells);
        }
        matrix.push([]);   // 表格之间隔开
      }

      // 有些 docx 是用空格排版对齐的，没有真表格 → 把整篇文本按行切开当退路
      if (matrix.length < 3) {
        var lines = plain.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
        matrix = [];
        for (var i = 0; i < lines.length; i++) {
          var cols = lines[i].split(/\s{2,}|\t/).filter(Boolean);
          matrix.push(cols.map(function (s, ci2) { return { x: ci2 * 100, text: s }; }));
        }
      }

      return {
        matrix: matrix,
        text: plain,
        tables: tables.length
      };
    });
  }

  return { parse: parse };
})();

if (typeof window !== "undefined") window.DocxReader = DocxReader;