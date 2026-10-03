# api-contract.md —— 学分规划助手 · 接口契约

> 撰写日期：2026-10-01（Day 15）　｜　依据：`PRD.md` + `TECH_DESIGN.md` 第四节数据模型 + 第 2 周前端页面的真实动作
> 一句话：这份文档是**前端与后端之间唯一的仲裁物**。后端照它实现，前端照它调用，谁也不去猜谁的代码。
> **本文件中的所有接口，除已标注「已实现」外，今天一律只登记占位，一个都不实现。**

---

## 一、部署信息（Day 15 现场记录）

> 查不全或界面变更时以控制台为准。此区块同时用于**到期前续订提醒**——丢失公网访问能力的常见原因就是忘掉续期。

| 项目 | 值 | 备注 |
|---|---|---|
| 云平台 | 腾讯云开发 CloudBase | 新控制台 |
| **环境 ID** | `my-first-project-d2epfvu0373796b` | |
| **剩余额度** | 功能用量概览：消耗 0 点（额度基本未动） | 控制台「环境 → 用量概览」 |
| **套餐到期日期** | **2026-11-01 23:59:59** | 到期后公网不可用；**须在到期前手动续订（0 元）**，腾讯不会提前很久提醒 |
| 云函数公网域名 | `https://my-first-project-d2epfvu0373796b-1489184401.ap-shanghai.app.tcloudbase.com` | HTTP 网关默认域名，另有独立有效期，到期在「HTTP 访问服务」点续期 |
| 已实现接口 | `/api/health`、`GET /api/categories`、`GET /api/courses` | ✅ health 2026-10-01、两个读接口 2026-10-03 验证通过 |
| 静态托管公网地址 | `https://my-first-project-d2epfvu0373796b-1489184401.tcloudbaseapp.com` | 第 2 周页面（本机存储数据）已上线 |
| 云数据库 | CloudBase **PostgreSQL**（Day 16 开通） | 表 `categories` / `courses` 已建；脚本 `db/schema.sql`、`db/seed.sql` 已入库 |
| 云函数类型 | **普通云函数（事件函数）** | ⚠️ 选「HTTP 云函数」会导致网关 403，勿选 |
| 后端接口部署形态 | **一路由一函数 + `API_ROUTE` 环境变量自报身份** | 本环境 HTTP 网关不向事件函数转发请求路径（event.path 恒为 `/`），单函数靠路径分发不可行；函数名 = 路由名：`api`(health) / `categories` / `courses`；API Key 走函数配置「API Key 设置」开关注入 `CLOUDBASE_APIKEY`（后端专用） |
| CORS 跨域 | **未配置** | 今日不做，Day 16–20 处理 |

---

## 二、本项目用哪两张表（Day 16 已落库 ✅）

> 本节在 Day 16 落库后回写。**数据库列名用 snake_case，接口 JSON 字段保持 camelCase**——两套名字是刻意的，映射见「落库列名」列，写接口时照它转。
> 建表脚本：`db/schema.sql`；种子脚本：`db/seed.sql`（可重复执行；**仅开发阶段使用，第 20 天上线后禁止再执行**，否则会清空真实数据）。
> 本课程不登录、不建用户表：两表均无「身份 / 用户」字段，唯一约束只加在业务字段上。

**表 1：`categories`（学分板块）**

| JSON 字段（camelCase） | 落库列名（snake_case） | 数据库类型 | 约束 | 校验 |
|---|---|---|---|---|
| id | id | varchar(32) | PRIMARY KEY | 不可重复 |
| name | name | varchar(20) | NOT NULL UNIQUE；去空格后非空 | 非空、≤20 字、**板块名全局唯一** |
| requiredCredits | required_credits | numeric(3,1) | 可空；填了须 >0 且为 0.5 倍数 | 0.5 的整数倍；**允许为空** |
| note | note | varchar(100) | 可空 | ≤100 字 |
| —（不对外暴露） | created_at / updated_at | timestamptz | NOT NULL DEFAULT now() | 仅排序与排错用，接口不返回 |

**表 2：`courses`（课程）**

