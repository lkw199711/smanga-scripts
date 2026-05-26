# Adonis P2P 具体修复计划

日期：2026-05-26

关联排查报告：`scripts/doc/gpt5.5/adonis-p2p-logic-audit.md`

## 修复目标

本计划的目标不是只让某个失败场景临时通过，而是把 P2P 链路修到可恢复、可观测、可验证：

1. 拉取任务不再依赖进程内状态，父子任务完成情况可以跨进程、跨重启恢复。
2. 多 tracker 之间节点、分组、成员、share index、manifest 数据一致。
3. peer 端展示的节点在线状态、资源归属、last seen 字段稳定且语义明确。
4. 长时间 P2P 下载不会被默认短 timeout 或 queue stalled recovery 误杀。
5. 关键失败原因能在日志或管理端看到，方便继续排查生产问题。

## 总体拆分

建议分 6 个 PR 或 6 个连续提交阶段推进：

| 阶段 | 主题 | 优先级 | 目标 |
| --- | --- | --- | --- |
| 0 | 复现与保护用例 | P0 | 固化当前失败场景，避免边修边回退 |
| 1 | 拉取任务状态持久化 | P0 | 修复 transfer 卡住和子任务汇总丢失 |
| 2 | Queue timeout 与 lock 续租 | P1 | 修复长下载被误杀、重复执行 |
| 3 | 多 tracker 资源同步 | P0 | 修复 tracker 之间 share/manifest 不一致 |
| 4 | 节点状态与 peer 展示 | P1 | 修复在线状态、节点名、last seen 展示异常 |
| 5 | 可观测性、鉴权和类型收口 | P2 | 降低后续排查成本，补齐边界风险 |

## 阶段 0：复现与保护用例

### 要做什么

先搭出最小可复现拓扑：

1. tracker A：开启 tracker role，配置 sync key。
2. tracker B：开启 tracker role，配置同一个 sync key。
3. node S：注册到 tracker A，分享一个 media/manga/chapter。
4. peer P：优先访问 tracker B，尝试查看资源并拉取。

需要覆盖三类现有失败：

1. S 只 announce 到 tracker A 后，P 从 tracker B 看不到 share/manifest。
2. 拉取 media 拆分多个 manga/chapter 后，transfer 长时间保持 `running`。
3. tracker B 通过 sync 看到 node S，但 peer 页面显示 S 离线或节点名为空。

### 建议新增测试

后端建议新增：

- `smanga-adonis/tests/functional/p2p/pull_transfer_progress.spec.ts`
- `smanga-adonis/tests/functional/p2p/tracker_share_sync.spec.ts`
- `smanga-adonis/tests/functional/p2p/peer_status_cache.spec.ts`
- `smanga-adonis/tests/unit/queue/sql_queue_lock_renew.spec.ts`

如果当前测试基建不方便直接启动多实例，可以先用 service 层测试模拟两个 tracker 数据库上下文，至少固化 merge 和 tracking 逻辑。

### 验收标准

1. 当前失败用例能稳定复现。
2. 新增测试在修复前失败，修复后通过。
3. 记录必要的 fixture 数据和配置样例，后续修复阶段不再靠手动猜测。

## 阶段 1：拉取任务状态持久化

### 当前根因

`pull_child_tracker.ts` 用模块级 Map 保存父子任务计数，但 SQL queue 每个 job 都通过 forked child process 执行。父任务进程退出后 Map 被销毁，子任务进程里的 `notifyDone()` 找不到父任务 entry，transfer 无法完成。

### 数据库改造

建议新增一张表，而不是直接把所有字段塞进 `p2p_transfer`。这样可以保留更细粒度的子任务状态，方便恢复和排查。

建议表名：`p2p_transfer_tasks`

建议字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | bigint | 主键 |
| `transfer_id` | bigint | 关联 `p2p_transfer.id` |
| `parent_key` | string/null | 父级任务 key，例如 media/manga |
| `task_key` | string | 子任务唯一 key，例如 `meta:{mangaId}`、`chapter:{chapterId}` |
| `task_type` | string | `media` / `manga` / `meta` / `chapter` |
| `queue_job_id` | bigint/null | 对应 SQL queue job id |
| `status` | string | `pending` / `running` / `completed` / `failed` / `canceled` |
| `error_message` | text/null | 失败原因 |
| `started_at` | timestamp/null | 开始时间 |
| `finished_at` | timestamp/null | 结束时间 |
| `created_at` | timestamp | 创建时间 |
| `updated_at` | timestamp | 更新时间 |

