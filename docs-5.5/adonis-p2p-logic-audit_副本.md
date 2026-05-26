# Adonis P2P 逻辑排查报告

日期：2026-05-26

范围：`smanga-adonis` 的 P2P 后端逻辑、tracker 同步逻辑、SQL 队列执行逻辑，以及 `smanga` 前端 peer 展示相关逻辑。

## 总体结论

当前 P2P 不稳定不是单点问题，而是几条关键链路同时断裂：

1. 拉取任务的父子任务完成计数放在进程内存中，但 SQL 队列每个任务都会 fork 子进程执行，父任务退出后计数状态直接丢失，导致 transfer 很容易卡在 `running`。
2. 多 tracker 场景下，节点资源只会 announce 到第一个可用 tracker；tracker 之间的同步又只同步节点、分组、成员、peer，不同步 share index 和 manifest，所以资源数据天然无法在 tracker 间传播。
3. 节点在线状态的同步语义不完整。通过 tracker 同步学到的节点会被标记为离线，peer 端缓存展示又没有把 manifest 与 peer cache 关联起来，导致 peer 页面上的节点状态、名称、last seen 不稳定或不正确。
4. 队列默认 timeout 和 stalled lock 都很短，不适合 P2P 下载任务。长下载可能被超时 kill，或者运行中被判定为 stalled 后重复执行。

这些问题足以解释目前观察到的现象：tracker 直接相互同步有问题、peer 端节点状态展示异常、拉取任务无法正常运行、seed/manifest 在不同 tracker 上不一致。

## 优先级问题清单

| 优先级 | 问题 | 影响 |
| --- | --- | --- |
| P0 | P2P pull 父子任务状态使用进程内 Map，和 fork 子进程队列模型冲突 | transfer 卡住、任务无法完成、失败无法正确汇总 |
| P0 | share/manifest 没有在 tracker 间同步，announce 也只发给第一个 tracker | 多 tracker 数据不一致，peer 找不到资源或 seed |
| P1 | 节点在线状态同步与 peer 展示字段不一致 | peer 页面显示离线、未知节点、last seen 异常 |
| P1 | P2P 下载任务使用默认短 timeout，SQL queue lock 不续租 | 长任务被 kill、重复执行、状态错乱 |
| P1 | tracker peer URL 复用 node trackers 配置 | tracker-only 部署容易没有同步目标 |
| P2 | 删除/禁用 share 后 tracker manifest 可能残留 | UI 看到 stale 资源，拉取 stale manifest |
| P2 | P2P peer auth 在 tracker 不可用时 soft allow，timestamp 可缺失 | 安全边界和行为一致性风险 |
| P2 | P2P 相关 TypeScript 错误长期存在 | 类型保护不足，隐藏运行时错误 |

## P0：拉取任务父子状态必然丢失

### 现象

拉取媒体、漫画、章节时，父任务会拆出子任务，并通过 `pull_child_tracker.ts` 的模块级内存 Map 统计子任务完成情况。问题是当前 SQL 队列执行任务时会 fork 新进程，子进程完成一个 job 后直接退出。

也就是说：

1. 父任务在自己的子进程里 `initTracker()`。
2. 父任务 enqueue 子任务后退出。
3. 父任务所在进程退出，内存 Map 被销毁。
4. 后续子任务在新的进程里执行 `notifyDone()`，此时 registry 是空的。
5. transfer 状态不会被汇总更新，容易一直停在 `running`。

### 代码证据

- `smanga-adonis/app/services/p2p/pull/pull_child_tracker.ts`
  - 模块级 `registry = new Map<number, TrackerEntry>()`。
  - 文件注释也写明状态在内存中，重启会丢失。
  - `notifyDone()` 在找不到 entry 时只记录 warning 并返回。
- `smanga-adonis/app/services/queue/sql_queue_worker_service.ts`
  - `runJobInChildProcess()` 使用 `fork()` 启动 `bin/queue_child_worker.js`。
- `smanga-adonis/bin/queue_child_worker.ts`
  - 注释说明 forked child process 执行单个 job，执行完成后 `process.exit()`。
