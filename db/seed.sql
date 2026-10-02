-- ============================================================
-- db/seed.sql —— 学分规划助手 · 种子数据（可重复执行）
-- 数据库：CloudBase PostgreSQL
--
-- 结构：先删 → 再建 → 再插入。重复执行不报错，随时可推倒重来。
-- ⚠️ 只在开发阶段使用：本脚本会清空两张表。
--    第 20 天部署上线后禁止再执行，否则会清空真实数据。
--
-- 数据用途：验证「表真实存在 + 能查到数据行」。
--    第 17 天接入真实数据后，页面的主数据不再依赖本脚本。
-- ⚠️ 本文件自带的建表语句与 db/schema.sql 保持一致；
--    改表结构时两处须同步修改（契约 → schema.sql → seed.sql）。
-- ============================================================

BEGIN;

-- ---------- 1. 先删（被引用的表先删） ----------
DROP TABLE IF EXISTS public.courses    CASCADE;
DROP TABLE IF EXISTS public.categories CASCADE;

-- ---------- 2. 再建（与 schema.sql 同结构） ----------
CREATE TABLE public.categories (
  id               varchar(32)  PRIMARY KEY,
  name             varchar(20)  NOT NULL UNIQUE,
  required_credits numeric(3,1) NULL,
  note             varchar(100) NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT categories_name_not_blank
    CHECK (btrim(name) <> ''),
  CONSTRAINT categories_required_credits_half
    CHECK (required_credits IS NULL OR (required_credits > 0 AND mod(required_credits, 0.5) = 0))
);

CREATE TABLE public.courses (
  id                varchar(32)  PRIMARY KEY,
  name              varchar(30)  NOT NULL,
  credits           numeric(3,1) NOT NULL,
  category_id       varchar(32)  NULL REFERENCES public.categories(id) ON DELETE SET NULL,
  status            varchar(10)  NOT NULL DEFAULT 'planned',
  score             smallint     NULL,
  deleted_at        timestamptz  NULL,
  delete_expires_at timestamptz  NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT courses_name_not_blank
    CHECK (btrim(name) <> ''),
  CONSTRAINT courses_credits_half
    CHECK (credits > 0 AND mod(credits, 0.5) = 0),
  CONSTRAINT courses_status_enum
    CHECK (status IN ('done', 'planned')),
  CONSTRAINT courses_score_range
    CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  CONSTRAINT courses_name_unique_in_category
    UNIQUE (category_id, name)
);

CREATE INDEX idx_courses_category_id ON public.courses (category_id);
CREATE INDEX idx_courses_status      ON public.courses (status);
CREATE INDEX idx_courses_active      ON public.courses (category_id) WHERE deleted_at IS NULL;

-- ---------- 3. 再插入：categories（6 行） ----------
INSERT INTO public.categories (id, name, required_credits, note) VALUES
  ('c1', '通识必修',   38,   NULL),
  ('c2', '专业核心',   42,   NULL),
  ('c3', '专业选修',   12,   '须含 2 学分艺术类'),
  ('c4', '通识选修',   10,   '至少 2 学分艺术类'),
  ('c5', '实践环节',    8,   NULL),
  ('c6', '自由选修',   NULL, '要求学分未定，等培养方案出来再填');   -- 故意留空，验证可空分支

-- ---------- 4. 再插入：courses（9 行） ----------
INSERT INTO public.courses (id, name, credits, category_id, status, score) VALUES
  ('k01', '大学英语',       3,   'c1', 'done',    72),
  ('k02', '高等数学A',      4,   'c2', 'done',    88),
  ('k03', '大学物理B',      3.5, 'c2', 'done',    76),
  ('k04', '天文学导论',     3,   'c2', 'done',    91),
  ('k05', '实测天体物理',   2.5, 'c2', 'done',    58),   -- 不及格：按契约不计入已修学分
  ('k06', '天体测量学',     3,   'c3', 'planned', NULL),  -- 计划修：不填成绩
  ('k07', '天体力学',       3,   'c3', 'planned', NULL),
  ('k08', '艺术鉴赏',       2,   'c4', 'done',    85),
  ('k09', '学术讲座',       1.5, NULL, 'done',    NULL);  -- 未归类：category_id 为空

COMMIT;

-- ============================================================
-- 验证（执行完后单独跑这两条，应各看到 6 行 / 9 行）
-- ============================================================
-- SELECT id, name, required_credits, note FROM public.categories ORDER BY id;
-- SELECT id, name, credits, category_id, status, score FROM public.courses ORDER BY id;
