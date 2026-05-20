# smanga-adonis 日志逻辑重设计计划

## 1. 背景与目标

当前后端已经有 `log` 表，但真实调用频率偏低，很多排障关键事件只进入 `console.log` / `console.error`，没有进入数据库。用户遇到扫描失败、P2P 拉取失败、登录/权限异常、后台任务失败时，管理员无法从后台日志里还原现场。

本计划的目标是把日志能力从“偶尔手写一条记录”升级为“后端统一事件日志系统”：

- 所有关键错误必须可追踪：HTTP 异常、认证失败、权限拒绝、后台任务失败、P2P/Tracker 远端错误、扫描/同步/压缩失败。
- 日志调用要足够轻：业务代码只需要 `log.info(...)` / `log.error(...)` / `log.task(...)` 这类统一入口。
- 日志写入不能拖垮业务：DB 日志写入失败时不能让接口或任务失败。
- 日志要适合排查：记录 requestId、userId、IP、User-Agent、模块、动作、队列、任务 ID、实体 ID、异常堆栈、远端 HTTP 状态、关键上下文。
- 日志要可控：脱敏、截断、保留天数、索引、分页筛选，避免表无限膨胀。

## 2. 现状诊断

### 2.1 已有能力

- `prisma/*/schema.prisma` 中已有 `log` 表。
- 字段已经具备结构化雏形：`logType`、`logLevel`、`module`、`queue`、`message`、`exception`、`version`、`environment`、`context`、`device`、`userId`。
- `config/app.ts` 已开启 `generateRequestId: true`，理论上可以关联单次请求。
- `login` 表已经记录登录成功/失败，包含 `userName`、`ip`、`userAgent`、`request`。
- `taskFailed` / `taskSuccess` 已记录部分旧任务结果。

### 2.2 主要问题

- `app/utils/log.ts` 是散装 helper，硬编码 `version = '4.1.3'` 和 `environment = 'production'`，与 `package.json` / `NODE_ENV` 不一致。
- `app/utils/log.ts` 只覆盖扫描、封面和少量下载错误，无法覆盖 HTTP、权限、队列、P2P、Cron 等核心链路。
- `app/utils/p2p_log.ts` 只 `console.error`，P2P/Tracker 错误不会进入 `log` 表。
- `app/exceptions/handler.ts` 的 `report()` 仍然直接 `super.report()`，未把未捕获异常写入 `log` 表。
- `app/controllers/logs_controller.ts` 的 validator 使用 `logContent` / `logTitle`，但当前 Prisma `log` model 没有这两个字段，日志新增/更新接口存在结构不一致风险。
- `app/controllers/logs_controller.ts` 只支持分页，不支持按级别、模块、时间、关键词、用户、队列、requestId 过滤。
- 代码中大量使用 `console.log/error/warn`。本次粗略统计：`console.*` 约 224 处，DB log helper 使用约 22 处，P2P/Tracker console helper 使用约 68 处。
- `config/app.ts` 的 `useAsyncLocalStorage` 为 `false`，业务深层服务无法自然读取当前 requestId/userId。
- `app/middleware/auth_middleware.ts` 尾部存在 `await next(); return next()`，可能导致下游中间件/控制器重复执行。这不是日志问题本身，但会影响后续请求日志准确性，建议作为前置健壮性修复。
- MySQL schema 中 `log.message` 是 `@db.VarChar(191)`，长错误消息可能写入失败；`exception` 才是 Text。
- 三套数据库 schema 的 `context/device` 类型不完全一致：SQLite 是 `String?`，MySQL/PostgreSQL 是 `Json?`，日志服务需要统一序列化策略。
- `prisma/sqlite/migrations/20260518090000_scan_run_report` 目录当前看起来为空，后续新增日志迁移前建议确认 Prisma migrate/deploy 是否会受影响。

## 3. 设计原则

### 3.1 单一入口

新增统一日志服务，例如：

- `app/services/log_service.ts`
- `app/services/log_context.ts`
- `app/services/log_sanitizer.ts`

业务代码不直接调用 `prisma.log.create()`，也不直接拼结构化异常，统一使用日志服务。

### 3.2 双通道输出

