-- ============================================================
-- db/schema.sql —— 学分规划助手 · 建表脚本
-- 数据库：CloudBase PostgreSQL
--
-- 表结构来源：api-contract.md 第二节「本项目用哪两张表」
-- 原则：字段从契约推导，不另造。改结构必须先改契约再改这里。
--
-- 可重复执行：先删后建。
-- ⚠️ 警告：本脚本会清空两张表的全部数据，仅在开发阶段使用；
--    第 20 天部署上线后禁止再执行，线上数据变更一律用增量 SQL。
-- ⚠️ 本课程不登录、不建用户表：表中没有任何「身份 / 用户」字段，
--    唯一约束只加在业务字段上（板块名、板块+课程名）。
-- ============================================================

BEGIN;

-- 先删（顺序：被引用的表先删；CASCADE 同时删掉依赖它的索引与外键）
DROP TABLE IF EXISTS public.courses    CASCADE;
DROP TABLE IF EXISTS public.categories CASCADE;

-- ---------- 表 1：categories（学分板块） ----------
CREATE TABLE public.categories (
  id               varchar(32)  PRIMARY KEY,
  name             varchar(20)  NOT NULL UNIQUE,
  required_credits numeric(3,1) NULL,
  note             varchar(100) NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  updated_at       timestamptz  NOT NULL DEFAULT now(),

  -- 名称去空格后不能为空（契约：非空）
  CONSTRAINT categories_name_not_blank
    CHECK (btrim(name) <> ''),
  -- 要求学分：允许为空；填了就必须 >0 且是 0.5 的倍数（契约第二节）
  CONSTRAINT categories_required_credits_half
    CHECK (required_credits IS NULL OR (required_credits > 0 AND mod(required_credits, 0.5) = 0))
);

COMMENT ON TABLE  public.categories IS '学分板块：培养方案里的一个学分类别，如"专业选修"';
COMMENT ON COLUMN public.categories.id               IS '主键，字符串，与前端 id 一致';
COMMENT ON COLUMN public.categories.name             IS '板块名，非空且全局唯一，≤20 字';
COMMENT ON COLUMN public.categories.required_credits IS '要求学分；可空表示用户还没填（页面显示"未设置"）；0.5 的倍数';
COMMENT ON COLUMN public.categories.note             IS '特殊条件备注，如"须含 2 学分艺术类"，可空';

-- ---------- 表 2：courses（课程） ----------
CREATE TABLE public.courses (
  id                varchar(32)  PRIMARY KEY,
  name              varchar(30)  NOT NULL,
  credits           numeric(3,1) NOT NULL,
  -- 外键：指向板块。ON DELETE SET NULL 对应契约第 5 条 mode=move
  -- （删板块时不删课，把课置为"未归类"）
  category_id       varchar(32)  NULL REFERENCES public.categories(id) ON DELETE SET NULL,
  status            varchar(10)  NOT NULL DEFAULT 'planned',
  score             smallint     NULL,
  -- 契约第 9、10 条：软删除 + 5 秒撤销窗口
  deleted_at        timestamptz  NULL,
  delete_expires_at timestamptz  NULL,
  created_at        timestamptz  NOT NULL DEFAULT now(),
  updated_at        timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT courses_name_not_blank
    CHECK (btrim(name) <> ''),
  -- 学分必须 >0 且是 0.5 的倍数（契约第二节）
  CONSTRAINT courses_credits_half
    CHECK (credits > 0 AND mod(credits, 0.5) = 0),
  -- 状态二选一（契约：done 已修 / planned 计划修）
  CONSTRAINT courses_status_enum
    CHECK (status IN ('done', 'planned')),
  -- 成绩：可空；填了必须在 0–100（契约：<60 由应用层判定为不及格、不计学分）
  CONSTRAINT courses_score_range
    CHECK (score IS NULL OR (score BETWEEN 0 AND 100)),
  -- 同一板块下课程名不重复；跨板块允许同名
  CONSTRAINT courses_name_unique_in_category
    UNIQUE (category_id, name)
);

COMMENT ON TABLE  public.courses IS '课程：一门已修或计划修的课，属于某个板块';
COMMENT ON COLUMN public.courses.id                IS '主键，字符串';
COMMENT ON COLUMN public.courses.name              IS '课程名，非空，≤30 字';
COMMENT ON COLUMN public.courses.credits           IS '学分，0.5 的倍数；用 numeric 而非 float，避免 0.1+0.2 类浮点误差';
COMMENT ON COLUMN public.courses.category_id       IS '所属板块；NULL 表示"未归类"（板块被删后自动置空）';
COMMENT ON COLUMN public.courses.status            IS 'done=已修 / planned=计划修';
COMMENT ON COLUMN public.courses.score             IS '成绩 0–100，可空；为空不计入 GPA';
COMMENT ON COLUMN public.courses.deleted_at        IS '软删除时间；非 NULL 即已删除，列表接口不返回';
COMMENT ON COLUMN public.courses.delete_expires_at IS '撤销截止时间（本项目 5 秒）；超过后不可再 restore';

-- ---------- 索引 ----------
-- 列表查询最常按板块筛、按状态筛，且只查未删除的
CREATE INDEX idx_courses_category_id ON public.courses (category_id);
CREATE INDEX idx_courses_status      ON public.courses (status);
CREATE INDEX idx_courses_active      ON public.courses (category_id) WHERE deleted_at IS NULL;

COMMIT;
