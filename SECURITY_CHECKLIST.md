# SECURITY_CHECKLIST.md — 安全自查清单（Day 23）

> 规则：每项必须写明「怎么算通过」和「实测结果」。
> 只写"已修复"不算，必须能让同伴照着独立复现同样结论。
> 最近一次执行：**2026-10-09**（契约：Day 23 任务「先审计后修复」）

---

## 使用说明

1. 逐项执行下面的命令
2. 核对实际输出与「实测结果」是否一致
3. **不一致就停下**，按该项下方备注处理
4. 全过 = 上线红线通过

**命令都在项目根目录执行**（脚本也在根目录：`scripts/verify-errors.js`）。

### 本项目公网地址（清单里所有 curl 都用这个）

```bash
BASE=https://my-first-project-d2epfvu0373796b.service.tcloudbase.com
SITE=https://my-first-project-d2epfvu0373796b-1499184401.tcloudbaseapp.com
# 检查台页面（给人看的）：$SITE/cloud.html
```

> ⚠️ **两个域名的数字不一样**（`service` 那个是 `…d2epfvu0373796b.service.…`，
> 静态托管是 `…-1499184401.tcloudbaseapp.com`）。打错会得到 **418**，
> 那不代表服务坏了，是域名不存在。

### 可执行文件路径

```bash
NODE="C:/Users/w3224/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
PY="C:/Users/w3224/.workbuddy/binaries/python/versions/3.13.12/python.exe"
```

---

## 📌 Day 23 自查时，同伴独立执行发现的问题（已全部修）

> 这一节记录「清单自己被验证」的经过 —— **清单写完不代表写对了**。

| # | 同伴发现 | 性质 | 怎么修的 |
|---|---|---|---|
| 1 | 第② 项的搜索命令匹配到了自己（清单里写着 `postgres://`） | 清单缺陷 | 命令加 `grep -v "grep -"`，并把这条坑写进正文 |
| 2 | 第 ⑤ 项的本地脚本超时用例 FAIL：期望「响应超时」，实际报「连不上」 | **真 bug** | `req.destroy(e3)` 会触发 error 事件把 kind 覆盖成 `DB_UNREACHABLE`；改成用 `isDbTimeout` 标记认出超时那个 |
| 3 | 顶层兜底 `catch` 把未预期异常的英文原文直接返回给用户 | **真 bug** | 改成一律只说「服务出了点问题，稍后再试」，原文只进日志 |
| 4 | `console.log` 打了 `result.name`（用户输入的课程名） | **真 bug** | 改成只记 id、学分、板块 |
| 5 | 第 ① 项备注说"会有 2 处命中"，但实测那 2 处根本不被正则抓到 | 清单自相矛盾 | 删掉该备注 |
| 6 | 第 ④ 项写「68 行」，实际 100 行 | 清单数字错 | 改为 100 行 |
| 7 | 第 ⑧ 项写「第 20 次起429 / 201×19→429×7」，两者加起来 26 次 ≠ 25 | 清单数字错 | 按实测改成「前 20 次放行、第 21 次起 429」 |
| 8 | 第 ⑤⑥⑦⑧ 项里URL 是省略号 `…/api/courses`，照做跑不了 | 清单不可执行 | 顶部加BASE / SITE 两个变量 |
| 9 | 第 ⑥ 项只给敏感词清单，没给「搜什么、怎么抓响应」 | 清单不可执行 | 补上完整抓取步骤 |

**结论**：④⑤⑥⑦⑧⑩ 六项在自查时都站不住，其中 3 项是真 bug。
**清单不是写完就完事的，得让一个不看上下文的人真跑一遍。**

---

## 🔴 第一组：密钥（上线红线，优先级最高）

### ① 代码里没有硬编码密钥

**怎么算通过**：搜"密钥特征词被赋成字面量"，结果 **0 命中**。

```bash
git ls-files | while read f; do
  [ -f "$f" ] || continue
  grep -nEi "(password|passwd|secret|api[_-]?key|apikey|token|connection_?string)\s*[:=]\s*['\"][^'\"]{6,}['\"]" "$f"
done
```

**实测结果**：✅ **0 命中**（27 个被跟踪文件全查过）