每条关键日志同时走两条通道：

- Adonis/Pino logger：保留控制台、Docker stdout、文件采集能力。
- Prisma `log` 表：保留管理员后台排查能力。

DB 通道必须是安全写入：

- 默认不阻塞业务主流程。
- 写入失败只输出到 `ctx.logger` / `console.error`，不能抛回业务。
- 对少量必须确认的审计日志，可以提供 `awaitPersist: true`。

### 3.3 结构化优先

不要把所有信息塞进 `message`。推荐：

- `message` 放人类可读摘要。
- `exception` 放错误名、message、stack、cause。
- `context` 放 pathId、mediaId、mangaId、chapterId、queueName、jobId、remoteStatus、remoteData、retryCount 等结构化字段。
- `device` 放 ip、userAgent、method、url、requestId。

### 3.4 默认脱敏

任何进入 `context/device/exception` 的对象都必须先脱敏和截断。

必须屏蔽字段：

- `password`
- `passWord`
- `token`
- `authorization`
- `cookie`
- `secret`
- `nodeToken`
- `APP_KEY`
- `DB_PASSWORD`

建议替换为 `[REDACTED]`，不要删除字段名，这样排查时能知道“这个字段存在但被隐藏”。

### 3.5 控制噪声

不是所有成功请求都需要落库。建议默认落库：

- 所有 `warn/error/fatal`
- 所有登录成功/失败
- 所有权限拒绝
- 所有后台任务开始/完成/失败
- 所有扫描/同步/压缩/P2P 关键阶段
- 慢请求，例如超过 1000ms
- 管理类写操作：`POST/PUT/DELETE`

普通 `GET` 成功请求默认只进 Pino，不进 DB，避免日志表暴涨。

### 3.6 覆盖范围与落库边界

日志体系的目标是“全量覆盖，分级落库”。

全量覆盖指的是所有控制器、所有请求、所有后台任务都应该被统一日志链路覆盖。即使某个控制器没有手写业务日志，也应该通过全局 middleware、exception handler、auth middleware、queue wrapper 自动获得基础追踪能力。

分级落库指的是不要把所有成功请求都写进数据库 `log` 表。数据库日志只保存有排障、审计、追踪价值的事件；普通访问日志交给 Adonis/Pino、stdout、Docker logs 或文件采集。

推荐策略：

| 场景 | Pino/stdout | 数据库 `log` | 说明 |
|---|---:|---:|---|
| 所有请求开始/结束 | 是 | 按规则 | 全局 middleware 覆盖所有控制器 |
| 普通 `GET` 成功 | 是 | 否 | 避免列表、图片、阅读接口刷爆日志表 |
| 高频文件/图片/阅读请求成功 | 是 | 否 | 只记录异常、慢请求、权限失败 |
| 慢请求 | 是 | 是 | 超过 `logging.http.slowMs`，默认 1000ms |
| 5xx 未捕获异常 | 是 | 是 | 全局 exception handler 必须落库 |
| 401/403 认证权限失败 | 是 | 是 | 安全审计与用户排障核心 |
| `POST/PUT/PATCH/DELETE` 成功 | 是 | 是 | 改变系统状态，建议作为审计日志 |
| 管理员操作成功 | 是 | 是 | 用户、配置、媒体库、路径、权限等变更 |
| 登录成功/失败 | 是 | 是 | 可继续保留 `login` 表，同时写入统一 `log` |
| 后台任务入队/开始/完成/失败 | 是 | 是 | 扫描、同步、压缩、P2P 排障核心 |
| 扫描/同步/压缩/P2P 关键阶段 | 是 | 是 | 记录业务关键节点，不记录每一行循环细节 |
| 业务内部 debug 细节 | 是 | 默认否 | 开发排查可打开采样或提高日志级别 |

因此，后续改造不是“逐个控制器全量手写日志”，而是分三层实现：

1. 全局层：request middleware + exception handler 覆盖全部控制器。
2. 安全层：auth/login/permission middleware 覆盖认证、权限、登录审计。
3. 业务层：只在关键状态变化、失败分支、任务生命周期处手写结构化日志。

## 4. 推荐日志模型

### 4.1 级别定义

