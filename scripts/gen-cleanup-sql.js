/* 生成清理测试垃圾的 SQL（Day 29）
 *
 * 【为什么要清理】
 *   云库 courses 表里有 185 行：8 门真实数据（存活）+ 99 门测试垃圾（软删）
 *   + 其他历史测试记录。垃圾是 Day 8～22 我跑自检时插进去的，
 *   名字长这样：「频率测试0」「限流验证课18」「干验26605」……
 *
 *   它们是软删状态，接口看不见，但**还占着表**。
 *   对试用者：列表是干净的（只看存活），影响不大；
 *   对数据库：99 门垃圾约占 85%，不清理迟早出问题。
 *
 * 【安全设计：三道护栏】
 *   ① 只删 deleted_at IS NOT NULL 的行 —— 绝不碰存活的
 *   ② 显式排除真实数据 id（k01~k09）—— 双保险，
 *      即使 deleted_at 因别的原因被清空，真实数据也不受影响
 *   ③ 分三步执行：先 SELECT 看清单 → 再 DELETE → 最后核对
 *
 * 【重要】这个脚本只生成 SQL，**不执行**。
 *   删除是人工操作（要在 CloudBase 控制台跑）。
 */

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "db", "cleanup-test-data.sql");
const jsonPath = path.join(__dirname, "..", "db", "export-20261014", "data.json");

const d = JSON.parse(fs.readFileSync(jsonPath, "utf8"));

// 真实数据 = id 以 k 开头的（seed.sql 里的 9 门）
const real = d.courses.filter((c) => /^k\d/.test(c.id));
const realIds = real.map((c) => c.id);
const junk = d.courses.filter((c) => !/^k\d/.test(c.id));

console.log("=== 清理测试垃圾：SQL 生成 ===\n");
console.log("真实数据 " + real.length + " 门（必须保留）：");
real.forEach((c) => console.log("  " + c.id + "  " + c.name));
console.log("");
console.log("测试垃圾 " + junk.length + " 门（待清理，都在软删状态）");
console.log("");

// 按名字特征归类，方便你核对
const groups = {};
junk.forEach((c) => {
  const n = c.name || "";
  let g = "其他";
  if (/频率测试/.test(n)) g = "频率测试0~N";
  else if (/限流验证课/.test(n)) g = "限流验证课0~N";
  else if (/限流回归课/.test(n)) g = "限流回归课1~N";
  else if (/传id测试/.test(n)) g = "传id测试（DELETE 回归用）";
  else if (/复现测试|对比测试|分解验证|修复验证/.test(n)) g = "复现/对比/分解/修复验证";
  else if (/清单测试课|云端检查台|周验收|三件套|反假检测|干验|预检后/.test(n)) g = "各阶段验收课";
  else if (/^__/.test(n)) g = "探针残留（__ 开头）";
  groups[g] = (groups[g] || 0) + 1;
});
console.log("垃圾分类（便于核对）：");
Object.keys(groups).sort().forEach((g) => {
  console.log("  " + g + "：" + groups[g] + " 门");
});
console.log("");

const idList = realIds.map((id) => "'" + id + "'").join(", ");

const sql = `-- ============================================================
-- 清理测试垃圾数据（Day 29 生成，执行前请先跑第 1 步 SELECT 核对）
--
-- 【背景】
--   courses 表约 185 行：8 门真实课程（存活）+ 约 99 门测试垃圾（软删）
--   垃圾是 Day 8~22 自动化自检插的，插完就软删，从不清���。
--   它们接口看不见（列表只返回 deleted_at IS NULL），
--   但确实还占着表 —— 占 85% 的行。
--
-- 【三道安全护栏】
--   1. 只删 deleted_at IS NOT NULL 的行 → 绝不碰存活的真实数据
--   2. 显式排除真实 id（${realIds.join(", ")}）→ 双保险
--   3. 分三步：SELECT 核对 → DELETE → 核对结果
--
-- 【真实数据清单（${real.length} 门，绝不能删）】
${real.map((c) => "   " + c.id + "  " + c.name).join("\n")}
--
-- ⚠️ 第 1 步的 SELECT 结果应该全是「测试」类名字。
--    如果里面出现了上面清单里的课程名，**立刻停止**，把结果发出来。
-- ============================================================


-- ---------------------------------------------------------------
-- 第 1 步：先看清楚要删什么（只查不删）
-- ---------------------------------------------------------------
SELECT id, name, deleted_at
FROM public.courses
WHERE deleted_at IS NOT NULL
  AND id NOT IN (${idList})
ORDER BY name
LIMIT 30;
-- 上面只显示前 30 条；想看全貌把 LIMIT 去掉。

-- 想先数一数有多少条：
-- SELECT count(1) AS 待删除 FROM public.courses
--   WHERE deleted_at IS NOT NULL AND id NOT IN (${idList});


-- ---------------------------------------------------------------
-- 第 2 步：确认无误后再执行（把上面的 SELECT 注释掉，只留这段）
-- ---------------------------------------------------------------
DELETE FROM public.courses
WHERE deleted_at IS NOT NULL
  AND id NOT IN (${idList});


-- ---------------------------------------------------------------
-- 第 3 步：核对结果
-- ---------------------------------------------------------------
-- 应该剩下 ${real.length} 门真实数据
-- SELECT count(1) AS 存活 FROM public.courses WHERE deleted_at IS NULL;
-- SELECT id, name FROM public.courses WHERE deleted_at IS NULL ORDER BY id;


-- ============================================================
-- 【如果第 2 步报外键错误】
--   说明有其他表引用了 courses。用这条先查：
--     SELECT * FROM information_schema.table_constraints
--     WHERE constraint_type = 'FOREIGN KEY'
--       AND referenced_table_name = 'courses';
--   确认没有再决定要不要级联删除，别直接加 CASCADE。
-- ============================================================
`;

fs.writeFileSync(OUT, sql, "utf8");
console.log("已生成：" + OUT);
console.log("大小：" + fs.statSync(OUT).size + " 字节");
console.log("");
console.log("=== 下一步（你要做的） ===");
console.log("1. 打开 CloudBase 控制台 → SQL 数据库 → 新建查询");
console.log("2. 只粘「第 1 步」的 SELECT，先看要删哪些");
console.log("3. 确认里面**没有**上面列出的 " + real.length + " 门真实课程");
console.log("4. 再粘「第 2 步」的 DELETE");
console.log("5. 最后跑「第 3 步」核对，应该剩 " + real.length + " 门");
console.log("");
console.log("⚠️ 我不代你执行删除 —— 这是不可逆操作，且是人工操作。");
console.log("⚠️ 但**删之前建议再导一次备份**（软删的数据删掉就没了）：");
console.log("   见 db/EXPORT_RESTORE.md");