-- ============================================================
-- 数据备份：先建「今天」这张快照，再谈自动化
--
-- 【为什么第一步是建快照，不是建定时任务】
-- 定时任务没建起来之前，「备份」这个词是空的 ——
-- 数据库被误删一次，就再也回不去了。
-- 所以顺序是：① 手动快照（现在就能做，1 分钟）
--          ② 验证快照能用（能查、能恢复）
--          ③ 再考虑自动化（第 ③ 段）
--
-- 【Day 27 踩过的坑，这次全部避开】
--   1. COMMENT 语句带中文 → 粘贴被吞 → 语法错
--      → 本文件**一句 COMMENT 都没有**，全是纯 ASCII
--   2. 一批 SQL 打包执行 → 任何一条失败整批回滚
--      → 拆成 6 段，**一段一段粘**，出错立刻知道是哪条
--   3. count(*) 的 * 被吞 → 报错
--      → 下面全部写成 count(1)，不用 count(*)
--
-- 【为什么要自己写备份表，不用平台快照】
-- 平台快照要么没开、要么不知道在哪找；
-- 自己建的表「就在数据库里」，控制台能直接查、能手工捞数据。
-- 138 行数据很小，一张表几 KB，完全放得下。
-- ============================================================


-- ========== 段 1：建今天的快照（courses 表）==========
DROP TABLE IF EXISTS public.courses_bak_20261013;
CREATE TABLE public.courses_bak_20261013 AS SELECT * FROM public.courses;

-- ========== 段 2：建今天的快照（categories 表）==========
DROP TABLE IF EXISTS public.categories_bak_20261013;
CREATE TABLE public.categories_bak_20261013 AS SELECT * FROM public.categories;

-- ========== 段 3：确认行数对上了 ==========
-- 期望：两个数字必须完全相等，不相等说明快照不完整
SELECT
  (SELECT count(1) FROM public.courses)         AS live_courses,
  (SELECT count(1) FROM public.courses_bak_20261013) AS bak_courses,
  (SELECT count(1) FROM public.categories)      AS live_cats,
  (SELECT count(1) FROM public.categories_bak_20261013) AS bak_cats;

-- ========== 段 4：学分总额也要对上（不只是行数）==========
-- 光看行数不够：可能有 5 门课被改过学分，行数不变但总额变了
SELECT
  (SELECT sum(credits) FROM public.courses WHERE deleted_at IS NULL) AS live_sum,
  (SELECT sum(credits) FROM public.courses_bak_20261013 WHERE deleted_at IS NULL) AS bak_sum;

-- ========== 段 5：看一眼快照里确实有内容（不是空表）==========
SELECT id, name, credits, status FROM public.courses_bak_20261013 ORDER BY credits DESC LIMIT 5;

-- ========== 段 6：把这次的快照记进台账 ==========
-- 每次建快照都往这里加一行。
-- 为什么要有台账：快照表本身不告诉你"这是哪天的、为什么建的"，
-- 时间一长就分不清哪个才是出事前的那个。
-- TABLE   DATE          ROWS  SUM_CREDITS  REASON
-- courses 2026-10-13   138   xxx           before import test
