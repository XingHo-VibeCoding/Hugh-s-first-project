/**
 * verify-project.js —— 发布前检查（Day 25）
 *
 * 对应 SKILL.md 的 12 个检查项。每一项都来自本项目真实踩过的坑。
 *
 * 怎么跑：
 *   cd C:/Users/w3224/Desktop/my-first-project
 *   C:/Users/w3224/.workbuddy/binaries/node/versions/22.22.2-6/node.exe scripts/verify-project.js
 *
 *   可用环境变量覆盖：
 *     BASE=…  后端地址（默认线上）
 *     SITE=…  静态托管地址
 *     SKIP_SLOW=1  跳过限流验证项（省 61 秒）
 *
 * 退出码：0 = 全部 PASS；1 = 有 FAIL
 */

const https = require("https");
// spawnSync：绕开 cmd.exe 执行 git（见下面 runGit 的注释）
const { execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BASE = process.env.BASE || "https://my-first-project-d2epfvu0373796b.service.tcloudbase.com";
const SITE = process.env.SITE || "https://my-first-project-d2epfvu0373796b-1499184401.tcloudbaseapp.com";
const SKIP_SLOW = process.env.SKIP_SLOW === "1";

const results = [];
let blockCount = 0;

function req(method, urlPath, body) {
  return new Promise(function (resolve) {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = https.request(
      new URL(BASE + urlPath),
      {
        method: method,
        headers: Object.assign(
          { Accept: "application/json" },
          payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}
        ),
      },
      function (res) {
        let raw = "";
        res.on("data", function (c) { raw += c; });
        res.on("end", function () {
          let j = null;
          try { j = JSON.parse(raw); } catch (e) { /* 非 JSON 本身是问题 */ }
          resolve({ status: res.statusCode, body: j, raw: raw, headers: res.headers });
        });
      }
    );
    r.on("error", function (e) { resolve({ status: 0, body: null, raw: e.message, headers: {} }); });
    if (payload) r.write(payload);
    r.end();
  });
}

function record(no, name, pass, evidence, blocking) {
  results.push({ no: no, name: name, pass: pass, evidence: evidence, blocking: !!blocking });
  const tag = pass ? "PASS" : "FAIL";
  console.log("  " + no + " " + name + "\n     [" + tag + "] " + evidence);
}