> **判别标准**：真泄露 = `xxx = '真实值'`（有引号字面量）；
> 安全用法 = `xxx = process.env.XXX`（从环境变量读，代码里没有值）。
>
> 这条正则抓的是前者，所以 `dbClient.js` 里的
> `process.env.CLOUDBASE_API_KEY` **不会被它命中** —— 那正是我们要的样子。

---

### ② Git 提交历史里也没有密钥

**怎么算通过**：搜全部历史，**0 条真实命中**。

```bash
# 两级判定：先粗筛，再逐条看内容（原因见下）
git log --all -p | grep -E "^\+" \
  | grep -iE "postgres://|postgresql://|mysql://|-----BEGIN|sk-[a-zA-Z0-9]{16,}|ghp_[a-zA-Z0-9]{20,}" \
  | grep -v "grep -"
```

**实测结果**：✅ **0 条真实命中**（39 个提交全查过）

> ⚠️ **为什么不加那个 `grep -v "grep -"` 就会误报**：
> 搜索命令本身被写进了这份清单，于是 `git log -p` 抓到它，
> 而它里面就含 `postgres://` —— **搜索命令匹配到了自己**。
> 这不是泄露，是**自我匹配**。
>
> Day 23 首次跑时命中 1 条，逐字打出来才发现是第 48 行的命令自己。
>
> **这个坑值得记住**：**任何"搜敏感词"的检查，都要能区分"真内容"和"搜索语句本身"。**
> 否则同伴照着清单跑，看到一条命中就以为项目泄密了 —— 清单反而制造恐慌。

**为什么必须查历史**：改代码不等于历史干净。密钥一旦提交过，`git log` 随时能翻出来。
**万一真的进了历史**：立刻到平台控制台**作废并重新生成** → 更新 .env → 仅删代码是不够的。

---

### ③ `.env` 不在仓库且被忽略

**怎么算通过**：两个命令都符合预期。

```bash
git check-ignore .env     # 输出 .env  → 已被忽略
git ls-files | grep '\.env$'   # 输出为空 → 仓库里没有 .env
```

**实测结果**：
- `git check-ignore .env` → 输出 `.env` ✅
- `git ls-files | grep '\.env$'` → **空** ✅（仓库里只有 `.env.example`）

> `git check-ignore` **无输出 = 没被忽略**，需要修 `.gitignore`。这是个容易看错的地方。

---

### ④ 仓库里有 `.env.example`（只有字段名，无真实值）

**怎么算通过**：存在 + 所有赋值行为空。

```bash
test -f .env.example && echo "存在"
grep -nE "^[A-Z_]+=.+" .env.example | grep -v "=$"   # 应无输出
```

**实测结果**：✅ 存在（100 行），7 个字段全部为空值

| 字段 | 代码在哪读 | 必填 |
|---|---|---|
| `CLOUDBASE_API_KEY` | `repositories/dbClient.js` | ✅ 必填（最敏感） |
| `CLOUDBASE_ENV` | `repositories/dbClient.js` | 选填 |
| `API_ROUTE` | `index.js` | ✅ 必填（三函数配不同值） |
| `CORS_ALLOWED_ORIGIN` | `index.js` | 选填（**别填 `*`**） |
| `DEBUG_EVENT` | `index.js` | 选填（排查完关掉） |
| `RATE_LIMIT_PER_MIN` | `services/rateLimiter.js` | 选填（别改） |
| `CLOUDBASE_RDB_BASE` | `repositories/dbClient.js` | 仅本地测试 |

> ⚠️ 这 7 个字段**全部来自代码里 `process.env.XXX` 的真实读取处**，不是凭空列的。
> 加新环境变量时要同步更新这份清单。

---

## 🟡 第二组：错误提示（用户能不能看懂）

### ⑤ 三类错误都返回中文，且不含内部术语

**怎么算通过**：**手动触发三类**，看返回是不是人话。

| 类别 | 怎么触发 | 期望 |
|---|---|---|
| 用户输入错 | 直接打公网：`curl -X POST …/api/courses -d '{"name":"","credits":2.3,"categoryId":"c1","status":"done"}'` | 400 + 点出具体问题 |
| 网络/接口错 | **本地注入故障**（推荐，见下）或临时改错表名后部署 | 503 + 「数据库暂时…」类中文 |
| 服务端错 | 本地让假网关返回 500 | 503 + 「数据库服务暂时异常」 |

