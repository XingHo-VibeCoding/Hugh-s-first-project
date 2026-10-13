# db/BACKUP.md —— 数据备份与恢复

> **一句话现状**：代码和静态文件能靠 git tag 回退，**但数据库回不了**。
> 这份文档补上这一块。

---

## 一、现状（先说清楚，避免误以为已经有备份了）

| 东西 | 有备份吗 | 怎么回退 |
|---|---|---|
| 业务代码 | ✅ 有 | `git revert` 或从 tag 取回 |
| 静态文件（网站） | ✅ 有 | `git archive <tag>` 后覆盖上传 |
| **数据库 `courses` / `categories`** | ❌ **没有** | **只能靠快照表** |

**Day 27 留下的 `courses_backup_b004` / `categories_backup_b004`**：
那是做学分迁移那一刻的快照，**不是现在的状态**。别拿它当日常备份。

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

## 四、定时自动备份（还没做）

**诚实说明：这一节是「还没做」，不是「怎么做」。**

### 现状
- CloudBase 数据库**没有开启自动快照**
- 也没有定时导出任务
- **138 门课目前只有手工建的那 1 张快照**

### 下一步该做的（按优先级）

1. **先在控制台找有没有「自动备份」开关** ——
   有就直接开，成本最低
2. 没有的话，看 CloudBase 是否支持**定时触发器 + 导出函数**：
   定时器每天调一次云函数，把两张表导成 CSV 存到云存储
3. 退一步：**养成手工备份的习惯** ——
   每次做大改动（迁移、批量导入、清空）之前，先跑一遍第二节

### 建议频率
- **每天**自动一次（数据变动不频繁的话，一份快照能撑很久）
- 保留 **最近 7 份**，再往前的可以删

---

## 五、⚠️ 本次自检发现的两个文档脱节（还没改）

Day 27 迁移数据库时，把两列都改成了 `numeric(4,2)` + `mod(·,0.25)=0`，
但有两处文档还写着旧值：

| 文件 | 写的 | 实际应该是 |
|---|---|---|
| `db/schema.sql` | `numeric(3,1)` + `mod(·, 0.5)=0` | `numeric(4,2)` + `mod(·, 0.25)=0` |
| `api-contract.md` | `numeric(3,2)`、上限 9.99 | `numeric(4,2)`、板块上限 99.99 |

**为什么这次没直接改**：
拿不到线上数据库的真实结构（我这边访问 CloudBase 被拦），
**凭迁移记录推断就改建表脚本，是把「推断」写成「事实」** ——
Day 27 已经栽过一次（我猜 courses 那条 ALTER 成功了，实际整批全回滚）。

**正确做法**：
1. 你在 CloudBase 控制台跑一条 `SELECT`，把两列的真实类型贴给我：
   ```sql
   SELECT table_name, column_name, data_type, numeric_precision, numeric_scale
   FROM information_schema.columns
   WHERE table_name IN ('courses','categories')
     AND column_name IN ('credits','required_credits');
   ```
2. 拿到真实结果我再改这两个文件
3. **改 schema.sql 之前先确认它现在还有没有用** ——
   它开头写着「上线后禁止再执行」，如果已经废弃了，更该在文件里标注清楚，
   而不是留着过时的类型误导下一个人