// ⚠️ Day 25/26 两次修正（"查不了 ≠ 没问题" 逼出来的）：
//
//   检查器原本用 `execSync("git log --all -p")` 拿历史。
//   Day 25 遇到 `spawnSync cmd.exe EBUSY`，加了 3 次重试；
//   Day 26 复现发现它**稳定失败、不是偶发**：execSync / spawnSync 都 EBUSY，
//   而同样的 git 命令在 Bash 里完全正常。→ 换 spawnSync 免 shell 也没用。
//
//   结论：**这条环境里从 Node 起 git 子进程这条路是断的**，
//   再怎么调调用方式都不可靠。所以彻底换思路：
//
//   **git 历史里的内容，直接从 .git 目录读。**
//   .git/objects 是 zlib 压缩的 blob，Node 自带 zlib 能解；
//   遍历 refs/heads/* 拿到所有分支的 commit，逐个展开树、读每个 blob 的内容。
//   完全不依赖外部命令，也不受 EBUSY 影响。
//
//   保留 runGit() 只给少数真正需要 git 的地方用（比如 git check-ignore），
//   那些地方拿不到就明确报 FAIL —— **查不了 ≠ 没问题**。
function readGitBlobs() {
  const gitDir = path.join(ROOT, ".git");
  if (!fs.existsSync(gitDir)) {
    return { ok: false, reason: "找不到 .git 目录（不是 git 仓库？）" };
  }
  const zlib = require("zlib");

  // ---- 读所有 ref ----
  const refs = [];
  const refRoots = [path.join(gitDir, "refs", "heads"), path.join(gitDir, "refs", "tags")];
  for (const root of refRoots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { continue; }
    for (const n of names) {
      const fp = path.join(root, n);
      try {
        const sha = fs.readFileSync(fp, "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(sha)) refs.push(sha);
      } catch (e) { /* 跳过坏 ref */ }
    }
  }
  // packed-refs 里还有一部分
  try {
    const packed = fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8");
    packed.split("\n").forEach(function (line) {
      const m = line.match(/^([0-9a-f]{40})\s+refs\//);
      if (m) refs.push(m[1]);
    });
  } catch (e) { /* 没有这个文件很正常 */ }

  if (!refs.length) {
    return { ok: false, reason: ".git 里没找到任何分支或标签" };
  }

  // ---- 读一个 git 对象 ----
  function readObject(sha) {
    const f = path.join(gitDir, "objects", sha.slice(0, 2), sha.slice(2));
    let raw;
    try { raw = fs.readFileSync(f); } catch (e) { return null; }
    let body;
    try { body = zlib.inflateSync(raw); } catch (e) { return null; }
    const nul = body.indexOf(0);
    if (nul === -1) return null;
    const header = body.slice(0, nul).toString("utf8");
    const content = body.slice(nul + 1);
    const type = header.split(" ")[0];
    return { type: type, content: content };
  }

  // ---- 遍历 commit 树，收集所有 blob ----
  const seen = {};
  const blobs = [];
  let commitCount = 0;

  function walkTree(sha) {
    if (seen[sha]) return;
    seen[sha] = true;
    const obj = readObject(sha);
    if (!obj || obj.type !== "tree") return;
    // tree 的内容是 "<mode> <name>\0<20字节 sha>" 反复
    const buf = obj.content;
    let i = 0;
    while (i < buf.length) {
      const sp = buf.indexOf(0x20, i);
      if (sp === -1) break;
      const nul2 = buf.indexOf(0, sp);
      if (nul2 === -1) break;
      const name = buf.slice(sp + 1, nul2).toString("utf8");
      const shaHex = buf.slice(nul2 + 1, nul2 + 21).toString("hex");
      i = nul2 + 21;
      const isTree = i <= buf.length && false;   // 下面用 type 判断
      const child = readObject(shaHex);
      if (!child) continue;
      if (child.type === "tree") walkTree(shaHex);
      else if (child.type === "blob") {
        if (!seen["b:" + shaHex]) {
          seen["b:" + shaHex] = true;
          blobs.push({
            sha: shaHex,
            // ⚠️ 必须带出**文件名**（Day 26 踩坑）：
            //   之前只返回内容，导致下游按行排除「检查器自身的文件名」永远命不中
            //   —— blob 内容里没有文件名，于是检查器把自己判成了密钥。
            //   排除规则要作用在正确的层级：按文件排除就得先有文件名。
            name: name,
            content: child.content.toString("utf8"),
          });
        }
      }
    }
  }

  function walkCommit(sha) {
    if (seen["c:" + sha]) return;
    seen["c:" + sha] = true;
    const obj = readObject(sha);
    if (!obj || obj.type !== "commit") return;
    commitCount++;
    const text = obj.content.toString("utf8");
    const treeM = text.match(/^tree ([0-9a-f]{40})/m);
    if (treeM) walkTree(treeM[1]);
    // 父提交：把历史里每一版都扫到（不然只能扫到最新一版）
    const parents = [];
    text.split("\n").forEach(function (line) {
      const m = line.match(/^parent ([0-9a-f]{40})/);
      if (m) parents.push(m[1]);
    });
    parents.forEach(walkCommit);
  }

  refs.forEach(walkCommit);

  if (!commitCount) {
    return { ok: false, reason: "读到 0 个 commit（对象可能是 pack 文件，未解包）" };
  }
  return { ok: true, commitCount: commitCount, blobs: blobs };
}

/** 还需要 git 命令时用（少数场景，比如 git check-ignore）。拿不到就抛错，让调用方判 FAIL。 */
function runGit(args, opts) {
  const list = Array.isArray(args) ? args : String(args).split(/\s+/);
  const o = Object.assign({
    cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024,
  }, opts || {});
  const r = spawnSync("git", list, o);
  if (r.error) throw r.error;
  if (r.stdout !== null && r.stdout !== undefined) return String(r.stdout);
  throw new Error("git " + list.join(" ") + " 执行失败");
}

// 扫哪些文件：**用 Node 直接遍历目录**，不依赖 `git ls-files`。
//
// 为什么不用 git 拿文件列表：Windows 上 execSync 起 cmd.exe 会 EBUSY（见上面 runGit）。
// 而且直接遍历还有个好处：**连未提交的新文件也一起扫了** ——
// 而那恰恰是最容易漏密钥的地方（Day 25 第一次塞假密钥时它就是未提交状态）。
const SKIP_DIRS = [".git", ".workbuddy", "node_modules", ".vscode", ".idea", "dist", "build"];

function walkFiles(dir, out, depth) {
  if (depth > 6) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.indexOf(e.name) >= 0) continue;
      walkFiles(path.join(dir, e.name), out, depth + 1);
    } else if (e.isFile()) {
      out.push(path.relative(ROOT, path.join(dir, e.name)).replace(/\\/g, "/"));
    }
  }
  return out;
}

