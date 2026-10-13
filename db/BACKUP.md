# db/BACKUP.md —— 数据备份与恢复

> **一句话现状**：代码和静态文件能靠 git tag 回退，**但数据库回不了**。
> 这份文档补上这一块。

---

## 一、现状（先说清楚，避免误以为已经有备份了）

| 东西 | 有备份吗 | 怎么回退 |
|---|---|---|
| 业务代码 | ✅ 有 | `git revert` 或从 tag 取回 |
| 静态文件（网站） | ✅ 有 | `git archive <tag>` 后覆盖上传 |
| 数据库 `courses` / `categories` | ⚠️ **平台层面应该有（待你去确认）**，我们自己确定有的是手工快照 | 平台备份走控制台恢复；手工快照用 `INSERT INTO ... SELECT` |

**两件要分清的事**：
- **平台自动备份**：CloudBase PostgreSQL 底层由腾讯云提供，
  官方文档写明有自动备份 + 手动备份 + 时间点恢复 ——
  但**我还没去控制台确认过是不是真的开着**，默认保留 7 天。
  → 见第四节，你去「备份恢复」页确认。
- **手工快照表**（`courses_backup_b004` / `*_bak_20261013`）：
  这是我们自己在数据库里建的表，**确定存在、确定能查**。
  `courses_backup_b004` 是 Day 27 做学分迁移那一刻的快照，**不是现在的状态**。

---

## 二、手动建快照（1 分钟，做完就能回退）

### 执行入口

`C:/Users/w3224/Desktop/【粘贴到CloudBase】建快照-20261013.txt`
（仓库里 `db/backup-snapshot.sql` 是同一份内容，作技术记录用）

⚠️ **和 Day 27 一样：不要整份复制执行**，**一段一段粘**。
原因见下一节 —— CloudBase 把一批 SQL 包在一个事务里，任何一条失败整批回滚。

### 分 6 段，每段做什么

| 段 | 做什么 | 怎么算成功 |
|---|---|---|
| 1 | 建 `courses_bak_20261013` 快照 | 无报错 |
| 2 | 建 `categories_bak_20261013` 快照 | 无报错 |
| 3 | **比行数** | `live_courses` = `bak_courses`，`live_cats` = `bak_cats` |
| 4 | **比学分总额** | `live_sum` = `bak_sum` |
| 5 | 抽查 5 行看看 | 能看到真实的课程名和学分 |
| 6 | 记台账 | 写下日期、行数、学分总额、为什么建 |

### ⚠️ 第 3、4 段为什么都要

**光看行数会漏**：如果有 5 门课被改过学分，行数完全不变，
但总额变了 —— 只查行数会漏掉这种情况。所以总额也要比。

### 为什么不用平台快照

平台快照要么没开、要么不知道在哪找。**自己建的表就在数据库里**，
控制台能直接查、能手工捞数据，138 行也就几 KB。

---

## 三、恢复（真出事时照这个做）

### 情况 A：数据被误删了

```sql
-- 1. 先看快照里有没有你要的数据
SELECT count(1) FROM public.courses_bak_20261013;

-- 2. 备份当前状态（恢复前先留一份，别直接覆盖）
CREATE TABLE public.courses_bak_broken_20261013 AS SELECT * FROM public.courses;

-- 3. 删掉当前数据
TRUNCATE public.courses;

-- 4. 从快照灌回来
INSERT INTO public.courses SELECT * FROM public.courses_bak_20261013;

-- 5. ⚠️ 必须验证：行数和学分总额都要对得上
SELECT count(1) AS n, sum(credits) AS s FROM public.courses;
```

`categories` 同理（**注意先恢复 categories**，因为 courses 有外键指向它）。

### 情况 B：只是某几条数据被改错了

```sql
-- 先在快照里找到正确的值
SELECT id, name, credits, status, score
FROM public.courses_bak_20261013
WHERE name LIKE '%天体物理%';

-- 再用 UPDATE 改回来（不用整表恢复，风险小得多）
UPDATE public.courses
SET credits = 3, status = 'done', score = 85
WHERE id = 'xxx';
```

> **优先用情况 B**：整表恢复会把恢复之后的所有新数据也一起冲掉。

---

## 四、自动备份（官方文档确认：CloudBase PostgreSQL 自带）

> **这一节改过了。** 原来写的是「还没做」——
> 查了官方文档才发现：**CloudBase PostgreSQL 的备份能力由底层腾讯云 PostgreSQL 提供，
> 默认就有自动备份**。之前我不知道有这回事，
> 所以「数据库没备份」这个判断**下得太早了**。

### 4.1 官方怎么说（来源：docs.cloudbase.net/database/postgresql/backup）

> CloudBase PostgreSQL 的备份与恢复能力由**底层腾讯云 PostgreSQL 服务**提供支持。
>
> - **自动备份**：按实例策略周期性生成，适合常规数据保护
> - **手动备份**：在发布、迁移、批量更新前主动创建
> - **时间点恢复**：根据备份和日志恢复到指定时间点