| JSON 字段（camelCase） | 落库列名（snake_case） | 数据库类型 | 约束 | 校验 |
|---|---|---|---|---|
| id | id | varchar(32) | PRIMARY KEY | 不可重复 |
| name | name | varchar(30) | NOT NULL；去空格后非空 | 非空、≤30 字 |
| credits | credits | numeric(3,1) | NOT NULL；>0 且为 0.5 倍数 | 0.5 的整数倍 |
| categoryId | category_id | varchar(32) | 可空；外键 → `categories(id)` **ON DELETE SET NULL**；**UNIQUE(category_id, name)** | 指向已存在板块；NULL = 未归类；**同板块内课程名不重复，跨板块允许同名** |
| status | status | varchar(10) | NOT NULL，CHECK `('done','planned')`，默认 `'planned'` | 二选一 |
| score | score | smallint | 可空；CHECK 0–100 | **<60 视为不及格、不计入已修学分**；为空不计入 GPA |
| —（不对外暴露） | deleted_at / delete_expires_at | timestamptz | 可空 | 软删除（契约第 9、10 条）：`deleted_at` 非 NULL 即已删除，列表接口不返回；`delete_expires_at` 即响应中的 `restoreBefore`（5 秒撤销窗口） |
| —（不对外暴露） | created_at / updated_at | timestamptz | NOT NULL DEFAULT now() | 仅排序与排错用，接口不返回 |

**两表关联**：`courses.category_id` → `categories.id`。删板块 `mode=move` 时，外键 `ON DELETE SET NULL` 自动把课置为"未归类"——数据库层面兜底，不依赖接口代码写对。

**索引**（Day 16 建表时一并创建）：`idx_courses_category_id`（按板块筛）、`idx_courses_status`（按状态筛）、`idx_courses_active`（部分索引，只覆盖未删除行——列表接口最常用的查询路径）。

---

## 三、通用约定

- **Base URL**：`https://my-first-project-d2epfvu0373796b-1489184401.ap-shanghai.app.tcloudbase.com`
- **请求与响应一律 JSON**；请求头 `Content-Type: application/json`。
- **成功响应统一信封**：`{ "ok": true, "data": <数据> }`
- **错误响应统一信封**：`{ "ok": false, "error": "<可直接展示给用户的中文说明>" }`
- 例外：`GET /api/health` 保留 Day 15 已上线的原始返回体，不套信封（它本来就是 `{"ok":true,...}` 形状，天然一致）。

> **Day 17 改版记录（原为 `{data,error}` 信封）**
> 原因：Day 17 起前端要按 `ok` 判断成败，`{"data":…,"error":null}` 这种"两个字段互相打架"的形状，前端每处都得写 `if (res.error)`，容易漏。
> 取舍：`error` 由 `{code,message}` 简化为**纯中文字符串**，错误码暂时不对外返回（服务端日志仍按下面四类归类，便于排查）。
> 若 Day 18 写入接口出现"前端必须按错误类型分支"的场景，**先改本节再改代码**，可恢复为携带 code 的形式。

**错误归类（服务端内部使用；对外只给中文 `error` 文本）**

| 归类 | 何时触发 | 对外 error 文案（示例） |
|---|---|---|
| `VALIDATION_ERROR` | 参数不合规则（空名、学分非 0.5 倍数、成绩越界等） | "课程名不能为空" |
| `NOT_FOUND` | 该 id 不存在（常见的：改/删了一门已被删掉的课） | "这条数据已经不存在了，刷新看看" |
| `REFERENCED_BY_COURSES` | 删板块时该板块下还有课程，且调用方没指定处理方式 | "该板块下还有 N 门课，请先选择处理方式" |
| `INTERNAL` | 服务器自身出错（含数据库连不上、SQL 失败） | "服务出了点问题，稍后再试" |

> 前端需要知道"该板块下有几门课"时，**不要靠解析 error 文本**——先调 `GET /api/courses?categoryId=xx` 自己算，再弹问。这样前后端都不会因为改一句文案而崩。

---

## 四、接口清单（12 个，9 个占位）

