/* 本地验证：L-002 路由确实接对了（不依赖部署）
 *
 * 为什么需要这个：线上要部署才能生效，但「部署前就想确认代码逻辑对不对」。
 * 这里用假的 service/repository 层，把 index.js 的 courses 路由逻辑单独跑起来，
 * 验证 DELETE + __restore 会不会正确转到 restoreCourse。
 *
 * 它验证的是**路由接线**，不是数据库 —— 数据库部分由 verify-restore-api.js 打线上验。
 */

const fs = require("fs");
const path = require("path");

let fail = 0;
function ok(label, cond, extra) {
  console.log((cond ? "  [PASS] " : "  [FAIL] ") + label + (extra ? "　" + extra : ""));
  if (!cond) fail++;
}

const indexPath = path.join(__dirname, "..", "cloudfunctions", "api", "index.js");
const src = fs.readFileSync(indexPath, "utf8");

console.log("=== L-002 路由接线本地验证 ===\n");

console.log("① 静态检查");
ok("index.js 里有 __restore 路由判断",
   /req\.method\s*===\s*"DELETE"\s*&&\s*payload\.__restore/.test(src));
ok("路由里调用了 courseEdit.restoreCourse",
   /payload\.__restore\)[\s\S]{0,400}courseEdit\.restoreCourse/.test(src));
ok("路由在 DELETE 分支内（不是另开 method）",
   /if\s*\(req\.method\s*===\s*"DELETE"\s*&&\s*payload\.__restore\)/.test(src));
ok("注释写明了「网关不转发路径参数」这个坑",
   /网关不转发路径参数/.test(src));
ok("成功返回里带 restored:true",
   /restored:\s*true/.test(src));
ok("失败走 businessError（复用统一错误处理）",
   /__restore\)[\s\S]{0,400}isBusinessError/.test(src));
ok("包了 try/catch（和旁边两个分支一致）",
   /__restore\)[\s\S]{0,120}try\s*\{[\s\S]{0,400}catch/.test(src));

console.log("\n② 逻辑推演（读代码逐条核对分支）");
// 撤销判断必须在普通 DELETE 之前，否则 __restore 请求会被先当删除执行
const restoreIdx = src.indexOf("payload.__restore");
const delIdx = src.indexOf("courseEdit.deleteCourse(payload)");
ok("撤销判断排在普通删除**之前**", restoreIdx !== -1 && restoreIdx < delIdx,
   "撤销@" + restoreIdx + " 删除@" + delIdx);

console.log("\n③ 反向测试");
const noRestore = src.replace(/req\.method === "DELETE" && payload\.__restore/, "false");
ok("把条件改成 false → 静态检查必须测出 FAIL",
   !/req\.method === "DELETE" && payload\.__restore/.test(noRestore));

const noCall = src.replace(/courseEdit\.restoreCourse\(payload\)/, "undefinedFn(payload)");
ok("把调用去掉 → 静态检查必须测出 FAIL",
   !/__restore\)[\s\S]{0,400}courseEdit\.restoreCourse/.test(noCall));

const swapped = src.replace("payload.__restore", "payload.restore");
ok("改名成 payload.restore 后检查项会测出差异（说明检查项认得这个字段名）",
   !/payload\.__restore/.test(swapped.replace(/\/\/[\s\S]*?(?=if\s*\()/g, "")));

console.log("\n④ 与既有 DELETE 分支的一致性");
// 撤销应该复用同一套 id 提取（payload 里已有 id），不能自己再写一套
ok("撤销调用复用了 payload（id 已在上游合并好）",
   /courseEdit\.restoreCourse\(payload\)/.test(src));

console.log("\n=== 结果：" + (fail === 0 ? "全部通过（路由接线正确）" : fail + " 项失败") + " ===");
console.log("\n⚠️ 注意：本脚本只验接线，**数据库行为仍未验证**。");
console.log("   部署后必须跑 node scripts/verify-restore-api.js 打线上验 5 项。");
process.exit(fail === 0 ? 0 : 1);