建议唯一索引：

- `unique(transfer_id, task_key)`
- `index(transfer_id, status)`
- `index(queue_job_id)`

如果希望更快判断总进度，可以在 `p2p_transfer` 增加冗余字段：

- `expected_tasks`
- `completed_tasks`
- `failed_tasks`
- `canceled_tasks`
- `last_error`

这些字段必须通过事务维护，不能由内存计数维护。

### 代码改造

#### 1. 保留 `pull_child_tracker.ts` 对外 API，替换内部实现

目标文件：

- `smanga-adonis/app/services/p2p/pull/pull_child_tracker.ts`

建议短期保留现有函数名，降低调用侧改动：

- `initTracker(transferId, expected, selfCount)`
- `transferSelfToChildren(transferId, childCount)`
- `notifyDone(transferId, result)`

但内部改为：

1. `initTracker()` 写入或更新 `p2p_transfer.expected_tasks`。
2. 子任务 enqueue 前，先创建 `p2p_transfer_tasks` pending 记录。
3. enqueue 成功后回写 `queue_job_id`。
4. `notifyDone()` 在数据库事务中更新子任务状态，并原子更新 transfer 计数。
5. 如果所有子任务已终态，则调用统一 finalizer 更新 transfer 状态。

#### 2. 新增 transfer finalizer

建议新增：

- `smanga-adonis/app/services/p2p/pull/pull_transfer_finalizer.ts`

职责：

1. 根据 `p2p_transfer_tasks` 汇总 transfer。
2. 如果存在 failed，则 transfer 标记 `failed`。
3. 如果全部 canceled，则 transfer 标记 `canceled`。
4. 如果全部 completed，则 transfer 标记 `completed`。
5. 写入完成时间和最后错误。
6. finalizer 必须幂等，允许重复调用。

#### 3. 修改子任务创建点

目标文件：

- `smanga-adonis/app/services/p2p/pull/pull_media_sub_job.ts`
- `smanga-adonis/app/services/p2p/pull/pull_manga_sub_job.ts`
- `smanga-adonis/app/services/p2p/p2p_pull_job.ts`

具体动作：

1. enqueue 子任务前创建 tracking row。
2. enqueue 成功后回写 queue job id。
3. enqueue 失败时把 tracking row 标记 failed，并触发 finalizer。
4. 子任务参数里带上 `taskKey` 或 `transferTaskId`，避免 `notifyDone()` 只能靠 transferId 猜当前任务。

#### 4. 修改子任务完成点

目标文件：

- `smanga-adonis/app/services/p2p/pull/pull_chapter_sub_job.ts`
- `smanga-adonis/app/services/p2p/pull/pull_meta_sub_job.ts`
- `smanga-adonis/app/services/p2p/pull/pull_manga_sub_job.ts`
- `smanga-adonis/app/services/p2p/pull/pull_media_sub_job.ts`

具体动作：

1. 任务开始时把 tracking row 标记 `running`。
2. 成功时标记 `completed`。
3. 捕获异常时标记 `failed` 并写入错误。
4. `finally` 中调用 finalizer，但要避免吞掉原异常。

### 恢复任务

建议新增定时恢复逻辑：

- 扫描长时间 `running` 的 `p2p_transfer`。
- 查对应 `p2p_transfer_tasks` 和 queue job 状态。
- 如果 queue job 都已终态，则补跑 finalizer。
- 如果 queue job 不存在或已失败，则把对应 transfer task 标记 failed。

可放在：

- `smanga-adonis/app/services/p2p/pull/pull_transfer_recovery_service.ts`

并在启动流程中按配置启用。

### 验收标准

1. media 拉取拆成多个 manga/chapter 后，父任务进程退出不影响最终 transfer 完成。
2. 任意一个 chapter 失败时，transfer 最终能进入 `failed`，并保留失败原因。
3. 重启 Adonis 后，未完成 transfer 能被 recovery 继续归档或标记失败。
4. `pull_child_tracker.ts` 不再包含模块级运行状态 Map。

