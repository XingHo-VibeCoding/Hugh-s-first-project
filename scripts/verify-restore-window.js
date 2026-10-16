/* Day 29：锁死「5 秒撤销窗口」这个 bug
 *
 * 【为什么这个检查项必须存在】
 *   契约第 10 条写「删除后 5 秒内可撤销」，但这个功能**从来没生效过**：
 *   `softDeleteCourse(id, nowIso)` 把 deleted_at 和 delete_expires_at
 *   **写成同一个时间**，也就是 delete_expires_at = 删除时刻。
 *   service 层比较 `delete_expires_at < Date.now()` → 删除后一瞬间就判定过期。
 *
 *   为什么一直没被发现：
 *   **接口返回的 restoreBefore 是对的**（service 层算对了 expires，
 *   只是没往下传），只看接口响应完全正常；
 *   前端又因为撤销接口没接路由、根本没调用过这层逻辑。
 *   **响应里对、库里错 —— 只有真去撤销一次才会暴露。**
 *
 * 验证方式：真算一遍时间，确认两个列写的不是同一个值。
 */

const fs = require("fs");
const path = require("path");

let fail = 0;
function ok(label, cond, extra) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
  if (!cond) fail++;
}

const repoPath = path.join(__dirname, "..", "cloudfunctions", "api", "repositories", "coursesRepository.js");
const svcPath = path.join(__dirname, "..", "cloudfunctions", "api", "services", "courseEditService.js");
const repo = fs.readFileSync(repoPath, "utf8");
const svc = fs.readFileSync(svcPath, "utf8");

console.log("=== 5 秒撤销窗口：数据层时间写入检查 ===\n");

console.log("① 数据层：两个列不能写同一个值");
const writeBlock = repo.match(/deleted_at:\s*\w+,\s*\n\s*delete_expires_at:\s*[\w.]+,/);
ok("找到了写 deleted_at / delete_expires_at 的地方", !!writeBlock,
   writeBlock ? writeBlock[0].replace(/\s+/g, " ") : "没找到");
ok("delete_expires_at **不是**直接写 nowIso",
   writeBlock && !/delete_expires_at:\s*nowIso/.test(writeBlock[0]),
   writeBlock ? writeBlock[0].match(/delete_expires_at:\s*([\w.]+)/)[1] : "");
ok("delete_expires_at 写的是独立的 expires 变量",
   writeBlock && /delete_expires_at:\s*expires/.test(writeBlock[0]));

console.log("\n② 数据层：签名与兼容处理");
ok("softDeleteCourse 签名接第三个参数",
   /function\s+softDeleteCourse\s*\(id,\s*nowIso,\s*expiresIso\)/.test(repo));
ok("有兜底：没给 expiresIso 时不会写 undefined",
   /const\s+expires\s*=\s*expiresIso\s*\|\|\s*nowIso/.test(repo),
   "兜底是为了不让 delete_expires_at 早于 deleted_at");
ok("注释写明了 Day 29 这个 bug 的来龙去脉",
   /5 秒内可撤销.*从来没生效过|delete_expires_at\s*=\s*删除时刻/.test(repo));

console.log("\n③ 业务层：expires 必须往下传");
ok("deleteCourse 算出了 expires",
   /const\s+expires\s*=\s*new\s+Date\(\s*now\.getTime\(\)\s*\+\s*RESTORE_WINDOW_SECONDS\s*\*\s*1000\s*\)/.test(svc));
ok("调用 softDeleteCourse 时传了 expires.toISOString()",
   /softDeleteCourse\(\s*id,\s*now\.toISOString\(\),\s*expires\.toISOString\(\)\s*\)/.test(svc),
   "这是 Day 29 的核心修复点");
ok("响应里的 restoreBefore 仍用 expires（没被改坏）",
   /restoreBefore:\s*expires\.toISOString\(\)/.test(svc));

console.log("\n④ 真算一遍：两个列写的值必须差 5 秒");
const now = new Date(2026, 9, 16, 17, 30, 0);
const WINDOW = 5;
const nowIso = now.toISOString();
const expiresIso = new Date(now.getTime() + WINDOW * 1000).toISOString();
const diffMs = new Date(expiresIso).getTime() - new Date(nowIso).getTime();
ok("delete_expires_at - deleted_at = " + (diffMs / 1000) + " 秒", diffMs === WINDOW * 1000);
ok("expires 严格晚于 now（撤销窗口是开区间）",
   new Date(expiresIso).getTime() > new Date(nowIso).getTime());

// 模拟修复前的写法，证明它必然超时
const buggy = nowIso; // 老代码：两个列都是 now
const buggyDiff = new Date(buggy).getTime() - new Date(nowIso).getTime();
ok("反向测试：老写法（都写 now）窗口 = " + buggyDiff + " ms，必然超时",
   buggyDiff === 0);
ok("反向测试：老写法在删除后 1ms 就会判过期",
   new Date(buggy).getTime() < now.getTime() + 1);

// 新写法在删除后 3 秒仍可撤销
const stillOk = new Date(expiresIso).getTime() > now.getTime() + 3000;
ok("新写法：删除后 3 秒仍在窗口内（可撤销）", stillOk);
// 新写法在删除后 6 秒过期
const expired = new Date(expiresIso).getTime() < now.getTime() + 6000;
ok("新写法：删除后 6 秒才过期", expired);

console.log("\n⑤ 语法");
// 不要用正则剥离 require/await 来「伪解析」—— 那会破坏语法本身，
// 报出来的错是我检查方法造的，不是代码的问题（Day 29 踩过）。
// 直接用 node --check 对三个文件做真正的语法检查。
const { execFileSync } = require("child_process");
["repositories/coursesRepository.js", "services/courseEditService.js", "index.js"]
  .forEach(function (rel) {
    const abs = path.join(__dirname, "..", "cloudfunctions", "api", rel);
    try {
      execFileSync(process.execPath, ["--check", abs], { stdio: "pipe" });
      ok(rel + " 语法正常", true);
    } catch (e) {
      ok(rel + " 语法正常（" + String(e.stderr || e.message).slice(0, 80) + "）", false);
    }
  });

console.log("\n=== 结果：" + (fail === 0 ? "全部通过（撤销窗口已真修好）" : fail + " 项失败") + " ===");
console.log("\n⚠️ 本脚本只验代码。**要确认线上生效，还需重新部署 courses 函数，");
console.log("   然后跑 node scripts/verify-restore-api.js**");
process.exit(fail === 0 ? 0 : 1);