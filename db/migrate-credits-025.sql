-- =============================================================================
-- migrate-credits-025.sql —— 把学分粒度从 0.5 放宽到 0.25（Day 26 B-004）
-- =============================================================================
--
-- 【为什么需要这个】
-- Day 26 做了培养方案自动导入，发现真实文档里「形势与政策」这类课是
-- 0.25 学分/学期（这份文档里就有 8 门）。于是把前端 app.js 和云函数
-- courseService 的校验都放宽到了 0.25。
--
-- **但数据库表没跟着改**，造成三���不一致：
--   前端     0.25 的整数倍           ✅ 已改
--   云函数    0.25 的整数倍           ✅ 已改
--   数据库   numeric(3,1) + mod(.,0.5) ❌ 没改
--
-- 后果：0.25 的课能通过前后端所有校验，却在数据库被 CHECK 约束拒掉，
-- 用户会看到一个「自己完全没做错」的报错。
--
-- 为什么当时没发现：导入流程测的是浏览器本机存储（localStorage），
-- 压根没碰云端那条路径。这个漏是"测试全绿但功能实际不可用"，
-- 比测试失败危险得多。
--
-- 【怎么用】
-- 1. 先跑第三节的备份表（务必先做）
-- 2. 再跑第二节的迁移
-- 3. 最后跑第四节的验收查询，逐条对得上才算完成
--
-- 本脚本只改 courses 表，categories 表的 required_credits 同理需要放宽
-- （见第二节的 2.3）。

-- =============================================================================
-- 一、执行前必读
-- =============================================================================
--
-- ⚠️ ALTER TABLE 会锁表。当前 courses 表只有测试数据（十几条），
--    锁表时间在毫秒级，可以放心执行。
--
-- ⚠️ 如果表里已经有 0.25 的数据（理论上不该有，因为 CHECK 会拒），
--    第 2.1 步会失败。看到报错请停下来查，不要跳过备份硬改。

-- =============================================================================
-- 二、迁移步骤
-- =============================================================================

-- 2.1 放宽学分精度：numeric(3,1) → numeric(3,2)
--
-- numeric(3,2) 的含义：总共 3 位数、其中 2 位小数 → 最大 9.99。
-- ⚠️ 注意精度也变小了（从最大 999.9 变成最大 9.99）。
--    实际课程学分不会超过 20，这个上限绰绰有余。
--    但云函数那边 MAX_CREDITS 也应该同步改成 9.99，两边才一致。
--
-- 已有数据都是 0.5 的倍数，从一位小数变两位小数是安全的（不会丢精度）。
ALTER TABLE public.courses
  ALTER COLUMN credits TYPE numeric(3,2);

-- 2.2 换掉 CHECK 约束：从 0.5 的倍数改成 0.25 的倍数
--
-- 必须先 DROP 再 ADD：PostgreSQL 不支持直接改 CHECK 约束。
ALTER TABLE public.courses
  DROP CONSTRAINT IF EXISTS courses_credits_half;

ALTER TABLE public.courses
  ADD CONSTRAINT courses_credits_quarter
  CHECK (credits > 0 AND mod(credits, 0.25) = 0);

-- 2.3 板块的「要求学分」同样放宽
--
-- 同一个问题：categories.required_credits 也是 numeric(3,1) + mod(.,0.5)。
-- 页面上板块要求学分同样允许 0.25，所以这里一起改。
ALTER TABLE public.categories
  ALTER COLUMN required_credits TYPE numeric(3,2);

ALTER TABLE public.categories
  DROP CONSTRAINT IF EXISTS categories_required_credits_half;

ALTER TABLE public.categories
  ADD CONSTRAINT categories_required_credits_quarter
  CHECK (required_credits IS NULL OR (required_credits > 0 AND mod(required_credits, 0.25) = 0));

-- 2.4 更新列注释（不改功能，但让 schema 说明跟实际一致）
COMMENT ON COLUMN public.courses.credits IS
  '学分，0.25 的倍数；用 numeric 而非 float，避免 0.1+0.2 类浮点误差';

COMMENT ON COLUMN public.categories.required_credits IS
  '要求学分；可空表示用户还没填（页面显示"未设置"）；0.25 的倍数';