## 阶段 2：Queue timeout 与 lock 续租

### 当前根因

P2P 下载任务默认使用 queue timeout 120 秒，stalled lock 默认 60 秒。长下载会被 kill，或被 recover 逻辑误判为 stalled。

### 配置改造

建议在 P2P 配置中增加独立 timeout：

```ts
p2p: {
  pull: {
    timeoutMs: {
      root: 6 * 60 * 60 * 1000,
      media: 6 * 60 * 60 * 1000,
      manga: 3 * 60 * 60 * 1000,
      chapter: 30 * 60 * 1000,
      meta: 10 * 60 * 1000,
    },
  },
}
```

目标文件：

- `smanga-adonis/start/init.ts`
- `smanga-adonis/app/services/queue/queue_config.ts`
- 现有 P2P config 类型文件，如果已有集中定义，也需要同步补齐。

### enqueue 改造

目标文件：

- `smanga-adonis/app/controllers/p2p/p2p_transfers_controller.ts`
- `smanga-adonis/app/services/p2p/p2p_pull_job.ts`
- `smanga-adonis/app/services/p2p/pull/pull_media_sub_job.ts`
- `smanga-adonis/app/services/p2p/pull/pull_manga_sub_job.ts`

具体动作：

1. `taskP2PPull` 使用 root timeout。
2. `taskP2PPullMedia` 使用 media timeout。
3. `taskP2PPullManga` 使用 manga timeout。
4. `taskP2PPullChapter` 使用 chapter timeout。
5. `taskP2PPullMeta` 使用 meta timeout。

### lock 续租改造

目标文件：

- `smanga-adonis/app/repositories/sql_queue_repository.ts`
- `smanga-adonis/app/services/queue/sql_queue_worker_service.ts`

建议新增 repository 方法：

```ts
extendRunningJobLock(jobId, workerId, lockedUntil)
```

约束：

1. 只能续租 `status = running` 的 job。
2. 必须匹配当前 `worker_id`，避免其他 worker 抢占后被旧 worker 续租。
3. 续租失败时 worker 需要记录 error，并考虑终止当前 child process。

worker 执行 child process 时：

1. 启动一个 interval。
2. 每隔 `stalledAfterMs / 3` 续租一次。
3. `locked_until` 建议设置为 `now + stalledAfterMs` 或更长。
4. child exit 后清理 interval。

### timeout/failure 状态联动

当 child process 因 timeout 被 kill：

1. queue job 标记 failed。
2. 如果 job 是 P2P transfer task，同步把 `p2p_transfer_tasks.status` 标记 failed。
3. 调用 transfer finalizer。

这一步需要 queue job payload 能定位 `transferTaskId` 或 `transferId + taskKey`。

### 验收标准

1. 一个超过 60 秒但仍在下载的 chapter job 不会被 recoverStalledJobs 重置。
2. 一个超过 120 秒但未超过 P2P 专用 timeout 的下载不会被 kill。
3. timeout 后 transfer 不会停在 `running`。
4. 同一个 transfer task 不会被两个 worker 同时执行。

## 阶段 3：多 tracker 资源同步

### 当前根因

`announce_group` 实际只发给第一个成功 tracker；tracker sync 又不包含 share index 和 manifest，所以 tracker 之间不会传播资源数据。

### announce fan out

目标文件：

- `smanga-adonis/app/controllers/p2p/p2p_shares_controller.ts`

具体动作：

1. 移除第一个成功后 `break` 的逻辑。
2. 对所有 reachable tracker 都执行 announce。
3. 返回结构改成 per-tracker 结果，例如：

```json
{
  "ok": true,
  "results": [
    { "url": "http://tracker-a/api", "ok": true },
    { "url": "http://tracker-b/api", "ok": false, "error": "timeout" }
  ]
}
```

4. 如果至少一个 tracker 成功，可以允许本地操作成功，但必须记录失败 tracker。
5. 如果全部失败，则返回失败。

### tracker sync API

目标文件：

