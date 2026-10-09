/**
 * services/errorResponses.js —— 三类错误的统一中文提示（Day 23）
 *
 * 为什么要单独一个文件：
 *   之前错误文案散在各处，措辞不统一、还容易漏改。
 *   把「什么错 → 对外说什么」收在一处，新增错误类型时只改这一张表。
 *
 * ═══════════════════════════════════════════════════════════════
 *  三类错误的划分标准（按「谁该去解决」分，不是按技术分类）
 * ═══════════════════════════════════════════════════════════════
 *
 *  ① 用户输入错（400 / 404 / 409 / 405 / 429）
 *     → 用户自己改一下就好。**必须告诉他具体改什么**，
 *        不能只说"参数错误"——那等于让用户猜。
 *     → 例：「学分必须是 0.5 的倍数，现在收到的是「2.3」」
 *
 *  ② 网络/接口错（502 / 503 / 504）
 *     → 用户等一会儿重试就好，**不要说技术细节**（连接超时、网关 502）。
 *     → 例：「数据库暂时连不上，请稍后再试」
 *
 *  ③ 服务端错（500 / 未预期异常）
 *     → 用户只能干等。**一句话就好**，内部细节全部进日志。
 *     → 例：「服务出了点问题，稍后再试」
 *
 * ⚠️ 最重要的一条规矩：**分级不等于泄露**。
 *    三类都只说人话，绝不出现表名、API Key、网关错误码、堆栈。
 */

/** 按 HTTP 状态码取「用户可以做什么」的建议动作 */
const USER_ACTIONS = {
  400: "请检查填写的内容",
  404: "请确认这条记录是否存在",
  405: "请用正确的操作方式",
  409: "请换一个名字或稍后再试",
  429: "请稍等一会儿再操作",
};

/**
 * 第一类：用户输入错。
 *
 * @param {string} message 具体的、能指出问题的中文（例如"学分必须是 0.5 的倍数…"）
 * @param {number} status   400 / 404 / 409 / 405 / 429
 * @returns {{ok:false, error:string, category:string, suggestion:string}}
 */
function inputError(message, status) {
  return {
    ok: false,
    error: message,
    category: "USER_INPUT", // ← 只进日志，不返回给前端
    suggestion: USER_ACTIONS[status] || "请检查填写的内容",
  };
}

/**
 * 第二类：网络 / 接口错。
 *
 * ⚠️ 这里有个刻意的取舍（Day 23 想清楚的）：
 *   数据库 401（API Key 无效/缺失）在**技术上**是配置问题，不是网络问题。
 *   但对外**不说「API Key 无效」**，理由有二：
 *     ① 泄露了"系统用了 API Key"这个实现细节
 *     ② 普通用户看到会以为是自己操作错了，反复重试却永远不会好
 *   部署者要排查怎么办？→ **看服务端日志**，那里有 [DB_UNREACHABLE] + 完整原文。
 *   所以文案末尾统一带一句「若持续失败请联系部署者」，给两边都留了出路。
 *
 * @param {string} message 中文说明（不含量内部术语）
 * @param {string} kind   DB_UNREACHABLE / DB_TIMEOUT / DB_SERVER_ERROR（只进日志）
 */
function networkError(message, kind) {
  return {
    ok: false,
    error: message,
    category: "NETWORK", // ← 只进日志
    kind: kind || "NETWORK",
    suggestion: "稍后重试；若持续失败请联系部署者",
  };
}

/**
 * 第三类：服务端错（未预期的异常）。
 *
 * ⚠️ 这一类**只给一句话**，什么都不多说。
 *    真正的原因（堆栈、SQL、内部变量名）全部写进服务端日志。
 */
function serverError(friendlyMessage) {
  return {
    ok: false,
    error: friendlyMessage || "服务出了点问题，稍后再试",
    category: "SERVER", // ← 只进日志
    suggestion: "稍后重试",
  };
}

/**
 * 把内部 kind 映射成第二类（网络/接口错）的中文文案。
 * 集中在这里，避免"某个 kind 忘了翻"导致回落到笼统提示。
 */
const NETWORK_TEXTS = {
  DB_UNREACHABLE: "数据库暂时连不上，请稍后再试",  // 不说"API Key"是刻意的，见上方注释
  DB_TIMEOUT: "数据库响应超时，请稍后再试",
  DB_SERVER_ERROR: "数据库服务暂时异常，请稍后再试",
  DB_NOT_FOUND: "数据库访问异常，请稍后再试",
  DB_CONFLICT: "数据库拒绝了这次操作，请稍后再试",
};

function fromInternalKind(kind, fallbackMessage) {
  if (kind && NETWORK_TEXTS[kind]) {
    return networkError(NETWORK_TEXTS[kind], kind);
  }
  return serverError(fallbackMessage);
}

module.exports = {
  inputError: inputError,
  networkError: networkError,
  serverError: serverError,
  fromInternalKind: fromInternalKind,
  USER_ACTIONS: USER_ACTIONS,
  NETWORK_TEXTS: NETWORK_TEXTS,
};
