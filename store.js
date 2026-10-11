// 学分规划助手 —— 本机存储读写封装（Day 7 步骤 2）
// 说明：一期没有服务器与数据库，数据全部存在用户自己的浏览器里。
// 存储结构见 TECH_DESIGN.md 第四节：{ version, categories: [], courses: [] }
//
// Day 26 新增 plan 字段（培养方案信息），用于总学分对账：
//   { sourceName: 文件名, totalRequired: 培养方案写的总学分, importedAt: 时间戳 }
// 老数据没有这个字段，normalizeData 会补一个空对象，所以旧数据照样能读。

const STORAGE_KEY = "creditPlanner.v1";
const STORAGE_VERSION = 1;
const BACKUP_KEY = "creditPlanner.backup";

// 空数据结构（首次访问时使用）
function emptyData() {
  return {
    version: STORAGE_VERSION,
    categories: [],
    courses: [],
    plan: null
  };
}

// 把任意输入补齐成合法结构（缺字段、类型不对时自动兜底）
function normalizeData(input) {
  const src = (input && typeof input === "object") ? input : {};
  // plan 是后加的字段，老数据没有 → 补 null，读取方判空即可
  const plan = (src.plan && typeof src.plan === "object")
    ? {
        sourceName: typeof src.plan.sourceName === "string" ? src.plan.sourceName : "",
        totalRequired: (typeof src.plan.totalRequired === "number" && isFinite(src.plan.totalRequired))
          ? src.plan.totalRequired : null,
        importedAt: typeof src.plan.importedAt === "string" ? src.plan.importedAt : ""
      }
    : null;
  return {
    version: STORAGE_VERSION,
    categories: Array.isArray(src.categories) ? src.categories : [],
    courses: Array.isArray(src.courses) ? src.courses : [],
    plan: plan
  };
}

// 读取全部数据
// 返回 { data, error }：error 为 null 表示一切正常
function loadData() {
  let raw = null;

  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (err) {
    return {
      data: emptyData(),
      error: "本机存储不可用（可能处于隐私模式），这次的改动可能无法保存。"
    };
  }

  if (!raw) {
    return { data: emptyData(), error: null };
  }

  try {
    return { data: normalizeData(JSON.parse(raw)), error: null };
  } catch (err) {
    // 数据损坏时：保留原始内容一份备份，再退回空结构，避免页面直接崩掉
    try {
      localStorage.setItem(BACKUP_KEY, raw);
    } catch (backupErr) {
      // 备份失败也不影响主流程
    }
    return {
      data: emptyData(),
      error: "数据读取失败（内容可能已损坏），已保留原始内容备份，本次显示为空数据。"
    };
  }
}

// 写回全部数据
// 返回 { ok, message }
function saveData(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeData(data)));
    return { ok: true, message: "" };
  } catch (err) {
    return {
      ok: false,
      message: "保存失败：数据仅在本次打开期间有效，请勿关闭页面。"
    };
  }
}

// 供后续步骤（板块、课程、统计）调用
window.CreditPlanner = {
  STORAGE_KEY: STORAGE_KEY,
  STORAGE_VERSION: STORAGE_VERSION,
  BACKUP_KEY: BACKUP_KEY,
  emptyData: emptyData,
  normalizeData: normalizeData,
  loadData: loadData,
  saveData: saveData
};
