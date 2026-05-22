# 项目资源占用优化方案

## 1. 背景

当前容器主要包含：

- `svc-adonis`：Adonis 后端，监听 9798。
- `svc-express`：Express 静态服务和 `/api` 反代，监听 9797。
- `svc-redis`：Redis，供 Bull 队列使用。

当前观察：

- Redis 空载约 18 MB，移除 Redis 本身节省有限。
- 一个额外 Node worker 空闲可能增加约 100-200 MB。
- 当前容器空载约 219 MB，说明再新增多个 Node 进程会比较敏感。

优化目标：

- 去掉不必要的常驻进程。
- 保持跨平台和 Electron/Windows exe 打包能力。
- 保持部署简单，不引入 Nginx。
- 为后续 SQL 队列 external worker 留出内存空间。

## 2. 总体结论

建议最终结构：

```txt
svc-adonis
  监听 9797
  提供前端静态文件
  提供 /api 后端接口

svc-queue-background
  external 模式下启用
  处理 scan/sync/p2p/default

svc-queue-compress
  external 模式下启用
  处理 compress
```

移除：

```txt
svc-express
svc-redis
```

如果用户选择低内存模式：

```txt
只运行 svc-adonis
queue.worker.mode = embedded
background/compress 在同一 Node 进程内用两个 loop 执行
```

## 3. Web 服务方案对比

### 3.1 Adonis 直接托管前端

结构：

```txt
Adonis 9797
  /api/*       后端 API
  /assets/*    Vue 构建产物
  /*           SPA fallback 到 index.html
```

优点：

- 删除 `svc-express`，少一个 Node 进程。
- 不引入 Nginx。
- 端口更简单，只保留 9797。
- Electron/Windows 场景也更统一。

缺点：

- 静态文件请求进入 Adonis 进程，极限吞吐不如 Nginx。
- 需要处理 `/api` 前缀和 SPA fallback。

适合本项目。smanga 的瓶颈更可能在图片读取、压缩、扫描、数据库、P2P，而不是 Vue 静态文件吞吐。

### 3.2 Nginx 托管前端

结构：

```txt
Nginx 9797
  静态文件直接返回
  /api 反代到 Adonis
```

优点：

- 静态文件性能最好。
- 空闲内存很低，常见 5-20 MB。
- TLS、gzip、缓存、反代能力强。

缺点：

- 多一个服务和配置层。
- Electron/Windows 打包复杂度上升。
- 与当前“少依赖”目标不一致。

本次不采用。

### 3.3 保留 Express 静态服务

当前方案：

```txt
Express 9797
  /api -> Adonis 9798
  / -> Vue 静态文件
```

优点：

- 已经可用。
- 行为简单。

缺点：

- 多一个 Node 进程。
- 静态服务本身不如 Nginx 高效。
- 既没有 Nginx 的性能优势，也有 Node 进程的内存成本。

建议移除。

## 4. Adonis 静态托管改造

### 4.1 添加官方静态中间件

参考官方文档：

- https://docs.adonisjs.com/guides/basics/static-file-server

建议使用官方包：

```bash
npm install @adonisjs/static
```

或使用：

```bash
node ace add @adonisjs/static
```

需要产生或手动修改：

- `smanga-adonis/config/static.ts`
- `smanga-adonis/adonisrc.ts`
- `smanga-adonis/start/kernel.ts`

`adonisrc.ts` 增加 provider：

```ts
() => import('@adonisjs/static/static_provider')
```

`start/kernel.ts` 的 `server.use` 增加静态中间件，位置应靠前：

```ts
server.use([
  () => import('@adonisjs/static/static_middleware'),
  () => import('#middleware/container_bindings_middleware'),
  () => import('#middleware/force_json_response_middleware'),
  () => import('@adonisjs/cors/cors_middleware'),
])
```

注意：静态文件中间件应先尝试匹配真实文件，找不到再进入 API 路由或 SPA fallback。

### 4.2 前端构建产物位置

当前 Docker 构建：

- `smanga/dist/docker` 复制到 `/app/smanga-website`
- Express 读取 `/app/smanga-website`

改造后：

- 将 `smanga/dist/docker` 复制到 `/app/adonis/public`
- Adonis 静态中间件直接服务 `/app/adonis/public`

Dockerfile 修改方向：

```dockerfile
COPY --from=frontend-builder /smanga/dist/docker /app/adonis/public
```

删除：

```dockerfile
COPY --from=prepare /smanga-express /app/express
```

删除 runtime 中：

```dockerfile
cd /app/express && npm ci
```

### 4.3 API 前缀

当前外部访问方式是：

```txt
http://host:9797/api/xxx
```

Express 把 `/api/xxx` 反代到 Adonis 的 `/xxx`。

