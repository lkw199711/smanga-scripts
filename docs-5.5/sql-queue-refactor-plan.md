# SQL 任务队列重构方案

## 1. 背景与目标

当前 `smanga-adonis` 使用 Bull.js + Redis 作为任务队列。任务入口集中在 `smanga-adonis/app/services/queue_service.ts`，业务侧通过 `addTask({ taskName, command, args, priority, timeout })` 添加任务。

本次重构目标：

- 去掉 Redis 队列依赖，任务数据持久化到当前 SQL 数据库。
- 容器关闭或异常退出后，任务数据仍保留，重启后继续处理。
- 保持业务侧 `addTask` 入参不变，尽量不修改调用方代码。
- 不复用现有 `task`、`taskFailed`、`taskSuccess` 三张表，新建下划线命名表。
- 同时支持两种执行模式：
  - `embedded`：队列 worker 跟 Adonis Web 进程在一起，类似当前 Bull 使用体验。
  - `external`：队列 worker 由 s6 独立启动和守护，类似 Laravel queue worker。
- 默认采用两个逻辑 worker 组：
  - `background`：处理 `scan`、`sync`、`p2p`、`default`。
  - `compress`：单独处理 `compress`，避免扫描任务阻塞用户阅读相关的解压/压缩任务。

## 2. 当前相关文件

- `smanga-adonis/app/services/queue_service.ts`
  - 当前 Bull 队列定义、任务处理、`addTask`、`path_scanning`、`path_deleting` 都在这个文件中。
- `smanga-adonis/app/services/cron_service.ts`
  - 定时任务通过 `addTask` 入队。
- `smanga-adonis/start/init.ts`
  - 初始化配置、默认配置补全、启动 cron，目前会把旧 `task` 表里的 `in-progress` 重置为 `pending`。
- `smanga-adonis/app/controllers/tasks_controller.ts`
  - 当前通过 `scanQueue.getJobs/getJob/clean` 管理 Bull 任务。
- `smanga/docker/etc/s6-overlay/s6-rc.d`
  - 当前有 `svc-adonis`、`svc-express`、`svc-redis`。后续会新增队列 worker 服务。
- `smanga-adonis/prisma/mysql|pgsql|sqlite/schema.prisma`
  - 项目实际主要使用 Prisma，需要三套数据库 schema/migration 同步新增队列表。

## 3. smanga.json 配置设计

建议在 `smanga.json` 中将 `queue` 配置扩展为：

```json
{
  "queue": {
    "driver": "sql",
    "attempts": 3,
    "timeout": 120000,
    "pollIntervalMs": 1000,
    "retry": {
      "baseDelayMs": 10000,
      "maxDelayMs": 120000,
      "jitter": true
    },
    "worker": {
      "mode": "embedded",
      "stalledAfterMs": 60000,
      "heartbeatIntervalMs": 10000,
      "gracefulShutdownMs": 30000
    },
    "workers": {
      "background": {
        "enabled": true,
        "queues": ["scan", "sync", "p2p", "default"],
        "concurrency": 1
      },
      "compress": {
        "enabled": true,
        "queues": ["compress"],
        "concurrency": 1
      }
    }
  }
}
```

字段语义：

- `driver`
  - 第一阶段只实现 `sql`。旧 Bull/Redis 可作为回退分支保留一段时间，也可以直接移除。
- `worker.mode`
  - `embedded`：`svc-adonis` 启动时在同一 Node 进程内启动两个 worker loop。
  - `external`：`svc-adonis` 只入队，s6 启动 `svc-queue-background` 和 `svc-queue-compress`。
  - `disabled`：只允许入队，不执行任务，用于维护或调试。
- `workers.background.queues`
  - 表示这个 worker 组消费哪些逻辑队列，不表示自动生成几个 s6 服务。
- `workers.compress.queues`
  - 独立消费 `compress`，保证扫描期间仍可处理阅读相关任务。