-- =============================================================================
-- 三、备份（务必在第二节之前执行）
-- =============================================================================
--
-- 用 CREATE TABLE AS SELECT 而不是 ALTER TABLE RENAME，
-- 这样原表结构完全不动，出问题随时能切回去。

CREATE TABLE IF NOT EXISTS public.courses_backup_b004 AS
  SELECT * FROM public.courses;

CREATE TABLE IF NOT EXISTS public.categories_backup_b004 AS
  SELECT * FROM public.categories;

-- 确认备份有数据（应该和原表行数一致）
SELECT
  (SELECT count(*) FROM public.courses)AS 原表课程数,
  (SELECT count(*) FROM public.courses_backup_b004) AS 备份课程数,
  (SELECT count(*) FROM public.categories)               AS 原表板块数,
  (SELECT count(*) FROM public.categories_backup_b004)  AS 备份板块数;

-- =============================================================================
-- 四、验收（执行完第二节后逐条检查）
-- =============================================================================

-- 4.1 列类型应该是 numeric(3,2)
SELECT
  table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('courses', 'categories')
  AND column_name IN ('credits', 'required_credits')
ORDER BY table_name, column_name;
-- 期望：data_type = numeric，numeric_precision = 3，numeric_scale = 2

-- 4.2 约束应该在，且名字是新名字
SELECT conname, pg_get_constraintdef(oid) AS 定义
FROM pg_constraint
WHERE conrelid IN ('public.courses'::regclass, 'public.categories'::regclass)
  AND contype = 'c'
  AND (conname LIKE '%credits%')
ORDER BY conname;
-- 期望：courses_credits_quarter 和 categories_required_credits_quarter，
--       定义里是 mod(..., 0.25)；旧的 *_half 应该已经不在了

-- 4.3 关键验证：0.25 现在应该能存进去
--
-- 这一条是整个迁移的核心目的。用事务跑，测完自动回滚，不留测试数据。
BEGIN;
  INSERT INTO public.courses (id, name, credits, status)
  VALUES ('b004test001', 'B004验证用临时课', 0.25, 'planned');
  -- 预期：INSERT 0 1（成功）。如果报 check constraint 违规，说明迁移没成功。
ROLLBACK;
-- ROLLBACK 之后表里不会有这条数据

-- 4.4 确认 B-004 之前的老数据都还在、且值没变
SELECT count(*) AS 应有行数, sum(credits) AS 学分合计 FROM public.courses;
-- 对照备份表：
SELECT count(*) AS 备份行数, sum(credits) AS 备份学分合计
FROM public.courses_backup_b004;
-- 两行应该完全一致

-- 4.5 不该出现的值仍然被拒（确认约束没被改松）
BEGIN;
  -- 下面每条都**应该**报 CHECK 违规。如果某条插进去了，说明约束有问题
  INSERT INTO public.courses (id, name, credits, status) VALUES ('b004bad01', '负学分', -1, 'planned');
ROLLBACK;

BEGIN;
  INSERT INTO public.courses (id, name, credits, status) VALUES ('b004bad02', '零学分', 0, 'planned');
ROLLBACK;

BEGIN;
  INSERT INTO public.courses (id, name, credits, status) VALUES ('b004bad03', '非粒度', 1.3, 'planned');
ROLLBACK;

-- =============================================================================
-- 五、回滚（万一第二节出了问题）
-- =============================================================================
--
-- ALTER COLUMN TYPE 降回 numeric(3,1) 会把 0.25 四舍五入成 0.3，
-- 而 CHECK 又要求 0.5 的倍数 → 降精度后 0.25 的数据会被 CHECK 拒掉。
-- 所以**顺序很重要**：先删约束，再降精度，最后加回旧约束。
--
-- BEGIN;
--   ALTER TABLE public.courses DROP CONSTRAINT IF EXISTS courses_credits_quarter;
--   ALTER TABLE public.courses ALTER COLUMN credits TYPE numeric(3,1);
--   ALTER TABLE public.courses ADD CONSTRAINT courses_credits_half
--     CHECK (credits > 0 AND mod(credits, 0.5) = 0);
--   -- 数据层回滚：拿备份覆盖（会丢掉备份之后新增的记录，谨慎）
--   -- TRUNCATE public.courses;
--   -- INSERT INTO public.courses SELECT * FROM public.courses_backup_b004;
-- ROLLBACK;
-- COMMIT;
