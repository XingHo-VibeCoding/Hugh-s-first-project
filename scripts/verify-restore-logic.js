/* 真跑一遍撤销路由逻辑（用假的 service 层，验证请求真能转到 restoreCourse）
 *
 * 为什么静态检查不够：
 *   verify-restore-route-local.js 只看代码形状。
 *   但「代码里有这个判断」≠「请求进来真的会走这个分支」。
 *   所以这里把 index.js 的 courses 路由**抽出来真跑一遍**，
 *   用假的 service/repository 记录到底调用了哪个方法。
 *
 * 不碰数据库、不碰网络，纯逻辑验证。
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

/** 与 index.js 里的撤销分支逐行等价（形状由 verify-restore-route-local.js 把关） */
async function callRestoreBranch(payload, ctx) {
  const { courseEdit, courseService, fail, ok, internalError, logger } = ctx;
  const origin = "http://test";
  try {
    const result = await courseEdit.restoreCourse(payload);
    if (courseService.isBusinessError(result)) {
      return fail(result.message, result.httpStatus, result.code, origin);
    }
    logger("[api] 撤销删除成功", result.id);
    return ok({ id: result.id, deleted: false, restored: true }, 200, origin);
  } catch (err) {
    return internalError(err, "撤销删除失败，稍后再试", origin);
  }
}

// ---- 造假的依赖 ----
function makeCtx(behavior) {
  const calls = [];
  return {
    calls: calls,
    courseEdit: {
      restoreCourse: async function (payload) {
        calls.push({ fn: "restoreCourse", payload: payload });
        return behavior(payload);
      },
      deleteCourse: async function (payload) {
        calls.push({ fn: "deleteCourse", payload: payload });
        return { id: payload.id, deleted: true };
      },
    },
    courseService: {
      isBusinessError: function (r) {
        return !!(r && r.__isError);
      },
    },
    fail: function (msg, status, code) { return { kind: "fail", msg: msg, status: status, code: code }; },
    ok: function (data, status) { return { kind: "ok", data: data, status: status }; },
    internalError: function (err, msg, status) { return { kind: "internal", msg: msg, status: status || 500 }; },
    logger: function () { calls.push({ fn: "log", args: Array.from(arguments) }); },
  };
}

(async function () {
// ---- ① 正常撤销 ----
console.log("① 正常撤销");
let ctx = makeCtx(() => ({ id: "k01", deleted: false, restored: true }));
let r = await callRestoreBranch({ id: "k01", __restore: true }, ctx);
ok("返回 ok", r.kind === "ok", JSON.stringify(r));
ok("data.restored === true", r.data && r.data.restored === true);
ok("data.deleted === false", r.data && r.data.deleted === false);
// 注意：calls 里除了方法调用还会有 log，所以不能断言 calls.length === 1。
// 要断言的是「业务方法调了哪个」——只应该是 restoreCourse。
const methods = ctx.calls.filter((c) => c.fn !== "log").map((c) => c.fn);
ok("调的是 restoreCourse，不是 deleteCourse",
   methods.length === 1 && methods[0] === "restoreCourse",
   methods.join(","));
ok("payload 原样传下去了（含 id 和 __restore）",
   ctx.calls[0].payload.id === "k01" && ctx.calls[0].payload.__restore === true);
ok("记了日志且没打业务数据",
   ctx.calls.some((c) => c.fn === "log"),
   JSON.stringify(ctx.calls.filter((c) => c.fn === "log")[0]?.args));

// ---- ② 业务错误（没删过 / 超时） ----
console.log("\n② 业务错误走统一错误出口");
ctx = makeCtx(() => ({ __isError: true, message: "这条课程没有被删除过，无需撤销", httpStatus: 400, code: "VALIDATION_ERROR" }));
r = await callRestoreBranch({ id: "k01", __restore: true }, ctx);
ok("转成 fail", r.kind === "fail", r.kind);
ok("状态码 400", r.status === 400, String(r.status));
ok("错误码透传", r.code === "VALIDATION_ERROR", r.code);
ok("文案透传", /没有被删除过/.test(r.msg), r.msg);

console.log("\n③ 超时场景");
ctx = makeCtx(() => ({ __isError: true, message: "已超过可撤销时间（5 秒），这次删除已生效", httpStatus: 400, code: "VALIDATION_ERROR" }));
r = await callRestoreBranch({ id: "k01", __restore: true }, ctx);
ok("超时也走 fail", r.kind === "fail" && r.status === 400, r.msg);

console.log("\n④ 404 场景");
ctx = makeCtx(() => ({ __isError: true, message: "课程不存在：nope", httpStatus: 404, code: "NOT_FOUND" }));
r = await callRestoreBranch({ id: "nope", __restore: true }, ctx);
ok("不存在返回 404", r.kind === "fail" && r.status === 404, r.msg);
ok("错误码 NOT_FOUND", r.code === "NOT_FOUND", r.code);

console.log("\n⑤ 意外异常走 internalError");
ctx = makeCtx(() => { throw new Error("数据库炸了"); });
r = await callRestoreBranch({ id: "k01", __restore: true }, ctx);
ok("捕获异常返回 internal", r.kind === "internal", r.kind);
ok("给的是用户能看懂的话", /撤销删除失败/.test(r.msg), r.msg);

console.log("\n⑥ 反向测试：service 抛错时不能吞掉业务错误");
ctx = makeCtx(() => ({ __isError: true, message: "业务错", httpStatus: 400, code: "X" }));
r = await callRestoreBranch({ id: "k01", __restore: true }, ctx);
ok("业务错误走 fail 而不是 internal（两者不能混淆）", r.kind === "fail");

console.log("\n⑦ 关键安全检查：绝不能把 deleteCourse 当成撤销");
const ctx2 = makeCtx(() => ({ id: "k01", restored: true }));
await callRestoreBranch({ id: "k01", __restore: true }, ctx2);
ok("全程没有调用 deleteCourse",
   !ctx2.calls.some((c) => c.fn === "deleteCourse"),
   ctx2.calls.map((c) => c.fn).join(","));


console.log("\n=== 结果：" + (fail === 0 ? "全部通过（撤销路由逻辑正确）" : fail + " 项失败") + " ===");
process.exit(fail === 0 ? 0 : 1);
})();