`start/init.ts` 需要补全旧配置。如果旧 `smanga.json` 只有：

```json
{
  "queue": {
    "concurrency": 1,
    "attempts": 3,
    "timeout": 120000
  }
}
```

迁移时应兼容：

- `queue.concurrency` 映射为 `workers.background.concurrency` 和 `workers.compress.concurrency` 的默认值。
- 保留 `attempts`、`timeout` 旧字段含义。

## 4. 新表设计

不要使用旧表：

- `task`
- `taskFailed`
- `taskSuccess`

新增下划线命名表：

### 4.1 queue_jobs

当前等待中或执行中的任务。

建议字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键，自增 |
| `queue_name` | 实例队列名，例如 `smanga:${serverKey}` |
| `task_queue` | 逻辑队列：`scan`、`sync`、`compress`、`p2p`、`default` |
| `task_name` | 原 `addTask.taskName` |
| `command` | 原 `addTask.command` |
| `args` | JSON 参数 |
| `status` | `pending`、`running` |
| `priority` | 优先级，沿用现有规则：数值越小越优先 |
| `attempts_made` | 已开始执行次数 |
| `max_attempts` | 最大执行次数 |
| `timeout_ms` | 任务超时时间 |
| `available_at` | 任务可被消费时间，用于延迟重试 |
| `locked_by` | 当前 worker id |
| `locked_until` | 锁过期时间，用于崩溃恢复 |
| `started_at` | 本次开始执行时间 |
| `last_error` | 最近一次错误 |
| `created_at` | 创建时间 |
| `updated_at` | 更新时间 |

建议索引：

- `(queue_name, task_queue, status, available_at, priority, id)`
- `(status, locked_until)`
- `(task_name, status)`
- `(locked_by)`

### 4.2 queue_failed_jobs

超过最大重试次数后的失败任务。

建议字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 主键，自增 |
| `original_job_id` | 原 `queue_jobs.id` |
| `queue_name` | 队列名 |
| `task_queue` | 逻辑队列 |
| `task_name` | 任务名 |
| `command` | 命令 |
| `args` | JSON 参数 |
| `attempts_made` | 失败前执行次数 |
| `max_attempts` | 最大执行次数 |
| `error` | 错误信息 |
| `failed_at` | 失败时间 |
| `created_at` | 创建时间 |

### 4.3 queue_workers

记录正在运行的 worker。用于观测、心跳和排查。

建议字段：

| 字段 | 说明 |
| --- | --- |
| `worker_id` | 主键，例如 `hostname:pid:background:uuid` |
| `worker_group` | `background` 或 `compress` |
| `mode` | `embedded` 或 `external` |
| `queues` | JSON，当前消费的逻辑队列 |
| `status` | `running`、`stopped` |
| `started_at` | 启动时间 |
| `heartbeat_at` | 最近心跳 |
| `stopped_at` | 停止时间 |
| `metadata` | JSON，记录 pid、hostname、version 等 |

### 4.4 是否需要 queue_job_events

第一阶段不建议加。当前项目已有统一日志表和 `log_service.ts`，队列执行日志继续走日志系统即可。

如果未来需要完整队列审计、任务耗时统计、重试时间线，再新增：

- `queue_job_events`

## 5. Prisma 修改

需要同时修改：

- `smanga-adonis/prisma/mysql/schema.prisma`
- `smanga-adonis/prisma/pgsql/schema.prisma`
- `smanga-adonis/prisma/sqlite/schema.prisma`

新增模型建议命名：

- `queue_job @@map("queue_jobs")`
- `queue_failed_job @@map("queue_failed_jobs")`
- `queue_worker @@map("queue_workers")`

同时新增 migration：

- `smanga-adonis/prisma/mysql/migrations/<timestamp>_sql_queue/migration.sql`
- `smanga-adonis/prisma/pgsql/migrations/<timestamp>_sql_queue/migration.sql`
- `smanga-adonis/prisma/sqlite/migrations/<timestamp>_sql_queue/migration.sql`