#### 网络/接口错怎么验（Day 23 实操修正）

⚠️ **不要去控制台找「API Key 设置」开关——本环境控制台里没有这个开关。**

`环境管理 → API Key 配置` 那一页只有**客户端 Publishable Key** 和**服务端 API Key**
的创建与删除，没有「把这个 Key 注入到某个云函数」的选项。Day 23 专门找过，确认不存在。

**改用本地注入故障**，更安全也覆盖得更全：用一个假网关代替真实数据库，
让它按需返回 401 / 500 / 404，然后调`index.js` 看对外文案。
不碰线上、不花钱、想验几次验几次。

原理（可执行脚本已收进仓库：`scripts/verify-errors.js`）：

```js
// 假网关：任何请求都回 401 + 网关内部错误码
res.writeHead(401); res.end('{"code":"MISSING_CREDENTIALS","message":"Credentials missing"}');
// 然后调入口
index.main({ httpMethod:"GET", path:"/api/courses", queryStringParameters:{} })
// 实际拿到：
//   HTTP 503  {"ok":false,"error":"数据库暂时连不上，请稍后再试"}
```

**Day 23 本地实测结果**（六种后端故障，含自查时补的两种）：

| 注入的故障 | 网关原始返回 | 接口对外返回 |
|---|---|---|
| 环境变量里没有 Key | —（请求根本没发出去） | `503 数据库暂时连不上，请稍后再试` |
| Key 无效 / 权限不足 | `401 {"code":"MISSING_CREDENTIALS"}` | `503 数据库暂时连不上，请稍后再试` |
| 连接被掐断 | `socket hang up` | `503 数据库暂时连不上，请稍后再试` |
| 数据库超时（8 秒） | —（网关不响应） | `503 数据库响应超时，请稍后再试` ← **自查才修对** |
| 数据库内部报错 | `500 {"code":"INTERNAL_ERROR","message":"db exploded"}` | `503 数据库服务暂时异常，请稍后再试` |
| 表名写错 | `404 {"code":"PGRST205","message":"Could not find the table"}` | `503 数据库访问异常，请稍后再试` |

六种情况里 `MISSING_CREDENTIALS` / `INTERNAL_ERROR` / `db exploded` / `PGRST205` /
`socket hang up` **一个都没漏到前端** ✅ 这就是第 ⑥ 项要的证据。

```bash
# 「服务端错」怎么造（不用改任何代码）：让业务层抛一个真异常
# scripts/verify-errors.js 做的两件事：
#   ① 把 courseService.listCourses 换成会抛 TypeError 的版本 → 业务层的错误处理
#   ② 顶层catch 兜底（未预期异常也走这里）
"$NODE" scripts/verify-errors.js
# 实际输出（修复后）：
#   ✓ 业务层抛未预期异常  HTTP 500  文案=读取课程列表失败，稍后再试
```

> ⚠️ 修复前第一条是 `{"error":"boom: unexpected internal failure"}` ——
> **顶层 catch 把英文原文直接返回了**。这是自查抓到的第二个真 bug。

**实测结果**：见下方"实测三类错误对照表"。

---

### ⑥ 错误响应里搜不到内部术语

**怎么算通过**：真正抓一批错误响应出来，再拿 13 个敏感词去搜，**0 命中**。

**第1 步：抓响应**（公网能抓到的三类）

```bash
BASE=https://my-first-project-d2epfvu0373796b.service.tcloudbase.com
: > /tmp/errs.txt
# 用户输入错
curl -s -X POST $BASE/api/courses -H "Content-Type: application/json" -d '{"name":"","credits":2.3,"categoryId":"c1","status":"done"}' >> /tmp/errs.txt
# id 不存在
curl -s -X PATCH $BASE/api/courses -H "Content-Type: application/json" -d '{"id":"99999","score":60}' >> /tmp/errs.txt
# 非法 JSON
curl -s -X POST $BASE/api/courses -H "Content-Type: application/json" -d '{坏json' >> /tmp/errs.txt
# 方法不允许
curl -s -X PUT  $BASE/api/courses -H "Content-Type: application/json" -d '{}' >> /tmp/errs.txt
```