- `smanga-adonis/app/controllers/tracker/tracker_sync_controller.ts`
- `smanga-adonis/start/routes.ts`
- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`

建议新增路由：

- `GET /tracker/sync/group/:groupNo/shares`
- `GET /tracker/sync/group/:groupNo/manifests`

或如果数据量较大，使用分页全局接口：

- `GET /tracker/sync/shares?cursor=&limit=&updatedAfter=`
- `GET /tracker/sync/manifests?cursor=&limit=&updatedAfter=`

建议响应必须包含：

- `items`
- `nextCursor`
- `serverTime`
- `syncVersion` 或 `updatedAt`

### merge 逻辑

目标文件：

- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`
- `smanga-adonis/app/services/tracker/tracker_share_service.ts`

新增方法：

- `syncShares(peerUrl)`
- `syncManifests(peerUrl)`
- `mergeShares(items, sourceTracker)`
- `mergeManifests(items, sourceTracker)`

要求：

1. merge 必须幂等。
2. 相同 share 不重复插入。
3. 使用 `updatedAt`、`deletedAt` 或 `version` 避免旧数据覆盖新数据。
4. 对不存在的 owner node，要先创建 placeholder node，但状态来源标记为 synced。
5. 对不存在的 group，要先创建或跳过并记录错误，不能静默丢弃。

### stale manifest cleanup

目标文件：

- `smanga-adonis/app/services/tracker/tracker_share_service.ts`

当前 full-cover announce 删除旧 `tracker_share_index`，但可能留下旧 `tracker_share_manifest`。

建议两种方案二选一：

方案 A：引入 tombstone

1. 给 share index 和 manifest 增加 `deleted_at`。
2. 删除/禁用 share 时写 tombstone。
3. sync 时传播 tombstone。
4. 查询时默认过滤 `deleted_at is null`。

方案 B：full-cover cleanup

1. 每次 node 对 group announce 都认为 payload 是该 node 当前完整 share 集合。
2. 删除 index 时同步删除该 node/group 下不在 payload 中的 manifest。
3. tracker sync 时也按 full-cover 语义清理。

建议优先方案 A。多 tracker 场景下 tombstone 更适合解决删除传播和乱序同步问题。

### tracker peers 配置

目标文件：

- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`
- `smanga-adonis/start/init.ts`

具体动作：

1. 新增 `p2p.tracker.peers`。
2. `getPeerTrackerUrls()` 改为读取 tracker peers。
3. 兼容旧配置：如果 `p2p.tracker.peers` 为空，可以临时 fallback 到 `p2p.node.trackers`，但要记录 deprecation warning。
4. 启动时如果 tracker sync enabled 但 peers 为空，明确输出 warning。

### 验收标准

1. node S 只向 tracker A announce，tracker B sync 后能查到同一 share index 和 manifest。
2. peer P 只连 tracker B，也能找到 seed 并发起拉取。
3. 删除 share 后，tracker A 和 B 都不再返回旧 manifest。
4. 一个 tracker 暂时不可达时，其他 tracker announce 不受影响；恢复后 sync 能补齐数据。

## 阶段 4：节点状态与 peer 展示

### 当前根因

tracker sync 创建的 node 默认离线；已有 node 也不会更新在线状态。peer manifest cache 读取时不关联 peer cache，导致节点名和在线状态丢失。

### 后端状态语义

目标文件：

- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`
- `smanga-adonis/app/services/tracker/tracker_node_service.ts`
- 对应 node model / migration

建议字段：

| 字段 | 说明 |
| --- | --- |
| `online` | 最终展示状态，兼容现有接口 |
| `last_heartbeat` | 最终展示用最新可证明 heartbeat |
| `status_source` | `direct` / `synced` / `unknown` |
| `synced_from_tracker` | 最近状态来源 tracker |
| `synced_at` | 状态同步时间 |

如果可以接受更完整改造，则拆成：

- `direct_online`
- `direct_last_heartbeat`
- `synced_online`
- `synced_last_heartbeat`
- `effective_online`
- `effective_last_seen`

短期建议保持接口兼容，只增加 source 字段，避免前端大改。

### sync merge 改造

目标文件：

- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`

具体动作：

1. `mergeNodes()` 不再对已有 node 直接跳过。
2. 如果 peer node 的 `lastHeartbeat` 更新，则更新本地 node 的 `lastHeartbeat`、`online`、`publicUrl`、`statusSource`。
3. 对同步来的在线状态设置过期窗口，例如超过 `heartbeatTtlMs * 2` 则展示为离线。
4. placeholder node 要标记 `statusSource = synced` 或 `unknown`，不能伪装成 direct heartbeat。

### peer cache 和 manifest 展示

目标文件：

- `smanga-adonis/app/controllers/p2p/p2p_peers_controller.ts`
- `smanga/src/views/p2p-peers/index.vue`

后端改造：

1. `_readLocalManifests()` 查询本地 manifest cache 时 join `p2p_peer_cache`。
2. 返回 `nodeName`、`online`、`lastSeen`。
3. 统一 manifest 接口输出字段：同时给 `lastHeartbeat` 和 `lastSeen`，或者明确只保留一个并前端同步改。
4. `sync=0` 实现真正 local-only，不再访问 tracker。

前端改造：

1. members 表兼容 `lastSeen` / `lastHeartbeat`。
2. shares 表使用后端返回的 normalized status。
3. UI 文案与实际参数一致。`fromTracker=false` 必须真的只读本地缓存。

### 验收标准

1. tracker B 通过 sync 获得 tracker A 的在线 node 后，peer 页面不再显示未知节点。
2. 本地缓存模式下，manifest 仍能显示 nodeName 和 last seen。
3. 断开 node heartbeat 后，状态会按 TTL 变为离线，不会永久在线。
4. `sync=0` 时后端不会请求 tracker。

## 阶段 5：可观测性、鉴权和类型收口

### tracker sync health

建议新增：

- `smanga-adonis/app/services/tracker/tracker_sync_health_service.ts`
- 管理端接口可放在 tracker admin controller 中。

记录内容：

| 字段 | 说明 |
| --- | --- |
| `peer_url` | peer tracker URL |
| `last_success_at` | 最近成功时间 |
| `last_error_at` | 最近失败时间 |
| `last_error_message` | 最近失败原因 |
| `groups_synced` | 最近同步 group 数 |
| `shares_synced` | 最近同步 share 数 |
| `manifests_synced` | 最近同步 manifest 数 |

这样 `/p2p/tracker/sync-now` 不再只返回一段文本，而是能定位是哪一个 peer、哪一种数据同步失败。

### peer auth 收口

目标文件：

- `smanga-adonis/app/middleware/p2p_peer_auth_middleware.ts`

具体动作：

1. 增加配置 `p2p.peerAuth.softAllowOnTrackerDown`。
2. 如果配置为 false，tracker 不可用时拒绝 serve 请求。
3. timestamp 缺失时是否拒绝要配置化；如果签名协议要求 timestamp，则默认拒绝。
4. 对 soft allow 事件写入安全日志，至少包含 groupNo、nodeId、request path、原因。

### TypeScript 类型收口

目标文件：

- `smanga-adonis/app/type/p2p.ts`
- `smanga-adonis/app/services/p2p/manifest/manifest_types.ts`
- `smanga-adonis/app/controllers/p2p/p2p_shares_controller.ts`
- `smanga-adonis/app/controllers/p2p/p2p_peers_controller.ts`
- `smanga-adonis/app/controllers/p2p/p2p_groups_controller.ts`

具体动作：

1. 定义 share announce payload DTO。
2. 定义 tracker manifest row DTO。
3. 定义 peer cache row DTO。
4. 修复 `p2p_groups_controller.ts` 中 `invalidateAndReregister()` 返回 boolean 却访问 `fresh.nodeId` 的问题。
5. 修复 `p2p_shares_controller.ts` 中 `{}` 推断导致的 `contentHash` 等字段错误。
6. 修复 `p2p_peers_controller.ts` 中隐式 any。

注意：当前项目全量 `npm run typecheck` 已经有许多非 P2P 错误。本阶段目标至少是不新增 P2P 错误，并尽量清掉 P2P 相关错误；全量 typecheck 变绿可以单独拆任务。

### 验收标准

1. tracker sync 失败能在管理端或数据库日志中看到具体 peer 和原因。
2. peer auth 的 soft allow 行为可配置、可审计。
3. P2P 相关 TS 错误清零或明确登记剩余项。
4. `npm run test` 中新增的 P2P 测试通过。

## 回归测试矩阵

| 场景 | 验收动作 | 期望 |
| --- | --- | --- |
| 单 tracker 拉取 chapter | peer 拉取一个章节 | transfer completed，文件落库 |
| 单 tracker 拉取 manga | peer 拉取含多个章节的漫画 | 所有 chapter task 终态，父 transfer completed |
| 单 tracker 拉取 media | peer 拉取含多个 manga 的媒体 | 所有 manga/chapter task 终态，父 transfer completed |
| 子任务失败 | 人为让一个 chapter 下载失败 | transfer failed，错误可见 |
| Adonis 重启 | 拉取中重启服务 | recovery 后状态可归档，不永久 running |
| 两 tracker announce | node 只 announce 到 A | B sync 后有 share index 和 manifest |
| 两 tracker 拉取 | peer 只访问 B | 能找到 seed 并拉取 |
| 删除 share | S 删除分享后 sync | A/B 都不返回旧 manifest |
| node 状态同步 | S heartbeat 到 A，B 通过 sync 获得 | peer 页面显示合理状态和 last seen |
| tracker 不可达 | B 临时下线后恢复 | announce 部分成功，恢复后 sync 补齐 |
| 长下载 | chapter 下载超过 120 秒 | 不被默认 timeout kill，不被 stalled recovery 重置 |

## 发布顺序

推荐按兼容优先的顺序发布：

1. 先发布数据库 migration，新增表和字段，保持旧代码可运行。
2. 发布 queue lock 续租和 P2P timeout，这一步对旧 P2P 逻辑也有收益。
3. 发布 DB-backed transfer tracking，同时保留旧函数名。
4. 发布 tracker share/manifest sync API。
5. 发布 announce fan out 和 tracker peers 配置。
6. 发布 peer 状态展示修复和前端字段兼容。
7. 发布 auth、health、type cleanup。

每一步发布后都跑一次：

```bash
cd smanga-adonis
npm run test
npm run typecheck
```

说明：当前 `npm run typecheck` 已知全量失败，所以在 P2P 修复阶段需要比较修复前后的错误列表，确保没有新增 P2P 错误，并逐步清理 P2P 相关错误。

## 数据修复与回填

上线后需要处理已有数据：

1. 对所有本地 enabled share 重新执行 announce。
2. 对所有 tracker 执行一次 manual sync。
3. 清理孤儿 manifest：没有有效 share index 关联的 `tracker_share_manifest` 应删除或标记 deleted。
4. 扫描历史 `running` transfer：
   - 如果 queue job 已完成但 transfer 未完成，补跑 finalizer。
   - 如果 queue job 已失败或不存在，标记 transfer failed。
   - 如果任务仍可继续，重新 enqueue 缺失的 child task。

建议把这些动作做成一次性维护命令，例如：

- `node ace p2p:reannounce-shares`
- `node ace p2p:sync-trackers --full`
- `node ace p2p:repair-transfers`
- `node ace p2p:cleanup-orphan-manifests --dry-run`

先支持 `--dry-run`，确认影响范围后再执行真实修复。

## 风险与注意事项

1. share/manifest sync 引入后，要避免两个 tracker 互相同步时无限放大数据。merge 必须有唯一键和版本判断。
2. tombstone 需要保留足够长时间，否则离线很久的 tracker 恢复后可能把已删除资源重新同步回来。
3. queue lock 续租必须绑定 worker id，否则旧 worker 可能续租已经被新 worker 接管的 job。
4. P2P timeout 拉长后，需要确保下载过程有进度日志，否则真实卡死任务会更晚暴露。
5. 在线状态不要只用 `online = 1/0` 解释所有场景，至少要保留状态来源和 last seen，避免 peer 页面继续误导用户。

## 最小可交付版本

如果需要先快速止血，最小版本建议只做下面 4 件事：

1. 把 `pull_child_tracker.ts` 改成数据库持久化计数。
2. 给 P2P download job 设置长 timeout，并给 SQL queue running job 续租。
3. `announce_group` 改为 fan out 到所有 tracker。
4. tracker sync 增加 share index 和 manifest 同步。

这 4 件完成后，拉取任务和多 tracker 资源一致性会先稳定下来。节点状态展示、auth 策略和可观测性可以随后继续完善。
