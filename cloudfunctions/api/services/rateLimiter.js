/**
 * services/rateLimiter.js —— 写接口限流（Day 23）
 *
 * 为什么需要：实测发现写接口完全没有限流——连续 12 次 POST 全部 201，
 * 任何人拿到链接都能往数据库灌垃圾数据、消耗配额。
 *
 * ⚠️ **必须知道的局限**（别把它当 DDoS 防护）：
 * 计数存在**云函数实例的内存**里。云函数会被回收重建，一重建计数就清零。
 * 所以它能挡住「短时间内密集轰炸」，挡不住「慢速均匀爬取」。
 * 真要严格限流得在网关侧做或用 Redis 计数——本项目一期不做。
 * 它只是**顺手加的护栏**，不是安全边界。
 *
 * 为什么只限写请求：
 *   - 读接口不消耗数据库写入配额
 *   - 页面可能轮询/刷新频繁，限读会误伤正常使用
 */

// 环境变量可调，留空用默认 20 次/分
const DEFAULT_PER_MIN = 20;
const WINDOW_MS = 60 * 1000;

/** IP → 时间戳数组（滑动窗口里最近 60 秒的请求时刻） */
const hits = new Map();

/**
 * 取调用方 IP。
 *
 * ⚠️ 取不到就返回 "unknown"，**不因为取不到 IP 就放行全部**——
 * 取不到 IP 时所有请求会共用一个桶，反而互相挤。
 * 这种情况我们选择保守处理（照样计数），宁可误伤也不给无限放行。
 */
function clientIp(req) {
  const ctx = (req && req.rawEvent && req.rawEvent.requestContext) || {};
  const headers = (req && req.rawEvent && req.rawEvent.headers) || {};

  // 网关通常会传真实 IP 的这几个头之一
  const candidates = [
    headers["x-forwarded-for"],
    headers["X-Forwarded-For"],
    headers["x-real-ip"],
    ctx.identity && ctx.identity.sourceIp,
    ctx.sourceIp,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && v) {
      // X-Forwarded-For 可能是 "client, proxy1, proxy2"，第一个才是真实来源
      return v.split(",")[0].trim();
    }
  }
  return "unknown";
}

/**
 * 检查是否超过阈值。超了返回 true。
 *
 * @param {object} req parseRequest 的结果（用到 rawEvent 取 IP）
 * @param {string} method 只对写方法计数
 */
function isRateLimited(req, method) {
  if (!["POST", "PATCH", "DELETE", "PUT"].includes(method)) return false;

  const limit = Number(process.env.RATE_LIMIT_PER_MIN) || DEFAULT_PER_MIN;
  const ip = clientIp(req);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // 取出该 IP 的历史记录，丢掉窗口外的
  const list = (hits.get(ip) || []).filter(function (t) { return t > windowStart; });

  if (list.length >= limit) {
    // 写回（保留未过期的那些，让下次仍然能正确判断）
    hits.set(ip, list);
    return true;
  }

  list.push(now);
  hits.set(ip, list);
  return false;
}

/**
 * 清理过期条目，避免 Map 无限增长。
 * 云函数实例内存有限，IP 多了会漏内存。定时调用即可（入口层每次请求顺手调）。
 */
function sweep() {
  const now = Date.now();
  const windowStart = now - WINDOW_MS;
  let removed = 0;
  hits.forEach(function (list, ip) {
    const alive = list.filter(function (t) { return t > windowStart; });
    if (alive.length === 0) { hits.delete(ip); removed++; }
    else if (alive.length !== list.length) { hits.set(ip, alive); }
  });
  return removed;
}

module.exports = {
  isRateLimited: isRateLimited,
  clientIp: clientIp,
  sweep: sweep,
  DEFAULT_PER_MIN: DEFAULT_PER_MIN,
  // 供测试：清空计数
  _reset: function () { hits.clear(); },
  _size: function () { return hits.size; },
};