**第 2 步：网络/接口错 + 服务端错**用仓库里现成的脚本（已提交，同伴可直接跑）

```bash
# 在仓库根目录执行
"$NODE" scripts/verify-errors.js
```

它用一个假网关代替真实数据库，按需制造 5 种故障，然后逐条检查文案与泄露。
**期望输出**（Day 23 实测）：

```
  ✓ 缺 API Key             HTTP 503 文案=数据库暂时连不上，请稍后再试
  ✓ Key 无效/权限不足       HTTP 503 文案=数据库暂时连不上，请稍后再试
  ✓ 数据库内部报错          HTTP 503 文案=数据库服务暂时异常，请稍后再试
  ✓ 表名写错HTTP 503 文案=数据库访问异常，请稍后再试
  ✓ 业务层抛未预期异常      HTTP 500 文案=读取课程列表失败，稍后再试
  → 命中 0 处 ✅    文案不符： 0 处 ✅
  结论：通过 —— 全部是中文人话，且零泄露
```

退出码 `0` = 通过，非 `0` = 有泄露或文案与契约不符（可直接用于自动化）。

**第 3 步：搜敏感词**

```bash
LEAKS='socket hang up ECONNRESET INTERNAL_ERROR PGRST db exploded at Object .js: node_modules Traceback apikey Bearer MISSING_CREDENTIALS PGRST205'
cat /tmp/errs.txt | while read -r line; do
  for k in $LEAKS; do case "$line" in *"$k"*) echo "泄露: $k → $line";; esac; done
done
# 期望：一行都不输出
```

敏感词清单（上面 `$LEAKS` 里的）：
```
socket hang up  ECONNRESET  INTERNAL_ERROR  PGRST  db exploded
at Object  .js:  node_modules  Traceback  apikey  Bearer
MISSING_CREDENTIALS  PGRST205
```

**实测结果**：✅ **0 命中**（公网 7 条 + 本地注入 7 条，共 14 条响应全查）

> ⚠️ **同样的自我匹配陷阱**：这条搜索语句本身就含 `apikey`、`PGRST205`，
> 所以**必须去搜抓下来的响应文件**，不能直接搜代码 —— 否则搜到的全是搜索语句自己。
> 第 ② 项的坑在这里同样成立。

---

## 🟢 第三组：边界与配置正确性

### ⑦ 跨域白名单不允许通配符

**怎么算通过**：代码里没有 `Allow-Origin: *`，且陌生来源拿不到头。

```bash
grep -n "Access-Control-Allow-Origin" cloudfunctions/api/index.js   # 看逻辑不是看字面量
curl -i "…/api/courses" -H "Origin: https://evil.example.com" | grep -i access-control-allow-origin
```

**实测结果**：✅ 代码只回显白名单里的来源；`evil.example.com` **匹配 0 次**

```bash
BASE=https://my-first-project-d2epfvu0373796b.service.tcloudbase.com
# 陌生来源 → 应匹配 0 次（grep 无输出、退出码 1）
curl -i "$BASE/api/courses?limit=1" -H "Origin: https://evil.example.com" | grep -i access-control-allow-origin
# 白名单来源 → 应回显你的静态托管域名
curl -i "$BASE/api/courses?limit=1" \
  -H "Origin: https://my-first-project-d2epfvu0373796b-1499184401.tcloudbaseapp.com" \
  | grep -i access-control-allow-origin
```

---

### ⑧ 限流阈值合理，不被测试环境意外关掉

**怎么算通过**：① 线上没设 `RATE_LIMIT_PER_MIN`（用默认 20）；② 连发 25 次写请求，**前 20 次放行、第 21 次起返回 429**。