注意：

- MySQL 可使用 `JSON`、`TEXT`、`DATETIME(6)`。
- PostgreSQL 可使用 `JSONB`、`TEXT`、`TIMESTAMP`。
- SQLite 的 JSON 实际存储可以走 Prisma `Json`，底层仍是文本能力。
- 字段命名尽量统一 snake_case，Prisma model 字段可用 camelCase 并 `@map`，也可以直接 snake_case。为了减少 raw SQL 心智负担，建议数据库字段使用 snake_case。

## 6. 代码模块拆分

### 6.1 queue_service.ts 改成轻量 facade

文件：

- `smanga-adonis/app/services/queue_service.ts`

改造目标：

- 保留导出：
  - `addTask`
  - `path_scanning`
  - `path_deleting`
  - `scanQueue` 兼容对象
- 移除：
  - `Bull` import
  - Redis 配置
  - 顶部对所有 Job 类的 import
  - `scanQueue.process(...)`
- 只负责：
  - 判断 `dispatchSync`
  - 判断 path 是否正在扫描/删除
  - 计算 `taskQueue`
  - 写入 `queue_jobs`
  - 写日志
  - 提供 `getJobs/getJob/clean/remove` 兼容方法

`addTask` 入参必须不变：

```ts
type addTaskType = {
  taskName: string
  command: string
  args: any
  priority?: number
  timeout?: number
}
```

返回值建议是 job-like 对象：

```ts
{
  id,
  data: { taskName, command, args },
  queue: { name: taskQueue },
  opts: { priority, timeout, attempts }
}
```

这样 `TasksController` 和未来前端任务页更容易兼容。

### 6.2 新增队列配置模块

建议新增：

- `smanga-adonis/app/services/queue/queue_config.ts`

职责：

- 读取 `smanga.json`
- 合并默认值
- 兼容旧字段
- 提供：
  - `getQueueConfig()`
  - `getQueueName()`
  - `getWorkerConfig(workerGroup)`
  - `resolveTaskQueue(taskName, command)`

### 6.3 新增仓储模块

建议新增：

- `smanga-adonis/app/services/queue/sql_queue_repository.ts`

职责：

- `enqueueJob`
- `listJobs`
- `getJob`
- `removeJob`
- `cleanJobs`
- `pathJobExists`
- `claimNextJob`
- `markJobCompleted`
- `markJobFailedOrRetry`
- `recoverStalledJobs`
- `heartbeatWorker`
- `stopWorker`

### 6.4 新增任务执行模块

建议新增：

- `smanga-adonis/app/services/queue/job_runner.ts`

职责：

- 根据 `command` 调用具体 Job 类。
- 只在 worker 进程或 embedded worker 启动后加载。
- 可以把当前 `queue_service.ts` 中的 `task_process` 移到这里。

重点：

- 不要让 Web 入队路径 import 这个文件。
- Job 类 import 可以先静态 import，后续若追求更低内存，可改为按 command 动态 import。

### 6.5 新增 worker 服务

建议新增：

- `smanga-adonis/app/services/queue/sql_queue_worker_service.ts`

职责：

- 启动 worker loop。
- 按 `workerGroup` 读取 queues 和 concurrency。
- 循环 claim job。
- 调用 `runJobWithLog` + `job_runner.runJobCommand`。
- 成功删除或归档。
- 失败时重试或写入 `queue_failed_jobs`。
- 定时 heartbeat。
- 定时 recover stalled jobs。
- 处理 SIGTERM/SIGINT，优雅退出。

## 7. 任务抢占与并发算法

目标是跨 MySQL/PostgreSQL/SQLite 尽量一致，不依赖单一数据库的 `FOR UPDATE SKIP LOCKED`。

建议流程：