- `smanga-adonis/app/services/p2p/pull/pull_media_sub_job.ts`
  - 父媒体任务 `initTracker(transferId, mangas.length, 0)` 后 enqueue 漫画子任务并返回。
- `smanga-adonis/app/services/p2p/pull/pull_manga_sub_job.ts`
  - 父漫画任务 `initTracker()`、`transferSelfToChildren()` 后 enqueue meta/chapter 子任务。
- `smanga-adonis/app/services/p2p/pull/pull_chapter_sub_job.ts`
  - 子章节任务完成后调用 `notifyDone()`。
- `smanga-adonis/app/services/p2p/pull/pull_meta_sub_job.ts`
  - meta 子任务完成后调用 `notifyDone()`。

### 修复建议

优先把 child tracking 持久化到数据库，不要依赖进程内 Map。可选实现：

1. 在 `p2p_transfer` 增加 `expected_children`、`done_children`、`failed_children`、`canceled_children`、`state_version`、`last_child_error` 等字段，或新增 `p2p_transfer_children` 表。
2. 子任务完成时用数据库事务原子递增计数。
3. 当完成数达到 expected 时，在同一个事务或独立 finalizer 中把 transfer 改为 `completed` / `failed` / `canceled`。
4. 增加恢复任务，扫描长时间 `running` 的 transfer，根据 queue job 状态重建最终状态。

如果暂时不改数据库，也可以把媒体/漫画 orchestration 保持在单个长生命周期 job 内等待所有子步骤完成，但这和当前 SQL queue 的 fork 模型不匹配，后续可恢复性也较差。

## P0：多 tracker share/manifest 不同步

### 现象

节点 announce 分组资源时，代码注释说会广播到所有可达 tracker，但实际成功一个 tracker 后立刻 `break`。同时 tracker-to-tracker sync 只同步节点、分组、成员和 peers，不同步 share index 与 manifest。

因此，多 tracker 拓扑下会出现：

1. 节点把资源 announce 到 tracker A。
2. tracker B 通过 sync 知道了 group 和 member。
3. tracker B 不知道这个 group 里的 share index / manifest。
4. peer 端如果读到 tracker B，就会看到空资源、找不到 seed 或拉取失败。

### 代码证据

- `smanga-adonis/app/controllers/p2p/p2p_shares_controller.ts`
  - `announce_group` 中注释写的是 broadcast to all reachable trackers。
  - 实际循环 tracker clients 时，第一个成功后 `break`。
- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`
  - `syncFromPeer()` 只调用 `syncGroups()`、`syncNodes()`、`syncGroupMembers()`、`syncPeers()`。
  - `mergeNodes()`、`mergeGroups()`、`mergeGroupMembers()` 都没有处理 `tracker_share_index` 或 `tracker_share_manifest`。
- `smanga-adonis/app/controllers/tracker/tracker_sync_controller.ts`
  - 只提供 groups、nodes、peers、group members 同步接口。
- `smanga-adonis/start/routes.ts`
  - `/tracker/sync/groups`
  - `/tracker/sync/nodes`
  - `/tracker/sync/peers`
  - `/tracker/sync/group/:groupNo/members`
  - 没有 shares / manifests 同步路由。
- `smanga-adonis/app/services/tracker/tracker_share_service.ts`
  - `findSeeds()` 依赖 `tracker_share_index`。
  - manifest 存在 `tracker_share_manifest`。

### 修复建议

1. `announce_group` 不应该第一个成功后退出。应该尝试所有可达 tracker，并汇总成功、失败结果。
2. tracker sync 增加资源数据同步：
   - `/tracker/sync/group/:groupNo/shares`
   - `/tracker/sync/group/:groupNo/manifests`
   - 或全局分页接口，按 `updated_at` 增量同步。
3. merge 逻辑需要明确唯一键和冲突策略。建议以 `(tracker_group_id, node_id, share_type, remote_media_id, remote_manga_id)` 作为 share index 维度，以 `(tracker_group_id, owner_node_id, media_id, manga_id, chapter_id, file_path)` 或当前业务已有 content hash 作为 manifest 维度。
4. 删除、禁用资源时需要 tombstone 或 full-cover cleanup，否则其他 tracker 会保留旧 manifest。
5. 同步响应里返回 sync version / timestamp，方便排查 tracker 间数据延迟。

## P1：节点在线状态和 peer 展示不一致

### 现象

通过 tracker sync 学到的节点不会继承对端 tracker 的在线状态。代码会把新增节点写为 `online: 0`、`lastHeartbeat: null`。如果节点只 heartbeat 到 tracker A，tracker B 通过同步知道这个节点后，仍会显示它离线。

peer 端还有一个展示问题：本地 manifest cache 读取时强行返回 `nodeName: null`、`online: 0`，没有关联 `p2p_peer_cache`，所以即使 peer cache 里有节点状态，share 页面也可能显示未知或离线。

### 代码证据

- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`
  - `mergeNodes()` 对已有 node 直接跳过。
  - 新增 node 时写入 `online: 0`、`lastHeartbeat: null`。
  - `mergeGroupMembers()` 创建 placeholder node 时同样写入离线状态。