保留现有 `logLevel Int`，新增常量统一解释：

```ts
export const LogLevel = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
} as const
```

不要再让业务代码手写数字。

### 4.2 类型定义

建议 `logType` 使用稳定枚举：

```ts
export const LogType = {
  system: 'system',
  http: 'http',
  auth: 'auth',
  security: 'security',
  task: 'task',
  queue: 'queue',
  scan: 'scan',
  media: 'media',
  sync: 'sync',
  compress: 'compress',
  p2p: 'p2p',
  tracker: 'tracker',
  cron: 'cron',
  database: 'database',
} as const
```

### 4.3 LogEvent 输入结构

日志服务建议接受统一结构：

```ts
type LogEvent = {
  level: keyof typeof LogLevel
  type: keyof typeof LogType
  module: string
  action: string
  message: string
  error?: unknown
  userId?: number | null
  queue?: string | null
  context?: Record<string, unknown>
  device?: Record<string, unknown>
  awaitPersist?: boolean
}
```

`module + action` 是后续排查的核心。例如：

- `module = 'scan'`, `action = 'path.run.failed'`
- `module = 'queue'`, `action = 'job.failed'`
- `module = 'p2p'`, `action = 'pull.chapter.failed'`
- `module = 'auth'`, `action = 'token.invalid'`
- `module = 'http'`, `action = 'request.slow'`

### 4.4 数据库存储建议

短期可以复用现有 `log` 表，优先补索引和字段长度。

建议第一轮迁移：

- MySQL: 将 `message` 从 `VarChar(191)` 改为 `Text`。
- 所有数据库: 为高频查询字段加索引。
- 可选新增字段：`requestId`、`action`、`statusCode`、`durationMs`、`ip`、`method`、`url`、`jobId`、`entityType`、`entityId`。

如果希望控制迁移风险，也可以先不新增字段，把这些放入 `context/device`，只加索引和修复 `message` 长度。

推荐索引：

```sql
CREATE INDEX idx_log_create_time ON log(createTime);
CREATE INDEX idx_log_level_create_time ON log(logLevel, createTime);
CREATE INDEX idx_log_type_create_time ON log(logType, createTime);
CREATE INDEX idx_log_module_create_time ON log(module, createTime);
CREATE INDEX idx_log_user_create_time ON log(userId, createTime);
CREATE INDEX idx_log_queue_create_time ON log(queue, createTime);
```

如果新增 `requestId`：

```sql
CREATE INDEX idx_log_request_id ON log(requestId);
```

## 5. 分阶段实施计划

### 阶段 0：前置健壮性修复

目标：先修掉会影响日志准确性的基础问题。

建议修改：

- `app/middleware/auth_middleware.ts`
  - 将尾部 `await next(); return next()` 改成单次 `return next()` 或 `await next(); return`。
  - 这一步可以避免请求被重复处理、日志重复写入、接口产生双副作用。
- `app/controllers/logs_controller.ts`
  - 暂时禁止普通创建/更新日志，或者修正 validator 与 Prisma model 对齐。
  - 后端日志最好由系统写入，不建议暴露“任意创建系统日志”的接口。
- `app/validators/log.ts`
  - 移除 `logContent/logTitle`，改为 `message/logType/logLevel/module/queue/context/device/userId`。

验收：

- 任意登录后接口只执行一次。
- `/log` 列表接口仍可访问。
- `POST /log` 如果保留，必须能成功写入当前 schema 字段；如果不保留，需要返回明确 405/403。

### 阶段 1：建立日志服务基础设施

新增文件：

- `app/services/log_service.ts`
- `app/services/log_sanitizer.ts`
- `app/services/log_serializer.ts`
- `app/type/log.ts`

核心能力：

- `log.debug(event)`
- `log.info(event)`
- `log.warn(event)`
- `log.error(event)`
- `log.fatal(event)`
- `log.fromError(error)`
- `log.fromHttpContext(ctx)`
- `log.safePersist(event)`

实现要点：

- 从 `package.json` 读取版本，或提供 `get_app_version()` helper，不再硬编码。
- 从 `env.get('NODE_ENV')` 读取环境，不再硬编码 production。
- 根据当前数据库类型序列化 `context/device`：
  - SQLite: `JSON.stringify`
  - MySQL/PostgreSQL: 直接 JSON object
