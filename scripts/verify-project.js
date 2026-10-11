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
const { execSync } = require("child_process");
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

// ⚠️ Day 25 修正（**故意弄坏测试发现的漏报，最严重的一个**）：
//
//   原来所有 grep 类检查（⑧⑨）都用 `git ls-files | while read f; do ... done`。
//   在 **Windows 上 execSync 默认走 cmd.exe**，它**不认识 bash 的 while/read 语法**，
//   整条管道被 cmd 静默吃掉 → **返回空字符串** → 检查项一律判 PASS。
//
//   这是「Skill 骗过去了」的真正原因：不是正则不对，是**命令根本没执行**。
//   更糟的是它**在任何机器上都会报"通过"**，比明显报错危险得多。
//
//   修法：**不依赖 shell**。用 git 拿文件列表，在 Node 里逐个读文件、逐行正则匹配。
//   顺带好处：能明确报告"扫了多少个文件"，一眼看出"扫了0 个 = 没扫到"。
// ⚠️ Day 25 第三次修正（同上，"扫了 0 个文件"暴露出来的）：
//   execSync 在 Windows 上偶尔抛 `spawnSync cmd.exe EBUSY`
//   （频繁起子进程时的资源竞争），于是 listTrackedFiles 返回空
//   → 检查项报"0 命中" → **又是一次虚报通过**。
//
//   两条修法一起上：
//   ① 重试 3 次，仍失败才放弃
//   ② **拿不到文件列表时，检查项必须判 FAIL 而不是 PASS**
//      ——「查不了」不等于「没问题」。这条是整个 Skill 最重要的原则。
function runGit(args, opts) {
  let lastErr = null;
  for (let i = 0; i < 3; i++) {
    try {
      return execSync("git " + args, Object.assign({
        cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 64 * 1024 * 1024,
      }, opts || {}));
    } catch (e) {
      lastErr = e;
      if (e && e.stdout !== undefined && e.stdout !== null && String(e.stdout) !== "") {
        return String(e.stdout);   // 有输出就够了（git 有些子命令非 0 退出）
      }
    }
  }
  throw lastErr || new Error("git " + args + " 执行失败");
}

// ⚠️ Day 25 第四次修正（"查不了 ≠ 没问题" 暴露出来的**最根本问题**）：
//
//   检查器把「能否拿到文件列表」绑在 `execSync("git …")` 上。
//   实测在某些 Windows 环境里 `spawnSync cmd.exe EBUSY` 会让**每一条 git 命令都失败**
//   → 两个密钥检查项直接判 FAIL（虽然比虚报 PASS 好，但失去了检查能力）。
//
//   修法：**用 Node 直接遍历目录**作为主路径，不依赖任何外部命令。
//   `git ls-files` 只作为「哪些文件该被扫」的参考，不是必需。
//   顺带好处：连**未提交的新文件**也一起扫了 —— 而那恰恰是最容易漏密钥的地方
//   （Day 25 第一次塞假密钥时它就是未提交状态）。
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
    return !NAME_EXCLUDE.some(function (x) { return h.text.indexOf(x) >= 0; });
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
  //同样**不依赖 shell 管道**：取全量 diff 文本，在 Node 里逐行正则匹配。
  let diffText = "";
  let histReadOk = true;
  try {
    diffText = runGit("log --all -p");
  } catch (e) { histReadOk = false; diffText = ""; }
  let commitCount = "(读不到)";
  try { commitCount = runGit("rev-list --all --count", { timeout: 30000 }).trim(); } catch (e) { /* 读不到就算了 */ }
  const histRe = new RegExp(
    CONTENT_PAT + "|postgres://|postgresql://|mysql://|mongodb://|jwt[_-]?secret", "i");
  const histList = [];
  diffText.split("\n").forEach(function (line) {
    if (line.charAt(0) !== "+") return;                 // 只看新增行
    if (line.indexOf("grep -") >= 0) return;             // 排除搜索语句自我匹配
    if (line.indexOf("verify-project.js") >= 0) return;  // 排除检查器自身
    // ↓ Day 25 补：文档里**解释这个坑的那段话**也会命中
    //   （Day 23 把「搜索语句匹配到自己」写进了 SECURITY_CHECKLIST.md，
    //     那段解释里含`postgres://` 字面量 → 又一次自我匹配）
    //   判断：出现在 Markdown 的表格/引用/说明文字里，而不是代码里。
    if (line.indexOf("SECURITY_CHECKLIST") >= 0) return;
    if (/^\+\s*[|>#*`]/.test(line) && line.indexOf("grep -") < 0) {
      // 以表格符/引用符/标题符开头 → 是文档正文，不是配置
      return;
    }
    if (histRe.test(line)) histList.push(line.trim().slice(0, 110));
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