Adonis 直接监听 9797 后，必须继续支持 `/api/xxx`，否则前端 `VITE_APP_PATH=/api` 会失效。

建议将后端 API 路由整体挂到 `/api`：

```ts
router.group(() => {
  // 原 start/routes.ts 中的后端 API 路由
}).prefix('/api')
```

需要注意：

- SPA 页面路由不应进入 API group。
- `/api/*` 不存在时应返回 JSON 404，而不是 `index.html`。
- OPDS、P2P 对外地址当前也是经 `/api` 暴露，迁移后应保持 `/api/opds`、`/api/p2p/...`。

### 4.4 中间件中的 request.url 判断

部分中间件当前基于旧内部路径判断：

- `smanga-adonis/app/middleware/auth_middleware.ts`
- `smanga-adonis/app/middleware/tracker_auth_middleware.ts`
- `smanga-adonis/app/middleware/p2p_peer_auth_middleware.ts`

当前可能判断：

```ts
request.url().startsWith('/opds')
request.url().startsWith('/p2p/serve')
```

改成 `/api` 前缀后，需要统一封装：

```ts
function normalizeApiPath(url: string) {
  return url.startsWith('/api/') ? url.slice(4) : url
}
```

然后判断 normalized path：

```ts
const path = normalizeApiPath(request.url())
if (path.startsWith('/opds')) ...
```

这样可以兼容未来内部测试直接访问无 `/api` 前缀的情况。

### 4.5 SPA fallback

需要新增一个 fallback，让 Vue history 路由刷新时返回 `index.html`。

原则：

- 只处理 `GET`。
- 不处理 `/api/*`。
- 不处理真实静态文件，真实文件由 static middleware 先返回。
- 最好只在 Accept 包含 `text/html` 时返回。

可以在 `start/routes.ts` 最后添加：

```ts
router.get('*', async ({ request, response }) => {
  if (request.url().startsWith('/api')) {
    return response.status(404).json({ code: 404, message: 'not found' })
  }

  return response.download(app.publicPath('index.html'))
})
```

实际代码需 import Adonis app service：

```ts
import app from '@adonisjs/core/services/app'
```

## 5. 端口调整

最终建议：

- Adonis 直接监听 `9797`。
- 放弃容器内 `9798`。
- 前端静态和 API 都走 9797。

修改位置：

- `smanga-adonis/.env` 示例和 Docker 初始化脚本中的 `PORT`
- `smanga/docker/etc/s6-overlay/s6-rc.d/init-config/run`
- Dockerfile `EXPOSE`
- docker-compose 示例中的端口映射
- 文档中所有 `9798` 或 `BACKEND_PORT` 说明

保留外部访问：

```txt
http://host:9797/
http://host:9797/api
```

P2P publicUrl 示例仍建议：

```txt
http://host:9797/api
```

## 6. 移除 Express 服务

删除或不再注册：

- `smanga/docker/etc/s6-overlay/s6-rc.d/svc-express`
- `smanga/docker/etc/s6-overlay/s6-rc.d/user/contents.d/svc-express`

Dockerfile 删除：

- `COPY smanga-express /smanga-express`
- `COPY --from=prepare /smanga-express /app/express`
- `/app/express npm ci`

构建脚本中可以保留 `smanga-express` 仓库更新一段时间，也可以后续删除。

`smanga-express` 项目本身可以暂时保留，不影响运行。

## 7. 移除 Lucid

当前项目主要使用 Prisma，Lucid 没有实际使用价值。

修改：

### 7.1 package.json

文件：

- `smanga-adonis/package.json`

删除 dependencies：

```json
"@adonisjs/lucid": "^21.1.0"
```

如果确认不需要 Lucid CLI，也删除 adonisrc commands 中：

```ts
() => import('@adonisjs/lucid/commands')
```

### 7.2 adonisrc.ts

文件：

- `smanga-adonis/adonisrc.ts`

删除 provider：

```ts
() => import('@adonisjs/lucid/database_provider')
```

删除 commands：

```ts
() => import('@adonisjs/lucid/commands')
```

### 7.3 config/database.ts

文件：

- `smanga-adonis/config/database.ts`

如果只供 Lucid 使用，删除该文件或保留但不加载。

### 7.4 app/models/user.ts

文件：

- `smanga-adonis/app/models/user.ts`

这是 Lucid model。如果没有任何引用，删除。

### 7.5 验证

执行：

```bash
npm install
npm run build
npm run typecheck
```

并搜索确认无引用：

```bash
rg "@adonisjs/lucid|BaseModel|database_provider|lucid"
```

## 8. 队列 worker 的资源策略

配合 SQL 队列，提供两种模式：

### 8.1 低内存模式