| # | 方法 | 路径 | 状态 |
|---|---|---|---|
| 1 | GET | `/api/health` | ✅ 已实现 |
| 2 | GET | `/api/categories` | ✅ 已实现（Day 17） |
| 3 | POST | `/api/categories` | ⬜ 占位 |
| 4 | PATCH | `/api/categories/:id` | ⬜ 占位 |
| 5 | DELETE | `/api/categories/:id` | ⬜ 占位 |
| 6 | GET | `/api/courses` | ✅ 已实现（Day 17） |
| 7 | POST | `/api/courses` | ⬜ 占位 |
| 8 | PATCH | `/api/courses/:id` | ⬜ 占位 |
| 9 | DELETE | `/api/courses/:id` | ⬜ 占位（软删除） |
| 10 | POST | `/api/courses/:id/restore` | ⬜ 占位（撤销删除） |
| 11 | GET | `/api/summary` | ⬜ 占位 |
| 12 | POST | `/api/seed` | ⬜ 占位（候选，可能本周不实现） |

---

### 1. GET /api/health —— 健康检查 ✅ 已实现

> 用途：确认"代码已部署且公网可达"。它不查数据库、不做业务，是后端的心跳灯。

- **请求参数**：无
- **成功响应 200**（例外格式，不套信封）：

```json
{
  "ok": true,
  "service": "credit-planner",
  "time": "2026-10-01T07:20:47.700Z"
}
```

- **错误**：无（只要地址正确就 200）
- **代码实现**：仓库 `cloudfunctions/api/index.js`
- **验证记录**：2026-10-01 浏览器与 curl 双确认返回上述 JSON

---

### 2. GET /api/categories —— 读板块列表 ✅ 已实现

对应页面动作：打开「① 学分板块」看到全部板块。

- **请求参数**：无
- **成功 200**：

```json
{ "ok": true, "data": [ { "id": "c1", "name": "专业选修", "requiredCredits": 12, "note": "须含 2 学分艺术类" } ] }
```

- **错误**：`INTERNAL`
- 无数据时返回 `"data": []`（不是 null），`ok` 仍是 `true`
- **代码实现**：仓库 `cloudfunctions/api/`（部署形态：独立函数 `categories`，环境变量 `API_ROUTE=categories` 自报身份——本环境 HTTP 网关不向事件函数转发路径，故一路由一函数）
- **验证记录**：2026-10-03 公网实测返回 6 个板块；字段 camelCase、requiredCredits 为数字、空值正确为 `null`；改库后返回随之变化（真库验证）

---

### 3. POST /api/categories —— 新增板块

对应页面动作：填「板块名 + 要求学分 + 备注」点添加。

- **请求体**：

```json
{ "name": "专业选修", "requiredCredits": 12, "note": "" }
```

| 字段 | 必填 | 规则 |
|---|---|---|
| name | ✅ | 非空、≤20 字 |
| requiredCredits | ❌ | 0.5 倍数或 null；不传按 null 处理 |
| note | ❌ | ≤100 字 |

- **成功 201**：

```json
{ "ok": true, "data": { "id": "c7", "name": "创新创业", "requiredCredits": 2, "note": "" } }
```

- **错误**：`VALIDATION_ERROR`（名称为空/超长、学分非 0.5 倍数）、`INTERNAL`
- 响应中的 id 由服务端生成（`c` + 随机串），不是前端传的

---

### 4. PATCH /api/categories/:id —— 修改板块

对应页面动作：板块卡片上的改名 / 改要求学分 / 改备注。

- **请求参数**：路径参数 `id` 必填
- **请求体**：同 POST，**只传要改的字段**（name / requiredCredits / note，可任意组合）
- **成功 200**：`"data"` 为修改后的完整对象

```json
{ "ok": true, "data": { "id": "c1", "name": "专业选修", "requiredCredits": 14, "note": "须含 2 学分艺术类" } }
```

- **错误**：`NOT_FOUND`、`VALIDATION_ERROR`、`INTERNAL`

---

### 5. DELETE /api/categories/:id —— 删除板块

对应页面动作：删板块，且页面会问"下面的课怎么办"。

- **请求参数**：路径参数 `id` 必填；查询参数 `mode` 可选
  - `mode=cascade`：连同该板块下的课程一起删除
  - `mode=move`：该板块下的课程移到"未归类"（`categoryId` 置空）
  - **不传 `mode` 且该板块下还有课程** → 返回 `REFERENCED_BY_COURSES`，由前端弹问后重发