- `smanga-adonis/app/services/tracker/tracker_group_service.ts`
  - `listMembers()` 返回本地 tracker 的 `node.online` 和 `node.lastHeartbeat`。
- `smanga-adonis/app/controllers/p2p/p2p_peers_controller.ts`
  - `members()` 把 tracker member 缓存到 `p2p_peer_cache`，字段名为 `lastSeen`。
  - `_readLocalManifests()` 读本地 manifest cache 时写死 `nodeName: null`、`online: 0`。
  - `manifests()` 即使传 `sync=0`，只要有 tracker clients 仍会请求 tracker；`sync=0` 只是禁止写本地 cache，并不等于只读本地缓存。
- `smanga/src/views/p2p-peers/index.vue`
  - members 表读的是 `lastHeartbeat`。
  - cache 语义文案说 `fromTracker=false` 时只读取本地缓存，但后端实际不是这个行为。

### 修复建议

1. 明确在线状态语义：
   - `direct_online`：本 tracker 直接收到 heartbeat。
   - `synced_online`：从其他 tracker 同步来的状态。
   - `last_seen_at`：最终展示用的最新可证明时间。
2. 如果继续只用一个 `online` 字段，tracker sync 时至少要按 freshness 更新 `online`、`lastHeartbeat`、`publicUrl`，不要对已有节点直接跳过。
3. `_readLocalManifests()` 应关联 `p2p_peer_cache`，返回 `nodeName`、`online`、`lastSeen`。
4. 后端要么把 cache 数据统一转换为 `lastHeartbeat`，要么前端同时兼容 `lastSeen`。
5. `sync=0` 需要实现真正的 local-only path，或把接口参数改名，避免 UI 语义误导。

## P1：队列 timeout 和 stalled lock 不适合 P2P 下载

### 现象

当前 queue 默认 timeout 是 120 秒，stalled 判断默认 60 秒。P2P 下载漫画、媒体、章节很容易超过这个时间。更严重的是，SQL queue claim job 时只设置一次 `locked_until`，worker 心跳没有续租当前 job 的 lock。

结果：

1. 下载超过 120 秒会被 child process timeout kill。
2. 下载超过 60 秒可能被 recover 逻辑认为 stalled，重新置为 pending 或 failed。
3. 原 child process 可能还在跑，造成重复下载、重复写库、transfer 状态错乱。
4. 如果 child 被 SIGTERM，P2P 子任务的 `notifyDone()` / 状态更新很可能不会执行。

### 代码证据

- `smanga-adonis/start/init.ts`
  - `queue.timeout` 默认 `120000`。
  - `queue.stalledAfterMs` 默认 `60000`。
- `smanga-adonis/app/services/queue/queue_config.ts`
  - 同样给出 120 秒 timeout 和 60 秒 stalled 默认值。
- `smanga-adonis/app/services/queue_service.ts`
  - enqueue 时若未传 timeout，就使用默认 queue timeout。