1. 查询候选任务：
   - `queue_name = 当前 queueName`
   - `task_queue in worker.queues`
   - `status = pending`
   - `available_at <= now`
   - order by `priority asc, id asc`
2. 对候选任务逐个尝试原子更新：
   - where `id = candidate.id`
   - where `status = pending`
   - update：
     - `status = running`
     - `locked_by = workerId`
     - `locked_until = now + stalledAfterMs`
     - `started_at = now`
     - `attempts_made = attempts_made + 1`
3. 如果 update count 为 1，说明抢占成功。
4. 如果 update count 为 0，说明被其他 worker 抢走，继续尝试下一个候选。

这样多个 worker 同时运行时也不会执行同一个 job。

## 8. 重试与失败

沿用当前 Bull 的语义：

- 默认 `attempts = 3`
- 指数退避：
  - base delay：10 秒
  - factor：2
  - max delay：2 分钟
  - jitter：开启

失败处理：

- 如果 `attempts_made < max_attempts`：
  - `status = pending`
  - `available_at = now + backoffDelay`
  - 清空 `locked_by`、`locked_until`
  - 写入 `last_error`
- 如果 `attempts_made >= max_attempts`：
  - 插入 `queue_failed_jobs`
  - 删除 `queue_jobs`

## 9. 超时说明

`timeout_ms` 可以用 `Promise.race` 实现软超时：

- 超时后将任务视为失败。
- 但 JavaScript 无法强制中断所有底层文件操作、sharp、7z、unrar 或网络请求。

如果未来需要“强制杀死任务”，需要升级为“每个任务独立 child process”的模型。第一阶段不建议这么做，资源成本和复杂度都更高。

## 10. 容器重启与 stalled 恢复

worker 启动时和运行中定期执行：

```txt
找出 status = running 且 locked_until < now 的任务
如果 attempts_made >= max_attempts，归档到 queue_failed_jobs
否则重置为 pending，available_at = now
```

这可以覆盖：

- 容器被强杀
- s6 重启 worker
- Node 进程异常退出

## 11. s6 服务设计

新增两个 longrun 服务：

```txt
smanga/docker/etc/s6-overlay/s6-rc.d/svc-queue-background
smanga/docker/etc/s6-overlay/s6-rc.d/svc-queue-compress
```

`svc-queue-background/run`：

```bash
#!/usr/bin/with-contenv bash
# shellcheck shell=bash

cd /app/adonis || exit

exec s6-setuidgid smanga nodejs bin/queue_worker.js --worker=background
```

`svc-queue-compress/run`：

```bash
#!/usr/bin/with-contenv bash
# shellcheck shell=bash

cd /app/adonis || exit

exec s6-setuidgid smanga nodejs bin/queue_worker.js --worker=compress
```

每个服务增加：

- `type`：内容为 `longrun`
- `dependencies.d/init-config`：空文件

并添加到：

- `smanga/docker/etc/s6-overlay/s6-rc.d/user/contents.d/svc-queue-background`
- `smanga/docker/etc/s6-overlay/s6-rc.d/user/contents.d/svc-queue-compress`

### 11.1 s6 服务如何响应配置

服务文件可以一直存在，但 `bin/queue_worker.js` 启动后先读 `smanga.json`：

- 如果 `queue.worker.mode !== "external"`，打印日志后进入轻量 sleep 或直接退出。
- 如果对应 worker `enabled !== true`，打印日志后进入轻量 sleep 或直接退出。

建议使用 sleep loop，而不是反复退出，避免 s6 频繁重启刷日志。

## 12. 新增 worker 启动入口

建议新增：

- `smanga-adonis/bin/queue_worker.ts`

不要使用完整 `node ace queue:work` 作为第一选择。原因：

- `ace` 可能加载更多 Adonis CLI/命令上下文。
- worker 不需要 HTTP server、routes、middleware。
- 轻量入口更省内存。