```json
{
  "queue": {
    "worker": {
      "mode": "embedded"
    }
  }
}
```

特点：

- 不新增 Node 进程。
- 不使用 Redis。
- `background` 和 `compress` 是同一进程内的两个 loop。
- 扫描不会堵住 compress。
- 重任务仍可能影响 Web 进程响应。

### 8.2 平衡模式

```json
{
  "queue": {
    "worker": {
      "mode": "external"
    }
  }
}
```

特点：

- 新增两个 Node worker 进程。
- Web 与任务执行隔离。
- 空闲内存增加明显。
- 适合 NAS、服务器、长期开启 P2P/扫描的用户。

### 8.3 worker 入口要轻量

建议使用：

```bash
nodejs bin/queue_worker.js --worker=background
nodejs bin/queue_worker.js --worker=compress
```

不要优先使用完整：

```bash
node ace queue:work
```

原因：

- worker 不需要 HTTP server、routes、middleware。
- 轻量入口可以减少启动加载和空闲 RSS。

## 9. 依赖清理顺序

建议分阶段执行，不要一次性删除太多。

### 阶段 1：移除 Lucid

风险低，收益中等。

### 阶段 2：Adonis 托管前端，移除 Express 服务

收益明显，能少一个 Node 进程。

### 阶段 3：SQL 队列 embedded 模式

先验证功能，不新增 worker 进程。

### 阶段 4：SQL 队列 external 模式

新增 `background` 和 `compress` 两个 s6 worker。

### 阶段 5：移除 Redis/Bull

确认 SQL 队列稳定后：

- 删除 Redis s6 服务。
- 删除 apk redis。
- 删除 Bull/Redis npm 依赖。

## 10. 资源影响预估

粗略估算：

| 改动 | 空闲内存变化 |
| --- | --- |
| 移除 Redis | 约 -18 MB |
| 移除 Express 静态服务 | 约 -40 到 -80 MB |
| 移除 Lucid | 约 -数 MB 到十几 MB |
| Adonis 增加静态托管 | 约 +很小 |
| SQL queue embedded | 约 +较小 |
| 新增一个 Node worker | 约 +100 到 +200 MB |
| 新增两个 Node worker | 约 +200 到 +400 MB |

可能结果：

### embedded 模式

```txt
移除 Redis + Express + Lucid
新增 SQL 队列内嵌 loop
空闲内存可能低于当前 219 MB 或接近当前水平
```

### external 模式

```txt
移除 Redis + Express + Lucid
新增两个 queue worker
空闲内存大概率高于当前，但比“Express + Redis + 多个 Laravel 式 worker”更可控
```

## 11. 测量方法

容器外：

```bash
docker stats <container>
```

容器内：

```bash
ps -eo pid,ppid,rss,comm,args --sort=-rss
```

按 MB 查看：

```bash
ps -eo pid,rss,comm,args --sort=-rss | awk '{printf "%s %.1fMB %s %s\n", $1, $2/1024, $3, $4}'
```

建议每个阶段记录：

- 容器刚启动 1 分钟后。
- 空闲 10 分钟后。
- 扫描中。
- compress 任务执行中。
- P2P 下载中。

记录格式：

```txt
版本/阶段:
配置:
容器总内存:
svc-adonis RSS:
svc-queue-background RSS:
svc-queue-compress RSS:
备注:
```

## 12. 验证清单

Adonis 静态托管：

- `GET /` 返回前端首页。
- `GET /assets/*.js` 返回 JS 且 MIME 正确。
- 刷新 Vue 页面路由不会 404。
- `GET /api` 或 API 子路径仍返回 JSON。
- 不存在的 `/api/*` 不返回 `index.html`。
- 图片接口、上传接口、OPDS、P2P serve 接口正常。

端口：

- 容器只暴露 9797。
- 前端 `VITE_APP_PATH=/api` 不变。
- P2P publicUrl 示例更新为 `host:9797/api`。

依赖：

- `rg "@adonisjs/lucid"` 无运行时代码引用。
- `rg "bull|redis"` 在 SQL 队列稳定后无运行时代码引用。

资源：

- 移除 Express 后，进程列表中不再有 `/app/express/index.js`。
- 移除 Redis 后，进程列表中不再有 `redis-server`。
- embedded 模式下，没有 queue worker 独立 Node 进程。
- external 模式下，只有两个 queue worker 独立 Node 进程。

## 13. 建议最终默认值

面向普通用户和低配设备：

```json
{
  "queue": {
    "worker": {
      "mode": "embedded"
    }
  }
}
```

面向服务器/NAS/重度用户：

```json
{
  "queue": {
    "worker": {
      "mode": "external"
    }
  }
}
```

Web 服务默认：

```txt
Adonis 监听 9797
不启动 Express
不启动 Nginx
```