- `exception` 存储 `{ name, message, stack, cause }` 的 JSON 字符串。
- `message` 超长时截断，完整错误放到 `exception/context`。
- 所有 DB 写入都包 `try/catch`。
- 默认镜像到 Adonis logger。

验收：

- 手动调用 `log.info({ type: 'system', module: 'test', action: 'manual', message: 'hello' })` 能写入 `log` 表。
- 故意传入包含 token/password 的 context，落库内容应被 `[REDACTED]` 替换。
- 模拟 DB 写失败，业务调用不抛异常。

### 阶段 2：兼容旧 helper，降低改造成本

改造现有文件：

- `app/utils/log.ts`
- `app/utils/p2p_log.ts`

做法：

- 保留导出函数名：`insert_manga_scan_log`、`media_cover_log`、`error_log`、`log_p2p_error`、`log_tracker_error`。
- 内部实现改为调用 `log_service`。
- 这样现有业务调用点不需要一次性全改。

建议映射：

- `insert_manga_scan_log` -> `type: 'scan'`, `module: 'scan'`, `action: 'manga.scan.completed'`
- `media_cover_log` -> `type: 'media'`, `module: 'poster'`, `action: 'media.cover.generated'`
- `error_log` -> `type: 'system'`, `level: 'error'`
- `log_p2p_error` -> `type: 'p2p'`, `level: 'error'`
- `log_tracker_error` -> `type: 'tracker'`, `level: 'error'`

验收：

- 不改任何业务调用点，现有扫描错误和 P2P 错误都能进入 `log` 表。
- P2P 错误 context 中包含 `remoteStatus`、`remoteMessage`、`remoteData`、`stack`。

### 阶段 3：接入 HTTP 全局异常与请求日志

改造文件：

- `app/exceptions/handler.ts`
- 新增 `app/middleware/request_log_middleware.ts`
- `start/kernel.ts`

异常日志：

- 在 `report(error, ctx)` 中写入 DB。
- `E_VALIDATION_ERROR` 建议记为 `warn`，但可以只记录参数摘要，不记录完整 body。
- 5xx 记为 `error`。
- 401/403 由 auth middleware 负责记录，不建议在 exception handler 重复记。

请求日志：

- 中间件包裹 `await next()`，记录开始时间和结束时间。
- 默认落库：
  - `response.statusCode >= 500`
  - `response.statusCode === 401 || response.statusCode === 403`
  - 请求耗时超过 `logging.http.slowMs`
  - `POST/PUT/PATCH/DELETE`
- `GET` 成功请求默认不落库，只走 Pino。

需要记录：

- `requestId`
- `method`
- `url`
- `ip`
- `userAgent`
- `userId`
- `statusCode`
- `durationMs`
- `params`
- `query`

验收：

- 控制器抛出未捕获异常后，`log` 表出现一条 `http/error` 日志。
- 慢请求超过阈值后，`log` 表出现一条 `http/warn` 日志。
- validation error 不泄露敏感 body。

### 阶段 4：接入认证、权限、登录审计

改造文件：

- `app/middleware/auth_middleware.ts`
- `app/controllers/login_controller.ts`
- `app/middleware/p2p_peer_auth_middleware.ts`
- `app/middleware/tracker_auth_middleware.ts`

建议记录：

- 缺少 token：`auth.token.missing`
- token 无效：`auth.token.invalid`
- 用户不存在或 token 对应用户不存在：`auth.user.not_found`
- 权限不足：`auth.permission.denied`
- 登录成功：`auth.login.success`
- 登录失败：`auth.login.failed`
- OPDS Basic Auth 失败：`auth.opds.failed`
- P2P peer token 校验失败：`p2p.auth.failed`
- Tracker 鉴权失败：`tracker.auth.failed`

注意：

- 登录失败可以记录 `userName`，但不能记录密码。
- token 只记录 hash 前 6 位或完全 `[REDACTED]`。
- 高频无 token 请求可做采样或限流，防止恶意扫描刷爆日志表。

验收：