入口职责：

1. 解析 `--worker=background|compress`。
2. 读取配置。
3. 如果不是 external，sleep。
4. 启动 `SqlQueueWorkerService`。

## 13. embedded 模式启动

文件：

- `smanga-adonis/start/init.ts`

在初始化和 cron 创建后：

```txt
if queue.worker.mode === "embedded":
  start background worker loop
  start compress worker loop
else:
  do not start worker
```

注意：

- embedded 模式下仍然是两个独立 worker loop，不是单一队列。
- 这样低内存用户可以不新增 Node 进程，同时避免扫描阻塞 compress。

## 14. 旧 Redis/Bull 清理

第一阶段可以保留依赖，确保 SQL 队列稳定后再移除。

稳定后移除：

- `smanga-adonis/package.json`
  - `bull`
  - `bull-board`
  - `redis`
- `smanga/docker/etc/s6-overlay/s6-rc.d/svc-redis`
- `smanga/docker/etc/s6-overlay/s6-rc.d/user/contents.d/svc-redis`
- `Dockerfile` 中 apk `redis`
- `start-redis.bat`

`smanga.json` 中 `redis` 节点可以保留一到两个版本作为兼容，无需再补默认值。

## 15. 控制器兼容

文件：

- `smanga-adonis/app/controllers/tasks_controller.ts`

当前依赖：

- `scanQueue.getJobs(['active', 'waiting'])`
- `scanQueue.getJob(taskId)`
- `job.remove()`
- `scanQueue.clean(0)`

建议在 `queue_service.ts` 中导出 SQL facade：

```ts
const scanQueue = {
  getJobs: async (states) => ...,
  getJob: async (id) => ...,
  clean: async () => ...
}
```

这样 `TasksController` 可以少改或不改。

## 16. 实施顺序

1. 新增三套 Prisma schema 和 migration。
2. 新增 `queue_config.ts`、`sql_queue_repository.ts`。
3. 改造 `queue_service.ts` 为轻量入队 facade。
4. 新增 `job_runner.ts`，迁移 `task_process`。
5. 新增 `sql_queue_worker_service.ts`。
6. 新增 `bin/queue_worker.ts`。
7. 改造 `start/init.ts` 支持 `embedded`。
8. 改造 `TasksController` 或保持 facade 兼容。
9. 新增 s6 两个 queue worker 服务。
10. 默认先使用 `embedded` 验证。
11. 再切到 `external` 验证 s6 worker。
12. 稳定后移除 Redis/Bull。

## 17. 验证清单

功能验证：

- `addTask` 入参不变，所有调用点无需修改。
- scan 任务能入队并执行。
- compress 任务能入队并执行。
- 扫描运行中，compress 任务不会被 background 队列阻塞。
- sync 任务能执行。
- p2p 任务能执行。
- `debug.dispatchSync == 1` 仍然同步执行。
- `path_scanning(pathId)` 能识别 pending/running 的扫描任务。
- `path_deleting(pathId)` 能识别 pending/running 的删除任务。
- 任务失败后按 backoff 重试。
- 超过 attempts 后进入 `queue_failed_jobs`。
- kill worker 后，任务能在 `locked_until` 过期后恢复。

接口验证：

- 任务列表接口返回 pending/running 任务。
- 单个任务查询可用。
- 删除任务可用。
- 清空任务可用。

容器验证：

- `queue.worker.mode=embedded` 时不需要 s6 queue worker 也能执行。
- `queue.worker.mode=external` 时，`svc-adonis` 不执行任务，两个 s6 worker 执行任务。
- 关闭 `workers.compress.enabled` 后，compress worker 不执行任务。
- 关闭 `workers.background.enabled` 后，background worker 不执行任务。

性能验证：

- 记录改造前后空闲 RSS。
- 记录 external 模式新增两个 worker 后的 RSS。
- 记录扫描期间 compress 任务等待时间。