- **成功 200**：`affectedCourses` 为被一并删除或移走的课程数

```json
{ "ok": true, "data": { "id": "c1", "affectedCourses": 3 } }
```
- **错误**：`NOT_FOUND`、`REFERENCED_BY_COURSES`、`INTERNAL`

---

### 6. GET /api/courses —— 读课程列表（含三种筛选）✅ 已实现

对应页面动作：课程列表，以及**关键词搜索 / 按板块筛 / 按状态筛**——三个动作共用这一个接口，只是多带参数。

- **请求参数**（全部为查询参数，可选、可组合）：

| 参数 | 说明 | 取值 |
|---|---|---|
| keyword | 按课程名模糊搜索 | 字符串 |
| categoryId | 只看某个板块 | 板块 id；传 `none` 表示"未归类" |
| status | 只看某种状态 | `done` / `planned` |
| limit | 最多返回多少条（**Day 17 余力加练**） | 正整数，默认不限制；非法值按未传处理 |

- **成功 200**：

```json
{ "ok": true, "data": [ { "id": "k1", "name": "高等数学", "credits": 4, "categoryId": "c1", "status": "done", "score": 87 } ] }
```

- **错误**：`VALIDATION_ERROR`（status 取值非法）、`INTERNAL`
- 无匹配返回 `"data": []`（前端自行显示"都被筛掉了"空态），`ok` 仍是 `true`
- **排序**：`created_at` 升序（先录入的在前），与第 2 周前端列表顺序一致
- **代码实现**：仓库 `cloudfunctions/api/`（部署形态：独立函数 `courses`，环境变量 `API_ROUTE=courses`，同上）
- **验证记录**：2026-10-03 公网实测返回 9 门课（credits 为数字、score 空值正确）；控制台改一行 score 72→95 后刷新接口随之变化（真库验证）；`?status=abc` 返回 400 中文错误（错误形状实测）；`limit` 参数已实现（余力加练）

---

### 7. POST /api/courses —— 新增课程

对应页面动作：填「课程名 / 学分 / 板块 / 状态 / 成绩」点添加。

- **请求体**：

```json
{ "name": "高等数学", "credits": 4, "categoryId": "c1", "status": "done", "score": 87 }
```

| 字段 | 必填 | 规则 |
|---|---|---|
| name | ✅ | 非空、≤30 字 |
| credits | ✅ | 0.5 倍数、>0 |
| categoryId | ✅ | 必须指向已存在的板块（id 不存在 → NOT_FOUND） |
| status | ✅ | `done` / `planned` |
| score | ❌ | 0–100 整数；`planned` 时不填 |

- **成功 201**：

```json
{ "ok": true, "data": { "id": "k10", "name": "天文学导论", "credits": 3, "categoryId": "c1", "status": "planned", "score": null } }
```

- **错误**：`VALIDATION_ERROR`、`NOT_FOUND`（板块不存在）、`INTERNAL`
- 响应中的 id 由服务端生成（`k` + 随机串）

---

### 8. PATCH /api/courses/:id —— 修改课程

对应页面动作：课程卡片上的「修改」。

- **请求参数**：路径参数 `id` 必填
- **请求体**：任意待改字段（name / credits / categoryId / status / score，校验同第 7 条的表）
- **成功 200**：`"data"` 为修改后的完整课程

```json
{ "ok": true, "data": { "id": "k1", "name": "高等数学", "credits": 4, "categoryId": "c1", "status": "done", "score": 92 } }
```
- **错误**：`NOT_FOUND`、`VALIDATION_ERROR`、`INTERNAL`

---

### 9. DELETE /api/courses/:id —— 删除课程（软删除）

对应页面动作：点删除。**为支持"5 秒撤销"，后端采用软删除**：记录仍留在表里，只是标记为已删，不在列表接口返回。

- **请求参数**：路径参数 `id` 必填；**请求体**：无
- **成功 200**：

```json
{ "ok": true, "data": { "id": "k1", "deleted": true, "restoreBefore": "2026-10-01T07:30:00.000Z" } }
```

  - `restoreBefore` = 可撤销的截止时间（本项目定 5 秒）