- 登录成功/失败都能在 `/log` 看到对应审计事件。
- 权限不足时能看到 userId、method、url、ip。
- 日志中没有明文 token/password。

### 阶段 5：接入 Bull 队列与后台任务生命周期

改造文件：

- `app/services/queue_service.ts`
- `app/services/task_service.ts`
- 各 Job 类按需补充关键业务日志

建议新增 helper：

```ts
async function runJobWithLog(job, handler, meta) {
  log.info({ type: 'queue', module: meta.module, action: 'job.started', ... })
  try {
    const result = await handler()
    log.info({ type: 'queue', module: meta.module, action: 'job.completed', ... })
    return result
  } catch (error) {
    await log.error({ type: 'queue', module: meta.module, action: 'job.failed', error, awaitPersist: true, ... })
    throw error
  }
}
```

`addTask()` 应记录：

- `queue.task.enqueued`
- `queue.task.skipped`，例如 path 正在扫描/删除时跳过

Bull event 应记录：

- `job.completed`
- `job.failed`
- `job.stalled`
- `job.retrying`

context 建议包含：

- `queueName`
- `taskQueue`
- `jobId`
- `taskName`
- `command`
- `args` 脱敏后摘要
- `attemptsMade`
- `maxAttempts`
- `timeout`
- `durationMs`

验收：

- 一个扫描任务从入队、开始、完成都有日志。
- 一个故意失败的任务在 `log` 表有 error，Bull 仍标记为 failed。
- 任务失败日志能看到 command、args 摘要和 stack。

### 阶段 6：补齐业务关键点

优先级从高到低：

1. 扫描链路
   - `app/services/scan_job.ts`
   - `app/services/scan_manga_job.ts`
   - 记录路径不存在、媒体库不存在、规则错误、章节插入失败、封面提取失败、元数据解析失败。
2. 下载与同步链路
   - `app/utils/api.ts`
   - `app/services/sync_media_job.ts`
   - `app/services/sync_manga_job.ts`
   - `app/services/sync_chapter_job.ts`
   - 记录远端状态码、URL 域名、重试次数、本地保存路径、最终失败原因。
3. 压缩与封面链路
   - `app/services/compress_chapter_job.ts`
   - `app/services/create_media_poster_job.ts`
   - `app/utils/sharp.ts`
   - 记录输入路径、输出路径、压缩类型、目标大小、异常。
4. P2P/Tracker 链路
   - `app/controllers/p2p/*`
   - `app/services/p2p/*`
   - `app/controllers/tracker/*`
   - 先通过 `p2p_log.ts` helper 覆盖错误，再逐步将关键成功事件结构化。
5. Cron/启动链路
   - `start/init.ts`
   - `app/services/cron_service.ts`
   - 记录配置自动补齐、cron 部署失败、heartbeat 启动失败、tracker cleanup 失败。

验收：

- 用户报告“扫描没反应”时，可以通过 pathId 找到任务是否入队、是否跳过、是否开始、是否完成、发现多少漫画、失败在哪个路径。
- 用户报告“P2P 拉不下来”时，可以通过 transferId/groupNo/nodeId 找到远端状态码、失败 seed、重试信息、最终失败原因。
- 用户报告“封面不显示”时，可以通过 mangaId/chapterId 找到封面提取/压缩/复制失败日志。

### 阶段 7：升级日志查询 API

改造文件：

- `app/controllers/logs_controller.ts`
- `app/validators/log.ts`
- 前端日志页后续再跟进

列表查询参数建议：

```ts
{
  page?: number
  pageSize?: number
  logType?: string
  logLevel?: number
  module?: string
  queue?: string
  userId?: number
  keyword?: string
  requestId?: string
  from?: string
  to?: string
}
```

排序：

- 默认 `createTime desc`
- 可选 `logId desc`，避免同一时间戳排序不稳定。

响应处理：

- SQLite 下将 `context/device/exception` 尝试 JSON.parse 后返回。
- JSON parse 失败时保留原字符串，不能让列表接口失败。

建议新增：

- `GET /log/summary`：返回最近 24h error/warn 数量、按模块聚合、最近失败任务。
- `DELETE /log/cleanup?before=...`：管理员手动清理。