```bash
# ① 确认用的是默认值（代码里DEFAULT_PER_MIN = 20，且第 62 行env 为空时回落到它）
grep -n "DEFAULT_PER_MIN" cloudfunctions/api/services/rateLimiter.js
# 线上有没有设：控制台 → 云函数 → 函数配置 → 环境变量，看不到 RATE_LIMIT_PER_MIN 即为没设

# ② 连发 25 次写请求，统计状态码
BASE=https://my-first-project-d2epfvu0373796b.service.tcloudbase.com
for i in $(seq 1 25); do
  curl -s -o /dev/null -m 20 -X POST $BASE/api/courses \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"限流自检$i\",\"credits\":1,\"categoryId\":\"c5\",\"status\":\"done\"}" \
    -w "%{http_code} "
done
```

**实测结果**：✅ 前 20 次放行、第 21 次起 `429`；本次跑出 `503×20 → 429×5`

> ⚠️ 上面这条命令会**真的往数据库插 5 条记录**（前20 次成功的那些），
> 跑完要清理：按名字搜 `keyword=限流自检` 拿到 id，逐个 DELETE。
> ⚠️ **清理也会占限流配额** —— 一次删 20 条会触发 429，每批删 8 条、中间等 61 秒。
> ⚠️ 排查时若临时设了 `RATE_LIMIT_PER_MIN`，**测完要删掉**，否则等于关掉这层保护。

---

### ⑨ 依赖零第三方（供应链风险为零）

**怎么算通过**：`package.json` 的 dependencies 为空。

```bash
cat cloudfunctions/api/package.json
```

**实测结果**：✅ `dependencies` 为 `{}` —— 所有代码只用 Node 内置模块

---

### ⑩ 敏感信息不写进日志正文

**怎么算通过**：日志里只出现 **id、字段名、数量、长度**这类元信息，不出现用户输入的**业务内容**（课程名、备注、成绩…）。

```bash
# 把所有日志语句列出来，逐条看有没有打印业务字段
grep -n "console\.\(log\|warn\|error\)" cloudfunctions/api/index.js | grep -v "^\s*//"
```

**实测结果**：✅ 自查后已全部合规，共 11 处日志：

| 位置 | 记什么 | 合规判断 |
|---|---|---|
| 入口层 1 处 | method / route / query键名 / **body长度** | ✅ 只记长度，不记内容 |
| 新增课程 | id、学分、板块 | ✅ 不记课程名 |
| 修改课程 | id、**改动字段名** | ✅ 记「改了哪个字段」，不记改成什么值 |
| 删除课程 | id、撤销窗口秒数 | ✅ |
| 限流触发 | method、客户端 IP | ✅ |
| 失败 / 分级 / 兜底 | 错误码、中文说明、异常原文+调用栈 | ✅ 那是排错必需的，且原文不出接口 |

> ⚠️ **自查时真在这里抓到一个**：原来新增课程那行打了 `result.name`（= 用户输入的课程名）。
> 课程名可能含姓名、学号之类的东西 —— **日志是「谁都能看」的地方，不该出现业务内容**。
> 已改成只记 id / 学分 / 板块。
>
> **注意「改动字段名」和「改成什么值」的区别**：
> 记`fields`（`["score"]`）安全，它说明改了哪个字段；
> 记 `fields.map(f=>body[f])` 就等于把新值打进日志了。
>
> 请求体可能含用户输入的业务数据；日志里只留长度就够排障了。

---

## 实测三类错误对照表（2026-10-09）

| 类别 | 触发方式 | 实际返回 | 状态码 |
|---|---|---|---|
| ① 用户输入错 | 课程名留空 | `课程名不能为空` | 400 |
| ① 用户输入错 | 学分传 2.3 | `学分必须是 0.5 的倍数，例如 2、2.5、3（现在收到的是「2.3」）` | 400 |
| ① 用户输入错 | status 传 abc | `状态参数只能是 done 或 planned` | 400 |
| ① 用户输入错 | 改不存在的 id | `课程不存在：99999`（点名是哪个） | 404 |
| ① 用户输入错 | 同板块重名 | `板块 c2 下已经有同名的课程了：线性代数` | 409 |
| ① 用户输入错 | 连发超 20 次 | `操作太快了，请稍后再试` | 429 |
| ② 网络/接口错 | 连接被掐断 | `数据库暂时连不上，请稍后再试` | 503 |
| ② 网络/接口错 | 数据库超时（8 秒） | `数据库响应超时，请稍后再试` | 503 |
| ② 网络/接口错 | 数据库 5xx | `数据库服务暂时异常，请稍后再试` | 503 |
| ② 网络/接口错 | 表名错（404） | `数据库访问异常，请稍后再试` | 503 |
| ③ 服务端错 | 未预期异常（顶层兜底） | `服务出了点问题，稍后再试` | 500 |
| ③ 服务端错 | 业务层抛异常 | `读取课程列表失败，稍后再试` | 500 |
| ② 网络错 | 缺 API Key（配置错） | `数据库暂时连不上，请稍后再试` | 503 |
| ② 网络错 | API Key 无效（401） | `数据库暂时连不上，请稍后再试` | 503 |