- **错误**：`NOT_FOUND`、`INTERNAL`
- 超过 5 秒后若前端仍发 Restore → `NOT_FOUND`

---

### 10. POST /api/courses/:id/restore —— 撤销删除

对应页面动作：删除后底部那条 5 秒进度条上的「撤销」。

- **请求参数**：路径参数 `id` 必填；**请求体**：无
- **成功 200**：

```json
{ "ok": true, "data": { "id": "k1", "deleted": false } }
```
- **错误**：`NOT_FOUND`（超过时限或本来就没删）、`INTERNAL`

---

### 11. GET /api/summary —— 板块缺口与选课建议

对应页面动作：概览页每个板块的「已修 / 要求 / 还差 N 学分」徽标，以及展开后的「建议优先选哪几门」。**这笔账优先放在云上算**，避免前端与后端两套算法不一致。

- **请求参数**：无
- **成功 200**：

```json
{
  "ok": true,
  "data": {
    "categories": [
      {
        "categoryId": "c1",
        "name": "专业选修",
        "doneCredits": 6,
        "requiredCredits": 12,
        "gap": 6,
        "note": "须含 2 学分艺术类",
        "label": "还差 6 学分",
        "state": "shortage",
        "recommendation": {
          "picked": [{ "courseId": "k9", "name": "天体测量学", "credits": 3 }],
          "count": 2,
          "sum": 6,
          "enough": true,
          "remaining": 0
        }
      }
    ],
    "total": { "totalCredits": 148, "avgScore": 84.2, "gpa": 3.34 }
  }
}
```

| 字段 | 说明 |
|---|---|
| gap | 缺口学分 = requiredCredits − doneCredits；requiredCredits 为空时返回 `null` |
| state | `enough`（已修够）/ `shortage`（还差）/ `unknown`（未填要求学分） |
| recommendation | 仅在 shortage 时给；`picked` 按计划修课程学分从大到小凑；`enough=false` 表示凑不满，`remaining` 为仍差多少 |
| label | 前端直接显示的徽标文字（去重多余的判断逻辑） |

- **错误**：`INTERNAL`
- ⚠️ **计分口径必须与现在的前端一致**：成绩 <60 不计入已修学分；加权平均与 GPA 的计算规则沿用 `PRD.md` 边界定义。

---

### 12. POST /api/seed —— 灌入示例数据（候选）

对应页面动作：开发者工具的「载入示例数据 1 / 2（92 门）」。

- **请求体**：

```json
{ "set": "astronomy" }
```

| 字段 | 必填 | 取值 |
|---|---|---|
| set | ✅ | `demo1`（小样例）/ `astronomy`（92 门天文学样例） |

- **成功 200**：返回实际写入的板块数与课程数

```json
{ "ok": true, "data": { "categories": 6, "courses": 92 } }
```
- **错误**：`VALIDATION_ERROR`、`INTERNAL`
- **状态**：候选占位。**本周是否实现待定**；若不实现则前端继续用本机数据演示。

---

## 五、今天明确不做的（及其理由）

| 项 | 理由 |
|---|---|
| 上述所有接口的实现 | Day 15 的任务只是"登记占位 + 证明部署链路通"，实现属 Day 16–20 |
| 数据库建表 | 尚未到；且表结构已由本文档第二节确定，届时照此建 |
| CORS 跨域配置 | 前端尚未真正调用后端接口，配了也验证不了；Day 16–20 一并处理 |
| 登录 / 鉴权 | 一期定位是免登录的轻体验（`research.md` 结论），不做也符合 smoketesting |
| 本机数据迁移到云端 | 解决"换设备看不到数据"的痛点，但今天范围外 —— **登记为后续待办（第 4 周）** |

---

## 六、改动本文件的规则

1. **任何接口的路径、字段、响应形状变更，必须先改本文件再改代码**——契约是唯一的仲裁依据，代码不得反过来倒逼契约。
2. 新增接口必须补进第四节清单表格，并标注实现状态。
3. 错误码只能在第三节错误码表中扩展，不得在单个接口里自造；自造即视为违反契约。