验收：

- 管理员可以按 error、模块、时间范围筛选。
- 搜索关键词可以查 `message` 和 `exception`。
- 单条详情能看到完整 context/device/exception。

### 阶段 8：保留策略与配置

在 `data/config/smanga.json` 中补充：

```json
{
  "logging": {
    "enabled": true,
    "db": {
      "enabled": true,
      "minLevel": "info",
      "retainDays": 30,
      "maxContextBytes": 16000,
      "maxExceptionBytes": 32000
    },
    "http": {
      "enabled": true,
      "logSuccess": false,
      "slowMs": 1000,
      "sampleRate": 1
    },
    "security": {
      "enabled": true
    },
    "queue": {
      "enabled": true,
      "logCompleted": true
    }
  }
}
```

在 `start/init.ts` 的配置补齐逻辑中增加默认值。

在 `app/services/cron_service.ts` 中新增日志清理 cron：

- 默认每天执行一次。
- 删除 `createTime < now - retainDays` 的普通日志。
- `fatal/security/auth.login.failed` 可选更长保留期。

验收：

- 老配置启动后自动补齐 `logging`。
- 超过保留天数的日志会被清理。
- 清理任务本身写入一条 `system/log.cleanup.completed`。

## 6. 推荐文件改造清单

第一批必须改：

- `app/middleware/auth_middleware.ts`
- `app/exceptions/handler.ts`
- `app/utils/log.ts`
- `app/utils/p2p_log.ts`
- `app/controllers/logs_controller.ts`
- `app/validators/log.ts`
- `app/services/queue_service.ts`
- `start/kernel.ts`
- `start/init.ts`
- `prisma/sqlite/schema.prisma`
- `prisma/mysql/schema.prisma`
- `prisma/pgsql/schema.prisma`

第一批新增：

- `app/services/log_service.ts`
- `app/services/log_sanitizer.ts`
- `app/services/log_serializer.ts`
- `app/middleware/request_log_middleware.ts`
- `app/type/log.ts`
- 三套数据库的日志索引迁移

第二批逐步改：

- `app/services/scan_job.ts`
- `app/services/scan_manga_job.ts`
- `app/services/create_media_poster_job.ts`
- `app/services/reload_manga_meta_job.ts`
- `app/services/compress_chapter_job.ts`
- `app/services/cron_service.ts`
- `app/utils/api.ts`
- `app/utils/sharp.ts`
- `app/controllers/p2p/*`
- `app/services/p2p/*`
- `app/controllers/tracker/*`

## 7. 关键场景日志规范

本节不是全部控制器清单，而是核心场景的结构范例。实际覆盖范围应遵循“全量覆盖，分级落库”：所有控制器通过全局 request middleware 和 exception handler 自动覆盖；数据库 `log` 表只保存异常、慢请求、认证权限、写操作、后台任务、业务关键节点等高价值事件。

如果后续要给控制器补业务日志，优先补“改变系统状态”的控制器，例如用户、配置、媒体库、路径、漫画、章节、收藏、同步、分享、P2P 管理等；高频只读控制器，例如图片读取、文件流、漫画阅读翻页、列表查询，默认只记录异常和慢请求。

### 7.1 HTTP 未捕获异常

```json
{
  "logType": "http",
  "logLevel": 3,
  "module": "http",
  "message": "GET /media failed with 500",
  "context": {
    "action": "request.failed",
    "requestId": "...",
    "method": "GET",
    "url": "/media",
    "statusCode": 500,
    "durationMs": 128,
    "params": {},
    "query": {}
  },
  "device": {
    "ip": "...",
    "userAgent": "..."
  }
}
```

### 7.2 队列任务失败

```json
{
  "logType": "queue",
  "logLevel": 3,
  "module": "scan",
  "queue": "scan",
  "message": "taskScanManga failed",
  "context": {
    "action": "job.failed",
    "queueName": "smanga:default",
    "jobId": "123",
    "taskName": "scan_path_1",
    "command": "taskScanManga",
    "args": {
      "pathId": 1,
      "mangaPath": "D:/..."
    },
    "attemptsMade": 2
  }
}
```

### 7.3 P2P 远端错误