- `smanga-adonis/app/controllers/p2p/p2p_transfers_controller.ts`
  - `taskP2PPull` enqueue 未设置 P2P 专用 timeout。
- `smanga-adonis/app/services/p2p/pull/p2p_pull_job.ts`
  - `taskP2PPullChapter`、`taskP2PPullManga`、`taskP2PPullMedia` enqueue 未设置 timeout。
- `smanga-adonis/app/services/p2p/pull/pull_media_sub_job.ts`
  - 媒体拆漫画子任务时未设置 timeout。
- `smanga-adonis/app/services/p2p/pull/pull_manga_sub_job.ts`
  - 漫画拆 meta/chapter 子任务时未设置 timeout。
- `smanga-adonis/app/repositories/sql_queue_repository.ts`
  - `claimNextJob()` 设置 `locked_until`。
  - `recoverStalledJobs()` 根据过期 `locked_until` 回收 running job。
  - 未看到运行中 job lock 的定期续租。

### 修复建议

1. 给 P2P 下载任务设置独立 timeout，按任务类型使用更长时间，例如章节 30 分钟、漫画数小时、媒体更长，或支持 `timeout = 0` 表示不按固定时长 kill。
2. SQL queue worker 在 child process 运行期间定期延长当前 job 的 `locked_until`。
3. stalled recovery 只回收 worker 已死亡且 lock 过期的 job，不要和正常长任务竞争。
4. timeout / SIGTERM 时必须把对应 `p2p_transfer` 标记为 `failed` 或 `canceled`，不能只让 queue job failed。

## P1：tracker 同步配置复用 node trackers，tracker-only 部署易失效

### 现象

tracker 同步目标来自 `cfg.node.trackers`，而不是 tracker 自己的 peers 配置。对于只承担 tracker 角色、不承担 node 角色的部署，`cfg.node.trackers` 很可能为空。

### 代码证据

- `smanga-adonis/app/services/tracker/tracker_sync_service.ts`
  - `getPeerTrackerUrls()` 从 `cfg.node.trackers` 读取 peer tracker URL。
- `smanga-adonis/start/init.ts`
  - 只有 `p2p.enable && role.node && !role.tracker` 时才自动补默认 trackers。
  - 只有 `role.tracker && tracker.syncKey` 时才启动 tracker sync service。

### 修复建议

1. 增加明确的 `p2p.tracker.peers` 或 `p2p.tracker.trackers` 配置。
2. tracker sync service 只读取 tracker peers，不复用 node trackers。
3. 启动时校验：开启 tracker sync 但 peer list 为空时，给出明确日志和管理端提示。
4. 统一 URL 规范，明确是否包含 `/api`，避免 tracker client 拼接路径不一致。

## P2：删除或禁用 share 后 manifest 可能残留

### 现象

full-cover announce 会清理旧 `tracker_share_index`，但没有同步清理对应 `tracker_share_manifest`。因此删除/禁用 share 后，manifest 接口仍可能返回旧资源。

### 代码证据

- `smanga-adonis/app/services/tracker/tracker_share_service.ts`
  - `announce()` full-cover cleanup 删除的是 `tracker_share_index`。
  - 未看到同步删除 `tracker_share_manifest` 的逻辑。
- `smanga-adonis/app/controllers/p2p/p2p_shares_controller.ts`
  - `destroy()` 删除本地 cache 后调用 `announce_group`，payload 不再包含被删 share。
  - tracker 侧 index 可被删除，但旧 manifest 可能留下。

### 修复建议

1. full-cover announce 时按 node/group 的当前资源集合清理 stale manifest。
2. 或引入 tombstone，让 delete/disable 明确传播到每个 tracker。
3. manifest 查询时也应关联有效 share index，避免孤儿 manifest 被展示或拉取。

## P2：P2P peer auth soft allow 与 timestamp 校验不完整

### 现象