### 4.2 你需要在控制台确认的（我没法替你点）

CloudBase 控制台 → PostgreSQL 数据库实例 → **备份恢复**页

| 查什么 | 怎么看 |
|---|---|
| 自动备份开没开 | 备份列表里有没有按天的备份记录 |
| 保留多久 | 默认 **7 天**，可改到1830 天 |
| 有没有手动备份 | 同页「手动备份」按钮 —— **建议现在点一次** |
| 能不能下载 | 每条备份有「下载」，地址有效期 12 小时 |

⚠️ **底层是物理备份**，不是逻辑备份。
所以「备份文件」和我们手工建的 `courses_bak_*` 表不是一回事，
恢复走控制台的备份恢复流程，不是 `INSERT`。

### 4.3 和手工快照的关系（两个都要有）

| | 平台自动备份 | 手工快照表（`courses_bak_*`）|
|---|---|---|
| 谁做的 | 腾讯云底层 | 我们自己 |
| 形式 | 物理备份文件 | 数据库里的普通表 |
| 恢复方式 | 控制台「备份恢复」 | `INSERT INTO ... SELECT` |
| 优点 | 省心、全量、含结构 | **能直接查、能手工捞** |
| 缺点 | 恢复要进控制台 | 得自己记得建 |
| **建议** | **开着，每天自动** | **大改动前手动建一张** |

平台备份兜底，手工快照给你「随时能查」的底气。

### 4.4 逻辑导出（可选，第三层，暂不做）

官方文档提到可以用 `pg_dump` 做逻辑备份，适合长期留存或跨环境迁移：

```
pg_dump "$DATABASE_URL" --format=custom --no-owner --file=cloudbase-postgres.dump
```

⚠️ **这一步本地做不了** —— 需要 `DATABASE_URL`（云端连接串），我这边拿不到。
真要做得在 CloudBase 云函数里跑，或在装了 psql 的机器上连云端。

**138 门课的数据量小到可以忽略**，这层暂时不做。
**别为了「三份备份」过度设计** —— 两层够用。

### 4.5 ⚠️ 官方反复强调的一句话：恢复演练

> **备份只有在可恢复时才真正有效。**

所以判断「备份有没有用」，**不是看备份列表里有没有记录，
而是「能不能真的恢复出来」**。

我们已经有现成的演练材料—— `courses_bak_*` 快照表，
见第三节「情况 B：只是某几条数据被改错了」。

---

## 五、⚠️ 本次自检发现的两个文档脱节（已修）

Day 27 迁移数据库时，把两列都改成了 `numeric(4,2)` + `mod(·,0.25)=0`，
但有两处文档还写着旧值：

| 文件 | 原来写的 | 已改成 |
|---|---|---|
| `db/schema.sql` | `numeric(3,1)` + `mod(·, 0.5)=0` | `numeric(4,2)` + `mod(·, 0.25)=0` |
| `db/seed.sql` | 同上 | 同上（连带约束名 `_half` → `_quarter`）|
| `api-contract.md` | `numeric(3,2)`、上限 9.99 | `numeric(4,2)`、板块上限 99.99 |

### 为什么当时没直接改（这个判断是对的）

拿不到线上数据库的真实结构（我这边访问 CloudBase 被拦），
**凭迁移记录推断就改建表脚本，等于把「推断」写成「事实」** ——
Day 27 已经栽过一次（我猜 courses 那条 ALTER 成功了，实际整批全回滚）。

**正确做法**：先查再改。

### 实际怎么改的（2026-10-13）

在 CloudBase 控制台跑了这条，拿到实测结果：

```sql
SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
FROM information_schema.columns
WHERE table_name IN ('courses','categories')
  AND column_name IN ('credits','required_credits');
```

结果：

| table_name | column_name | data_type | precision | scale |
|---|---|---|---|---|
| courses | credits | numeric | **4** | **2** |
| categories | required_credits | numeric | **4** | **2** |

**两列都是 `numeric(4,2)`，与 Day 27 定稿一致** →
据此同时改了 `schema.sql`、`seed.sql`、`api-contract.md` 三个文件。

`schema.sql` 里还留了这段注释，方便下一个人核对：

```sql
-- ⚠️ Day 27（B-004）实测确认：两列都是 numeric(4,2)，不是 (3,1) 也不是 (3,2)。
--    线上跑过这条查询确认（2026-10-13）：
--      table_name  | column_name       | precision | scale
--      courses     | credits           |     4      |  2
--      categories  | required_credits  |     4      |  2
--    为什么不用 (3,2)：上限只有 9.99，装不下 categories 里已有的
--    「专业核心 42」「通识必修 38」。(4,2) 上限 99.99，两列通用。
```

> **这一节是「先查再改」的样板**：
> 同样是文档与实现脱节，Day 27 我选择推断、
> Day 28 我选择先要实测数据 —— 后者才是对的。