```json
{
  "logType": "p2p",
  "logLevel": 3,
  "module": "p2p",
  "message": "peer.manifest failed",
  "context": {
    "action": "peer.manifest.failed",
    "tag": "peer.manifest",
    "remoteStatus": 404,
    "remoteMessage": "manifest not found",
    "groupNo": "...",
    "nodeId": "..."
  }
}
```

### 7.4 登录失败

```json
{
  "logType": "auth",
  "logLevel": 2,
  "module": "auth",
  "message": "login failed: password mismatch",
  "userId": 12,
  "context": {
    "action": "login.failed",
    "userName": "admin",
    "reason": "password_mismatch"
  },
  "device": {
    "ip": "...",
    "userAgent": "..."
  }
}
```

## 8. 测试计划

### 8.1 单元测试

- `log_sanitizer` 会递归脱敏。
- `log_sanitizer` 会处理循环引用。
- `log_sanitizer` 会截断超长字符串。
- `log_serializer` 在 SQLite 下返回字符串，在 MySQL/PostgreSQL 下返回 JSON object。
- `fromError()` 能处理普通 Error、AxiosError、非 Error 抛出值。

### 8.2 功能测试

- 未捕获异常会落库。
- validation error 不泄露敏感 body。
- 登录成功/失败会落库。
- 缺 token / 无权限会落库。
- Bull job 成功/失败会落库。
- `log_p2p_error()` 会落库。
- `/log` 支持级别、模块、时间、关键词筛选。

### 8.3 回归测试

- `npm run typecheck`
- `npm run test`
- 手动跑一次扫描任务。
- 手动跑一次 P2P 拉取失败场景。
- 手动触发一次登录失败。
- 手动触发一次 500 接口。

## 9. 风险与规避

### 9.1 日志写入导致业务失败

规避：

- DB 写入必须 `try/catch`。
- 默认 fire-and-forget。
- `awaitPersist` 只用于少数审计/失败任务。

### 9.2 日志表增长过快

规避：

- 默认不记录普通成功 GET。
- 添加保留天数。
- 添加索引。
- 高频认证失败可采样或限流。

### 9.3 敏感信息泄露

规避：

- 所有 context/device/exception 统一走 sanitizer。
- 明确字段黑名单。
- 禁止记录 request body 原文。
- token/password/secret 永远不落明文。

### 9.4 多数据库 schema 不一致

规避：

- 日志服务统一序列化。
- 三套 schema 同步修改。
- 三套 migration 同步提交。

### 9.5 老代码迁移成本高

规避：

- 第一阶段保留旧 helper 名称。
- 先让旧调用自动变好，再逐步替换 `console.*`。
- 优先覆盖错误和任务生命周期，不追求一次性清完 224 处 console。

## 10. 建议执行顺序

1. 修复 `auth_middleware.ts` 双 `next()`。
2. 新增日志服务、脱敏器、序列化器和类型定义。
3. 改造 `app/utils/log.ts` 和 `app/utils/p2p_log.ts`，保持旧 API 兼容。
4. 接入 `app/exceptions/handler.ts`。
5. 新增请求日志 middleware 并注册到 `start/kernel.ts`。
6. 接入 auth/login 审计日志。
7. 改造 `queue_service.ts`，记录任务入队、开始、完成、失败。
8. 增加日志索引和 MySQL `message` 长度迁移。
9. 改造 `/log` 查询接口和 validator。
10. 补齐扫描、同步、压缩、P2P、Cron 关键业务点。
11. 增加日志保留配置和 cleanup cron。
12. 补测试并跑 typecheck/test。

## 11. 第一轮最小可交付范围

如果希望先快速改善排障能力，第一轮只做这些：

- 统一日志服务。
- 兼容旧 `error_log`、`insert_manga_scan_log`、`media_cover_log`。
- 让 `log_p2p_error` / `log_tracker_error` 进入 DB。
- 全局异常进入 DB。
- 登录失败、无 token、权限拒绝进入 DB。
- Bull job failed 进入 DB。
- `/log` 增加过滤条件。

这轮完成后，管理员已经可以覆盖大部分“用户说出错但不知道哪里错”的排障场景。