peer serve 接口的鉴权依赖 tracker 校验 membership。但如果 tracker client 不存在或 tracker 请求失败，中间件会 soft allow。另一个细节是 timestamp 只有在存在时才检查时间窗口，缺失 timestamp 并不会拒绝。

### 代码证据

- `smanga-adonis/app/middleware/p2p_peer_auth_middleware.ts`
  - tracker 不可用时返回 `'soft'` 并允许继续。
  - timestamp 校验条件是 `if (timestamp && ...)`，缺失 timestamp 不会触发拒绝。

### 修复建议

1. 把 soft allow 做成配置项，默认策略按部署场景决定。
2. 如果设计要求签名请求必须带 timestamp，则缺失 timestamp 应直接拒绝。
3. tracker 不可用时记录可观测事件，方便排查访问异常和安全风险。

## TypeScript 检查结果

在 `smanga-adonis` 下执行 `npm run typecheck`，当前项目整体未通过。错误数量较多，包含许多非 P2P 的历史类型问题，因此不能把 typecheck 作为本次排查的唯一判断依据。

但其中 P2P 相关错误值得修复：

1. `app/controllers/p2p/p2p_groups_controller.ts`
   - `fresh.nodeId` 被访问，但 `invalidateAndReregister()` 返回的是 boolean。这里至少会导致日志错误，也说明该分支类型不可信。
2. `app/controllers/p2p/p2p_shares_controller.ts`
   - 多处 `contentHash`、manifest cache、media/manga map 被推断为 `{}` 或类型不匹配。announce payload 和 manifest cache 这一块类型保护不足，正好处在多 tracker 资源同步的关键链路。
3. `app/controllers/p2p/p2p_peers_controller.ts`
   - 存在隐式 any，peer manifest/cache 返回结构缺少严格约束。

建议在修复 P0/P1 时同步补齐 P2P DTO、manifest row、share index row、peer cache row 的类型定义，避免继续让关键字段靠运行时约定传递。

## 建议修复路线

### 第一阶段：先让拉取任务可完成

1. 移除或降级 `pull_child_tracker.ts` 的进程内状态角色。
2. 用数据库持久化 transfer child progress。
3. 给 P2P job 设置专用长 timeout。
4. 给 SQL queue running job 增加 lock heartbeat / lease renew。
5. 增加 transfer recovery finalizer，修复历史卡住的 `running` transfer。

### 第二阶段：修复多 tracker 数据面

1. `announce_group` 改为真正 fan out 到所有 tracker。
2. 增加 tracker share index / manifest sync API 和 merge 逻辑。
3. 处理 delete/disable 的 tombstone 或 full-cover stale cleanup。
4. 管理端展示每个 tracker 的最后同步时间、资源数量、错误原因。

### 第三阶段：修复节点状态语义和 peer 展示

1. 区分 direct heartbeat 与 synced status，或至少按 freshness 合并状态。
2. manifest cache 读取时关联 peer cache。
3. 统一 `lastHeartbeat` / `lastSeen` 字段。
4. 修正 `sync=0` 的语义，实现真正本地缓存读取。

### 第四阶段：补齐可观测性和类型约束

1. P2P pull、announce、tracker sync、peer auth 的失败写入数据库日志。
2. 增加 tracker sync health endpoint。
3. 修复 P2P 相关 TypeScript 错误。
4. 增加集成测试：
   - 两个 tracker、一个 node announce、另一个 peer 拉取。
   - 媒体拆分为多个 manga/chapter 子任务后 transfer 能完成。
   - tracker A heartbeat 在线，tracker B 同步后 peer 端状态展示一致。
   - 删除 share 后 manifest 不再展示。

## 结论

当前最需要优先处理的是两个 P0：

1. `pull_child_tracker.ts` 的进程内计数和 fork 队列模型冲突。
2. 多 tracker 之间不传播 share index / manifest。

只修 UI 或只调 tracker sync 周期无法解决根因。建议先把拉取任务状态持久化、再把 tracker 资源数据同步补齐，随后统一在线状态语义和 peer cache 展示。这样才能让 P2P 从“偶尔能跑”变成“可恢复、可观测、可排查”的稳定链路。