> **超时那行是 Day 23 自查才修对的**。原来 `req.destroy(e3)` 会触发 error 事件，
> 被网络错误处理器抢先包装成「连不上」，kind 被覆盖成 `DB_UNREACHABLE`。
> 修法：给超时那个错误打 `isDbTimeout` 标记，处理器认出它就原样reject。
> 改完实测：**等待 8 秒 → 503「数据库响应超时」**，不再误报。

### Day 23 改掉的四处「外露内部信息」

| # | 改前（用户会看到） | 改后 |
|---|---|---|
| 1 | `连接数据库失败：socket hang up` | `数据库暂时连不上，请稍后再试` |
| 2 | `数据库请求失败（HTTP 500 INTERNAL_ERROR）：db exploded` | `数据库服务暂时异常，请稍后再试` |
| 3 | `数据库拒绝访问（HTTP 401 MISSING_CREDENTIALS）：…` | `数据库暂时连不上，请稍后再试` |
| 4 | `数据库接口不存在（HTTP 404 PGRST205）：…` | `数据库访问路径不存在（表名或路径可能不对）` |
| 5 | `云函数缺少 API Key：请开启函数配置里的「API Key 设置」开关…` | `数据库暂时连不上，请稍后再试` |

> 全部四条都**不外露**：网关错误码（`MISSING_CREDENTIALS` / `PGRST205` / `INTERNAL_ERROR`）、
> 网关英文原文（`db exploded` / `socket hang up`）、部署操作指引。
> **完整上下文只进服务端日志**（`[DB_UNREACHABLE]` + 原文），排查线索没丢。

### ⚠️ 一个刻意的取舍：401 为什么不说「API Key 无效」

数据库 401 在**技术上**是配置问题，但对外**故意不说**：

1. 泄露了「系统用了 API Key」这个实现细节
2. 普通用户看到会以为是自己操作错了，**反复重试却永远不会好**

部署者要排查怎么办 → **看服务端日志**。所以三类文案末尾统一带一句
「若持续失败请联系部署者」，给普通用户和部署者都留了出路。

> 判断标准：**错误提示要回答「我该怎么办」，而不是「系统怎么了」。**
> 「请开启 API Key 设置开关」回答的是"系统怎么了"，而且用户改不了；
> 「稍后再试，若持续失败请联系部署者」回答的是"我该怎么办"，而且做得到。

---

## Day 23 修掉的两个真 bug（存档备查）

| # | 改前（用户会看到） | 改后 | 怎么发现的 |
|---|---|---|---|
| 1 | `连接数据库失败：socket hang up` | `数据库暂时连不上，请稍后再试` | 本地测试注入"连接被掐断"故障 |
| 2 | `数据库请求失败（HTTP 500 INTERNAL_ERROR）：db exploded` | `数据库服务暂时异常（HTTP 500），请稍后再试` | 本地测试让假网关返回 500 |

**两个都是"眼睛看不出来的漏洞"** —— 正常路径永远跑不到，只有注入故障才暴露。

---

## 同伴复现指引

给同伴的话：

> 请照着上面 10 项自己跑一遍命令，然后回答：
> 1. 哪几项的结果和"实测结果"那一栏一致？
> 2. 有没有哪一项你**看不懂该怎么验**？（那项我重写）
> 3. 有没有哪一项你跑了但**结论不一样**？（那是我的问题，不是你的）

**清单写得够清楚的标准 = 同伴只看清单就能得出同样结论。**