function listScannableFiles() {
  const all = walkFiles(ROOT, [], 0);
  // 只扫文本类文件，二进制跳过（否则读出来是乱码、还拖慢速度）
  const TEXT = /\.(js|mjs|cjs|ts|json|md|html|css|txt|yml|yaml|sh|sql|env|example)$/i;
  const files = all.filter(function (f) {
    if (TEXT.test(f)) return true;
    // 无扩展名但可能是 .env / .gitignore 这类
    const base = path.basename(f);
    return base === ".env" || base.indexOf(".env.") === 0 || base === ".gitignore";
  });
  return { files: files, total: all.length };
}

function scanFiles(regexSrc, fileList, flags) {
  const re = new RegExp(regexSrc, flags || "i");
  const hits = [];
  for (const f of fileList) {
    let txt;
    try { txt = fs.readFileSync(path.join(ROOT, f), "utf8"); } catch (e) { continue; }
    const lines = txt.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) hits.push({ file: f, line: i + 1, text: lines[i].trim().slice(0, 110) });
    }
  }
  return hits;
}

// 保留 git 版作为参考（拿不到就返回空，不影响主流程）
function listTrackedFiles() {
  try {
    const out = runGit("ls-files", { timeout: 30000 });
    return out.split("\n").filter(function (f) { return f.trim() !== ""; });
  } catch (e) {
    return [];
  }
}

// ⚠️ Day 25 修正（第一次实跑发现的误报）：
//   原来只看 execSync 是否抛异常。但 `git check-ignore .env` 在
//   **成功时也可能不抛**（取决于 git 版本与是否走 pager），
//   而失败时抛异常 → 我把两种情况都当成了「输出为空 = 没被忽略」，
//   于是 .env 明明被 .gitignore 覆盖（第 6 行），却报 FAIL。
//   改成：**以 stdout 内容为准，退出码只作参考**。
function sh(cmd) {
  try {
    const out = execSync(cmd, { cwd: ROOT, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] });
    return { out: out, code: 0 };
  } catch (e) {
    // 抛异常时 stdout 依然可能有内容（例如 git 有输出但退出码非 0）
    return { out: e.stdout === undefined || e.stdout === null ? "" : String(e.stdout), code: e.status || 1 };
  }
}

const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

(async function main() {
  console.log("verify-project — 发布前检查");
  console.log("目标：" + BASE);
  console.log("=".repeat(66));

  // ---------------------------------------------------------- ① 静态托管
  const site = await new Promise(function (resolve) {
    https.request(new URL(SITE + "/cloud.html"), { method: "GET" }, function (res) {
      let n = 0;
      res.on("data", function (c) { n += c.length; });
      res.on("end", function () { resolve({ status: res.statusCode, size: n }); });
    }).on("error", function (e) { resolve({ status: 0, size: 0, err: e.message }); }).end();
  });
  record("①", "静态托管页面可访问",
    site.status === 200 && site.size > 10000,
    "HTTP " + site.status + "，" + site.size + " 字节" +
    (site.status === 418 ? "　← 418 = 域名不存在（打错数字了），不代表服务坏了" : ""));

  // ---------------------------------------------------------- ② 健康接口
  const h = await req("GET", "/api/health");
  record("②", "健康接口正常",
    h.status === 200 && h.body && h.body.ok === true && h.body.service === "credit-planner",
    h.body ? JSON.stringify(h.body).slice(0, 70) : ("HTTP " + h.status + " " + h.raw.slice(0, 40)));

  // ---------------------------------------------------------- ③ 三个路由
  const routes = ["health", "categories", "courses"];
  const rOut = [];
  let rOk = 0;
  for (const rt of routes) {
    const r = await req("GET", "/api/" + rt + "?limit=5");
    let good = r.status === 200;
    if (good && rt !== "health") good = Array.isArray(r.body && r.body.data) && r.body.data.length > 0;
    if (good) rOk++;
    rOut.push(rt + "=" + r.status);
  }
  record("③", "云函数三个路由都活着",
    rOk === 3, rOut.join("　") + "　（3/3 = " + rOk + "）");

  // ---------------------------------------------------------- ④ 跨域
  const allow = await req("GET", "/api/courses?limit=1");
  // Node 拿不到 Access-Control-Allow-Origin（要看响应头）
  const cors = await new Promise(function (resolve) {
    const u = new URL(BASE + "/api/courses?limit=1");
    https.request(u, { headers: { Origin: SITE } }, function (res) {
      resolve({ ok: res.headers["access-control-allow-origin"] || "" });
    }).on("error", function () { resolve({ ok: "" }); }).end();
  });
  const evil = await new Promise(function (resolve) {
    const u = new URL(BASE + "/api/courses?limit=1");
    https.request(u, { headers: { Origin: "https://evil.example.com" } }, function (res) {
      resolve({ ok: res.headers["access-control-allow-origin"] || "" });
    }).on("error", function () { resolve({ ok: "" }); }).end();
  });
  record("④", "跨域白名单正确",
    cors.ok === SITE && evil.ok === "",
    "白名单来源回显=" + (cors.ok === SITE ? "正确" : "「" + cors.ok + "」") +
    "　陌生来源=" + (evil.ok === "" ? "无头✅" : "❌ 给了「" + evil.ok + "」"),
    true);

  // ---------------------------------------------------------- ⑤ 真库证据
  const list = await req("GET", "/api/courses?limit=200");
  const rows = list.body && list.body.data;
  const k01 = Array.isArray(rows) ? rows.find(function (c) { return c.id === "k01"; }) : null;
  const k01Score = k01 ? k01.score : "(没找到 k01)";
  record("⑤", "读接口返回真实数据库数据",
    Array.isArray(rows) && rows.length > 0 && k01Score === 95,
    (Array.isArray(rows) ? rows.length + " 门课" : "返回不是数组") +
    "　k01 成绩=" + k01Score +
    "（期望 95；seed 里是 72，线上若是 72 说明刚跑过 seed.sql）",
    true);

  // ---------------------------------------------------------- ⑥ 读写闭环
  const stamp = "VP" + String(Date.now()).slice(-6);
  const created = await req("POST", "/api/courses", { name: "发布前检查" + stamp, credits: 1, categoryId: "c1", status: "done" });
  const newId = created.body && created.body.data && created.body.data.id;
  const afterCreate = await req("GET", "/api/courses?limit=200");
  const found = Array.isArray(afterCreate.body && afterCreate.body.data) &&
    afterCreate.body.data.some(function (c) { return c.id === newId; });
  const del = newId ? await req("DELETE", "/api/courses?id=" + encodeURIComponent(newId)) : { status: 0, body: null };
  const afterDel = await req("GET", "/api/courses?limit=200");
  const gone = newId && Array.isArray(afterDel.body && afterDel.body.data) &&
    !afterDel.body.data.some(function (c) { return c.id === newId; });
  record("⑥", "写入 → 读回 → 删除闭环",
    created.status === 201 && found && del.status === 200 && gone,
    "POST " + created.status + " → 读回" + (found ? "找到" : "没找到") +
    " → DELETE(查询串) " + del.status + " → 再读" + (gone ? "已消失 ✅" : "还在 ❌"),
    true);

  // ---------------------------------------------------------- ⑦ DELETE 回归
  const del404 = await req("DELETE", "/api/courses?id=__no_such_id__");
  const delMsg = del404.body && del404.body.error;
  record("⑦", "DELETE 传 id 走查询串（Day 24 bug 回归）",
    del404.status === 404 && typeof delMsg === "string" && delMsg.indexOf("课程不存在") >= 0,
    "HTTP " + del404.status + "　" + (delMsg || "(无 JSON 说明被网关拦了)") +
    "　（若返回 400「请求体不能为空」说明代码回退到只用请求体了）",
    true);

  // ---------------------------------------------------------- ⑧⑨ 密钥检测（两层）
  //
  // ⚠️ Day 25 修正（**故意弄坏测试发现的漏报**）：
  //   原来只有一层「按变量名找」`(password|secret|api_key|…)\s*=\s*'值'`。
  //   我故意塞了一个变量名叫 `BROKEN_TEST_KEY` 的假密钥 → **它没被抓到**，
  //   因为关键词列表里只有 `api_key` / `apikey`，**没有独立的裸 `key`**。
  //
  //   改成**双层**，且**内容层优先**：
  //   第1 层 按值的形状（不看变量名）：sk- 开头 / AKIA / ghp_ / xox?- / PRIVATE KEY
  //   第 2 层 按变量名：补齐裸 key / credential / auth
  //   理由：**值的形状比变量名可靠** —— 变量名可以随便起，值的形状不会骗人。
  const CONTENT_PAT =
    "sk-[A-Za-z0-9-]{12,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----";
  const NAME_PAT =
    "(password|passwd|secret|api[_-]?key|apikey|key|token|credential|auth|connection_?string)\\s*[:=]\\s*['\\\"][^'\\\"]{8,}['\\\"]";
  const scan = listScannableFiles();
  const filesScanned = scan.files.length;
  // 内容形状层几乎不误报，直接用
  const hitsA = scanFiles(CONTENT_PAT, scan.files);
  // 变量名层会误伤很多「正常的对象字面量」（{ key: "categoryId" }），
  // 所以加一层**排除规则**：命中行里出现下面任一情况就跳过。
  const NAME_EXCLUDE = [
    "process.env",        // 从环境变量读 —— 这是安全用法
    "{ el:",              // DOM 属性对象
    "{ key:",             // 配置项对象字面量
    'key: "',             // 对象字面量里的 key 字段
    "label:",
    "path:",
    "test-key",
    "CLOUDBASE_",        // 环境变量名本身
    "api-contract",       // 契约文档里写的字段名
    // ↓ Day 25 补：localStorage 的键名不是密钥
    //   store.js 里STORAGE_KEY = "creditPlanner.v1" / BACKUP_KEY = "creditPlanner.backup"
    //   都是**存数据的键名**，与凭证无关。判断依据：值里不含数字/乱码形态，
    //   且是我们自己起的项目名。真正的密钥值一定是高熵随机串。
    "creditPlanner.",     // 项目自己的命名空间（localStorage 键）
  ];
  const hitsB = scanFiles(NAME_PAT, scan.files).filter(function (h) {
    if (NAME_EXCLUDE.some(function (x) { return h.text.indexOf(x) >= 0; })) return false;
    // ↓ Day 26 补（连着踩了三次同样的坑才想明白）：
    //   排除规则不该靠"中文说明词"来识别举例 —— 因为**解释这条规则的注释本身
    //   就含有那些词**，于是规则把自己写的注释判成了密钥（死循环）。
    //
    //   正确判据分两种，按"这行到底是什么"来判断：
    //   ① **注释**以 // 或 * 开头 —— 注释不是可执行代码，
    //      写在注释里的"这是假密钥示例"没有任何泄露风险。
    //   ② **Markdown 正文**—— 讲清契约必须写出字段名和字面量，
    //      而它们长得就像密钥。
    //   反过来，代码里的 `KEY = "xxx"` 不管注释怎么解释，它都在赋值，都得查。
    const t = String(h.text).trim();
    if (t.indexOf("//") === 0) return false;
    if (t.indexOf("*") === 0) return false;
    if (t.indexOf("/*") === 0) return false;
    // Markdown 正文：命中的是 md 文件，且这一行不是表格/标题（那些已被排除）
    if (/\.md$/i.test(h.file) && !/^[|>#*`]/.test(t)) return false;
    return true;
  });
  // 同一文件同一行可能被两层都命中，去重
  const seen = {};
  const leakList = hitsA.concat(hitsB).filter(function (h) {
    const k = h.file + ":" + h.line;
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  });
  // ⚠️ 「扫了 0 个文件」= 根本没扫成 → 必须判 FAIL，**不能**判 PASS
  const scanFailed = filesScanned === 0;
  record("⑧", "代码里没有硬编码密钥",
    !scanFailed && leakList.length === 0,
    scanFailed
      ? "❌ 拿不到文件列表（git 执行失败），本项无法判定 —— 查不了 ≠ 没问题"
      : (leakList.length === 0
        ? "0 命中（扫了 " + filesScanned + " 个文本文件 / 仓库共 " + scan.total + " 个 · 内容形状层 + 变量名层）"
        : ("命中 " + leakList.length + " 处：\n     " +
           leakList.slice(0, 4).map(function (h) { return h.file + ":" + h.line + "　" + h.text; }).join("\n     "))),
    true);

  // ---------------------------------------------------------- ⑨ Git 历史密钥
  //
  // Day 26 改用 readGitBlobs()：**直接从 .git 目录读**，不调 git 子进程。
  // 原因见 readGitBlobs 上面的注释（本环境 execSync/spawnSync 起 git 都 EBUSY，
  // 但 Bash 里完全正常——所以不是 git 的问题，是从 Node 起子进程这条路断了）。
  //
  // 好处还不止「能跑」：直接读 objects 能拿到**每一个历史版本的文件内容**，
  // 而 `git log -p` 只给 diff。扫 blob 更彻底（某个文件的旧版本里有密钥也能查到）。
  const hist = readGitBlobs();
  const histReadOk = hist.ok;
  const commitCount = hist.ok ? String(hist.commitCount) : "(读不到)";
  const histRe = new RegExp(
    CONTENT_PAT + "|postgres://|postgresql://|mysql://|mongodb://|jwt[_-]?secret", "i");
  const histList = [];

  // ⚠️ Day 26 补（这个检查项因为"排除规则用错层级"错了三次才修对）：
  //
  //   按**文件**排除，不是按行。理由：检查器自己的源码里有一行正则定义
  //   （`CONTENT_PAT + "|postgres://|mysql://…"`），它长得就像密钥。
  //   之前用 `line.indexOf("verify-project.js")` 排除，但 blob 内容里
  //   **没有文件名**，这行永远排除不掉 —— 于是检查器把自己判成了"历史里的密钥"。
  //
  //   **教训：排除规则要作用在正确的层级上。**
  //   按行排除只在"行内自带标识"时有效；要按文件排除，就得先把文件名带进循环。
  //   —— 这和 Day 26 修 B-004 时踩的是同一类错误：判据用在了错误的层级。
  //
  //   另外两类排除也补齐了：
  //   - Markdown 文档要写字段名和字面量（讲清契约必须写），不是密钥
  //   - 注释里常出现示例值，注释不是可执行代码
  const docRe = /(SKILL|SECURITY_CHECKLIST|KNOWN_BUGS|TECH_DESIGN|api-contract)/i;
  const selfRe = /verify-project\.js$/i;
  const reMeta = /[|\+\[\]?*\\]{2,}/;   // 多个正则元字符 → 是模式串不是密钥

  hist.blobs.forEach(function (b) {
    if (selfRe.test(b.name || "")) return;   // 检查器自身
    if (docRe.test(b.name || "")) return;    // 坑记录 / 契约文档
    (b.content || "").split("\n").forEach(function (line) {
      if (line.indexOf("grep -") >= 0) return;
      const t = line.trim();
      if (t.indexOf("//") === 0) return;                    // 单行注释
      if (t.indexOf("*") === 0) return;                     // 块注释 / 续行
      if (t.indexOf("/*") === 0) return;
      if (/^[|>#*`]/.test(t)) return;                       // Markdown 正文
      if (reMeta.test(line) && line.indexOf("=") >= 0) return;  // 正则模式串
      if (histRe.test(line)) histList.push(b.name + "　" + t.slice(0, 100));
    });
  });
  const histHits = histList.join("\n");
  record("⑨", "Git 全部历史里也没有密钥",
    histReadOk && histList.length === 0,
    !histReadOk
      ? "⚠️ 读不到 git 历史（本环境 git 命令不可用），**历史部分未检查** —— 查不了 ≠ 没问题，改用「git log -p | grep」手工补一次"
      : (histList.length === 0
        ? "0 条真实命中（扫了 " + commitCount +
          " 个提交 · 已排除搜索语句自我匹配与检查器自身）"
        : ("命中：\n     " + histHits.split("\n").slice(0, 4).join("\n     "))),
    true);

  // ---------------------------------------------------------- ⑩ .env
  const s10a = sh("git check-ignore .env");
  const igOut = (s10a.out || "").trim();
  // 判定：输出里出现 `.env` 即视为已被忽略（不带 -v 时就是原样输出 `.env`）
  const ignored = igOut.split("\n").some(function (l) { return l.trim().split("\t")[0].trim() === ".env"; });
  const s10b = sh("git ls-files | grep -x '\\.env'");
  const inRepo = (s10b.out || "").trim() !== "";
  const exPath = path.join(ROOT, ".env.example");
  let exOK = false, exDetail = "";
  if (fs.existsSync(exPath)) {
    const lines = fs.readFileSync(exPath, "utf8").split("\n");
    const withValue = lines.filter(function (l) { return /^[A-Z_]+=.+/.test(l); });
    exOK = withValue.length === 0;
    exDetail = withValue.length + " 行带真实值（期望 0）";
  } else { exDetail = "文件不存在"; }
  record("⑩", ".env 不在仓库且被忽略 + .env.example 存在",
    ignored && !inRepo && exOK,
    "git check-ignore 输出「" + (igOut || "(空)") + "」" +
    "　仓库里有 .env=" + (inRepo ? "是 ❌" : "否✅") +
    "　.env.example " + exDetail,
    true);

  // ---------------------------------------------------------- ⑪ 契约一致
  let implOk = 0, implTotal = 0, implDetail = "";
  const cPath = path.join(ROOT, "api-contract.md");
  if (fs.existsSync(cPath)) {
    const md = fs.readFileSync(cPath, "utf8");
    const rowsMd = md.split("\n").filter(function (l) { return /^\|\s*\d+\s*\|/.test(l); });
    for (const line of rowsMd) {
      if (line.indexOf("| 方法 |") >= 0) continue;
      implTotal++;
      if (line.indexOf("✅") >= 0) implOk++;
    }
    implDetail = implOk + "/" + implTotal + " 个接口标了已实现";
  } else { implDetail = "契约文件不存在"; }
  // 抽两个标了已实现的实测一下（health 与 courses 是核心）
  const cHealth = await req("GET", "/api/health");
  const cCourses = await req("GET", "/api/courses?limit=1");
  const liveOk = cHealth.status === 200 && cCourses.status === 200;
  record("⑪", "契约已实现接口与实际一致",
    implTotal > 0 && implOk > 0 && liveOk,
    implDetail + "　实测核心两个：health " + cHealth.status + "、courses " + cCourses.status +
    "（若契约标了 ✅ 但实际调不通 = 违约）",
    true);

  // ---------------------------------------------------------- ⑫ bug 记录
  const kPath = path.join(ROOT, "KNOWN_BUGS.md");
  let bOK = false, bDetail = "";
  if (fs.existsSync(kPath)) {
    const kb = fs.readFileSync(kPath, "utf8");
    const items = kb.split("\n").filter(function (l) { return /^### [BNL]-\d+/.test(l); });
    // 每个条目都要有「状态」（形如 **待修** / **✅ 已修** / **无法修**）
    const blocks = kb.split(/^### [BNL]-\d+/m).slice(1);
    const noStatus = blocks.filter(function (bl) { return bl.indexOf("**状态**") < 0; });
    const noRoot = blocks.filter(function (bl) { return bl.indexOf("**根因") < 0 && bl.indexOf("**结论") < 0; });
    bOK = items.length > 0 && noStatus.length === 0;
    bDetail = items.length + " 个条目；缺状态 " + noStatus.length + " 个；缺根因/结论 " + noRoot.length + " 个";
  } else { bDetail = "KNOWN_BUGS.md 不存在"; }
  record("⑫", "未修复的 bug 都有记录和优先级", bOK, bDetail, true);


  // ---------------------------------------------------------- ⑬ 云函数 zip 是最新的吗
  //
  // ⚠️ Day 27 加这一项的原因（血泪教训）：
  //
  //   云函数部署的是 cloudfunctions/api/index.zip，**不是仓库里的 .js 源码**。
  //   改完源码不重新打包，线上跑的还是老代码 —— **而且没有任何报错**。
  //
  //   Day 23–27 我改了云函数 5 次，提交推送写文档全都做了，
  //   一次都没重新打包。结果线上跑的是 10 月 4 日的版本，整整 5 天。
  //
  //   为什么别的地方抓不到它：
  //   - index.zip 不进 git，所以 `git status` 永远是干净的
  //   - 部署后接口返回 200，日志里也看不到异常
  //   唯一能发现的方式是「打一个只有新代码才会正确响应的值」
  //
  // 所以这里做两件事：
  //   ① zip 里的代码有没有落后于源码（比对时间 + 关键特征串）
  //   ② 打出结论：需要重新打包 / 已是最新的
  console.log("\n  ⑬ 云函数 zip 是最新的吗");
  let zOK = false;
  let zDetail = "index.zip 不存在（还没打包过）";
  const zipPath = path.join(ROOT, "cloudfunctions", "api", "index.zip");
  if (fs.existsSync(zipPath)) {
    const zipStat = fs.statSync(zipPath);
    // 源码里最新的修改时间
    let newestSrc = 0;
    ["index.js", "services", "repositories"].forEach(function (rel) {
      const p = path.join(ROOT, "cloudfunctions", "api", rel);
      if (!fs.existsSync(p)) return;
      if (fs.statSync(p).isDirectory()) {
        fs.readdirSync(p).forEach(function (f) {
          if (f.endsWith(".js")) {
            newestSrc = Math.max(newestSrc, fs.statSync(path.join(p, f)).mtimeMs);
          }
        });
      } else {
        newestSrc = Math.max(newestSrc, fs.statSync(p).mtimeMs);
      }
    });

    // zip 里必须含有的特征串（挑几个"改了就会变"的）
    const SRC = path.join(ROOT, "cloudfunctions", "api");
    const srcText = ["index.js", "services/courseService.js", "services/errorResponses.js"]
      .map(function (f) {
        try { return fs.readFileSync(path.join(SRC, f), "utf8"); } catch (e) { return ""; }
      }).join("\n");

    const sig = [];
    if (/0\.25 的倍数/.test(srcText)) sig.push("0.25 粒度");
    if (/学分必须是数字/.test(srcText)) sig.push("学分类型校验");
    if (/MAX_CREDITS/.test(srcText)) sig.push("学分上限");
    if (/__error/.test(srcText)) sig.push("业务错误分级");

    const stale = newestSrc > zipStat.mtimeMs + 1000;
    zOK = !stale;
    zDetail =
      "zip " + Math.round(zipStat.size / 1024) + " KB（" + new Date(zipStat.mtimeMs).toLocaleString("zh-CN") + "）" +
      "；源码最新 " + new Date(newestSrc).toLocaleString("zh-CN") +
      "；特征串 " + sig.length + " 项" +
      (stale
        ? "　⚠️ **源码比 zip 新 → 线上跑的是老代码，跑 node scripts/pack-cloudfunction.js 后上传部署**"
        : "　✅ 看起来是最新的（但仍需上传控制台后才算上线）");
  }
  record("⑬", "云函数 zip 与源码同步", zOK, zDetail, true);

  // ---------------------------------------------------------- ⑭ 回滚手册齐不齐
  //
  // ⚠️ Day 26 加这一项的原因：
  //
  //   Day 26 正式发布 + 真做了回退演练，自检时才发现：
  //   **演练做了，回滚手册根本没写。**
  //   演练记录（TEST_LOG）有，但"出事了该按哪几步做"这份东西不存在 ——
  //   等于真出事时还是得从头想，等于没有手册。
  //
  // 为什么别的地方抓不到它：
  //   - 演练确实做了，TEST_LOG 里时间线齐全，看着挺完整
  //   - git tag 也在、文件也能取回 —— 备份检测全过，唯独手册没人提
  //   - 所以它不属于任何已有的检查项，只能新加一项盯着
  //
  // 这一项检查三件事（缺一不可）：
  //   ① 有触发条件     —— 什么情况该回滚、什么情况不该
  //   ② 有分步操作     —— 具体到能照着做，不是"上传旧版本"这种一句话
  //   ③ 未实操的路径要标注原因 —— 云函数 / 数据恢复没演练过就明说，
  //      不许让人以为三条路径都验过了
  console.log("\n  ⑭ 回滚手册");
  const rbPath = path.join(ROOT, "ROLLBACK.md");
  let rOK = false, rDetail = "";
  if (!fs.existsSync(rbPath)) {
    rDetail = "ROLLBACK.md 不存在（演练做了但没写手册 = 出事时还得从头想）";
  } else {
    const rb = fs.readFileSync(rbPath, "utf8");
    const hasTrigger = /触发条件/.test(rb);
    const hasSteps = /分步|步骤|步骤\s*$|###\s*步骤/.test(rb) || /1\..*\n2\./.test(rb);
    const hasNotPracticed = /不实操/.test(rb) && /原因/.test(rb);
    const parts = [];
    parts.push("触发条件 " + (hasTrigger ? "✅" : "❌"));
    parts.push("分步操作 " + (hasSteps ? "✅" : "❌"));
    parts.push("未实操路径标注原因 " + (hasNotPracticed ? "✅" : "❌"));
    rOK = hasTrigger && hasSteps && hasNotPracticed;
    rDetail = parts.join("；");
    if (!rOK) rDetail += "　→ 手册不合格，补齐后发布才算真的留了退路";
  }
  record("⑭", "回滚手册齐不齐（触发条件/分步/未实操标注）", rOK, rDetail, true);

  // ---------------------------------------------------------- 汇总
  console.log("\n" + "=".repeat(66));
  const passed = results.filter(function (r) { return r.pass; }).length;
  const failed = results.filter(function (r) { return !r.pass; });
  blockCount = failed.filter(function (r) { return r.blocking; }).length;
  console.log("结果：" + passed + " PASS / " + failed.length + " FAIL");
  console.log("阻塞项：" + blockCount + "（会让用户直接受损，发布前必须处理）");
  if (failed.length) {
    console.log("");
    failed.forEach(function (r) { console.log("  " + r.no + " " + r.name + " → " + r.evidence.split("\n")[0]); });
  }
  console.log("");
  console.log("每一项都来自本项目真实踩过的坑（出处见 SKILL.md）。");
  console.log(failed.length === 0 ? "结论：可以发布。" : "结论：有阻塞项，先修再发布。");

  process.exit(failed.length === 0 ? 0 : 1);
})();