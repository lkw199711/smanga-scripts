# smanga 初始化页面重构方案

## 一、目标

构建全新的初始化页面，让用户在首次部署时：
1. 选择并配置数据库（SQLite / MySQL / PostgreSQL）
2. 创建管理员账户
3. 取代 `start/init.ts` 中硬编码的 `smanga` 默认用户

---

## 二、核心架构决策：双模式启动

### 2.1 问题分析

Prisma 的工作方式不允许运行时热切换数据库：

```
服务启动前必须：
  npx prisma generate          → 生成客户端代码到 node_modules/.prisma/
  npx prisma migrate deploy    → DDL 建表

服务启动时：
  start/prisma.ts              → 创建 PrismaClient 单例（全局复用）

运行时无法重建 PrismaClient，因为：
  - prisma generate 修改了 node_modules 目录
  - PrismaClient 已是模块级单例
  - 执行中的 Node 进程不能“重来一遍”
```

### 2.2 解决方案

利用已有的 `smanga.json` 中 `sql.deploy` 标志位，实现双模式启动：

```
deploy=false → 初始化模式
  kernel.ts
  → create_dir_win/linux()       创建目录 + 写入默认 smanga.json
  → check_config_ver()           配置文件版本升级
  → 启动 HTTP 服务              不加载 PrismaClient
     → 只暴露 /init 相关路由
     → 用户访问 → 看到初始化页面

deploy=true → 正常模式（现有行为）
  kernel.ts
  → database_check()            仅Windows执行 prisma generate + migrate
  → init()                      完整初始化（Prisma、默认用户、cron等）
```

**关键点**：AdonisJS 路由使用 `() => import('#controllers/xxx')` 懒加载，HTTP 服务启动本身不 import prisma。只要 `kernel.ts` 不 import `init.ts`，就不会加载 PrismaClient。

### 2.3 初始化流程

```
用户访问初始化页面
  → 选择数据库类型（SQLite / MySQL / PostgreSQL）
  → SQLite: 跳过连接字段，直接到下一步
  → MySQL/PG: 填写 host/port/user/password/database
  → 填写管理员用户名和密码
  → 提交

后端处理：
  1. 接收并验证表单数据
  2. 写入 smanga.json（sql 段 + deploy=false）
  3. 根据 client 类型写入 .env 对应变量
  4. 执行 npx prisma generate --schema=./prisma/<client>/schema.prisma
  5. 执行 npx prisma migrate deploy --schema=./prisma/<client>/schema.prisma
  6. 动态创建 PrismaClient 连接目标库
  7. 用表单提供的用户名密码创建 admin 用户
  8. 设 smanga.json sql.deploy = true
  9. 返回成功
  10. process.exit(0) → Docker s6-overlay 自动重启 / 裸机用户手动重启
```

---

## 三、后端改动清单

### 3.1 `start/kernel.ts`

**位置**：`smaanga-adonis/start/kernel.ts`

在顶层 await 区域加入 deploy 判断逻辑：

```ts
// === 现有 imports ===
import database_check from '../app/services/database_check_service.js'
import init from './init.js'
import { get_os, get_config } from '#utils/index'

const os = get_os()
const config = get_config()

if (!config.sql?.deploy) {
  // ========== 初始化模式 ==========
  // 只创建目录、检查配置版本，不加载 Prisma
  await init_dirs_only()
  // HTTP 服务启动，路由中只有 /deploy/init 等无鉴权接口可用
  // 没有 import init.ts，不会触发 PrismaClient 创建
} else {
  // ========== 正常模式 ==========
  if (os === 'Windows') {
    await database_check()
  }
  await init()
}
```

### 3.2 `start/init.ts`

**改动**：将目录创建和配置检查从 `boot()` 中拆出，导出为独立函数 `init_dirs_only()`。移除硬编码用户创建逻辑。

```ts
// 新增导出：仅做目录/配置初始化，不碰 Prisma
export async function init_dirs_only() {
  const os = get_os()
  if (['Windows', 'MacOS'].includes(os)) {
    await create_dir_win()
  } else {
    await create_dir_linux()
  }
  await check_config_ver()
}

// boot() 中删除以下代码块：
//   // 创建系统默认用户
//   const users = await prisma.user.findMany()
//   if (!users?.length) {
//     await prisma.user.create({ ... })
//   }
```

**注意**：`get_os()` 需要在 `app/utils/index.ts` 中增加 `darwin` 判断以正确返回 `'MacOS'`。

### 3.3 `app/utils/index.ts`

```ts
export function get_os() {
  const platform = os.platform()
  if (platform === 'win32')  return 'Windows'
  if (platform === 'darwin') return 'MacOS'
  if (platform === 'linux')  return 'Linux'
  return 'Other'
}
```

### 3.4 `app/controllers/deploys_controller.ts`

**新增方法**：无鉴权的初始化接口

```ts
/**
 * 首次部署初始化（无鉴权，仅在 deploy=false 时可用）
 * POST /api/deploy/init
 * Body: {
 *   client: 'sqlite' | 'mysql' | 'postgresql',
 *   host?: string,
 *   port?: number,
 *   username?: string,
 *   password?: string,
 *   database?: string,
 *   adminUser: string,
 *   adminPass: string
 * }
 */
public async init({ request, response }: HttpContext) {
  const config = get_config()
  
  // 防御：已经初始化过了
  if (config.sql?.deploy) {
    return response.status(400).json({ 
      code: 400, message: '系统已完成初始化，此接口不可用' 
    })
  }

  const { client, host, port, username, password, database, adminUser, adminPass } 
    = request.body()

  // 1. 校验参数
  if (!['sqlite', 'mysql', 'postgresql', 'pgsql'].includes(client)) {
    return response.status(400).json({ code: 400, message: '不支持的数据库类型' })
  }
  if (!adminUser || !adminPass) {
    return response.status(400).json({ code: 400, message: '管理员用户名和密码不能为空' })
  }

  // 2. 写入 smanga.json
  config.sql = { client, host, port, username, password, database, deploy: false }
  await fs.promises.writeFile(configFile, JSON.stringify(config, null, 2))

  // 3. 写入 .env
  let dbUrl: string, varName: string, schemaPath: string
  if (client === 'sqlite') {
    const os = get_os()
    dbUrl = (os === 'Windows' || os === 'MacOS') 
      ? `file:${path.join(rootDir, 'data', 'db', 'smanga.db')}`
      : 'file:/data/db/smanga.db'
    varName = 'DB_URL_SQLITE'
    schemaPath = path.join(rootDir, 'prisma', 'sqlite', 'schema.prisma')
  } else if (client === 'mysql') {
    dbUrl = `mysql://${username}:${password}@${host}:${port}/${database}`
    varName = 'DB_URL_MYSQL'
    schemaPath = path.join(rootDir, 'prisma', 'mysql', 'schema.prisma')
  } else { // postgresql / pgsql
    dbUrl = `postgresql://${username}:${password}@${host}:${port}/${database}`
    varName = 'DB_URL_POSTGRESQL'
    schemaPath = path.join(rootDir, 'prisma', 'pgsql', 'schema.prisma')
  }

  let envContent = fs.readFileSync(ENV_FILE, 'utf8')
  const regex = new RegExp(`^${varName}=.*`, 'm')
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, `${varName}=${dbUrl}`)
  } else {
    envContent += `\n${varName}=${dbUrl}`
  }
  fs.writeFileSync(ENV_FILE, envContent, 'utf8')

  // 4. 执行 Prisma 命令
  await runNpxCommand('npx prisma generate --schema=' + schemaPath)
  await runNpxCommand('npx prisma migrate deploy --schema=' + schemaPath)

  // 5. 创建 admin 用户
  const { PrismaClient } = require('@prisma/client')
  const initPrisma = new PrismaClient({ datasources: { db: { url: dbUrl } } })
  
  const md5 = (str: string) => crypto.createHash('md5').update(str).digest('hex')
  
  await initPrisma.user.create({
    data: {
      userName: adminUser,
      passWord: md5(adminPass),
      role: 'admin',
      mediaPermit: 'all',
    },
  })
  await initPrisma.$disconnect()

  // 6. 标记完成
  config.sql.deploy = true
  await fs.promises.writeFile(configFile, JSON.stringify(config, null, 2))

  // 7. 返回成功
  return response.json({ 
    code: 200, 
    message: '初始化完成，服务即将重启', 
    data: true 
  })

  // 8. 延迟退出，确保响应已发送
  setTimeout(() => process.exit(0), 1000)
}
```

### 3.5 `start/routes.ts`

新增路由（在 `/deploy/` 区域）：

```ts
// 部署-初始化（无鉴权）
router.post('/deploy/init', [DeploysController, 'init'])
```

**注意**：`/deploy` 已在 `auth_middleware.ts` 的 `skipRoutes` 中，自动跳过 token 校验。

---

## 四、前端改动清单

### 4.1 新建 `src/themes/theme-a/pages/init.vue`

遵循 Theme A（皮肤 A）设计风格：

- 页面居中布局，背景 `#fafafa`
- 白色卡片 `border: 1px solid #eaeaea; border-radius: 16px`
- Logo：黑底白字方标 "S" + "smanga"
- 三 tab 数据库类型切换：SQLite / MySQL / PostgreSQL
- SQLite 选中时隐藏连接表单，显示提示文字
- MySQL/PG 选中时显示：主机、端口、用户名、密码、数据库名
- 管理员账户表单：用户名、密码、确认密码
- 主按钮：`background: #2563eb`，loading 状态
- 初始化完成后展示：成功提示 + 等待重启倒计时

### 4.2 前端路由注册

`src/router/index.ts` 中 `/init` 路由指向新页面：

```ts
{
  path: '/init',
  name: 'init',
  meta: { sidebar: false },
  component: () => import('../themes/theme-a/pages/init.vue'),
}
```

### 4.3 前端 API

`src/api/login.ts` 新增/更新：

```ts
async init_deploy(data: {
  client: string
  host?: string
  port?: number
  username?: string
  password?: string
  database?: string
  adminUser: string
  adminPass: string
}) {
  const res = ajax({
    timeout: 3 * 60 * 1000,  // Prisma 命令可能耗时较长
    url: 'deploy/init',
    data,
  })
  return (await res).data
}
```

### 4.4 废弃旧页面

删除 `src/views/init/` 整个目录，不再使用。

---

## 五、Docker 环境配置

### 5.1 s6-overlay 服务

`smaanga-adonis/docker/etc/s6-overlay/s6-rc.d/svc-adonis/run` 中，如果子进程正常退出（exit 0），s6-overlay 会自动重新拉起服务，实现无感重启。

### 5.2 Docker 容器首次启动流程

```
1. 容器启动 → s6-overlay 启动 svc-adonis 服务
2. svc-adonis/run → data/config/smanga.json 不存在
   → init-config 补丁脚本写入默认配置（sql.deploy=false）
3. adonis serve → kernel.ts 检测 deploy=false → 初始化模式
4. 用户访问 → 填写表单 → 提交
5. 后端执行 Prisma + 创建用户 → deploy=true → process.exit(0)
6. s6-overlay 检测进程退出 → 自动重启 svc-adonis
7. 第二次启动 → deploy=true → 正常模式
```

---

## 六、文件清单

### 需要修改的文件

| 文件 | 改动内容 |
|------|---------|
| `smaanga-adonis/start/kernel.ts` | 加入 deploy 判断，拆分 init_dirs_only() |
| `smaanga-adonis/start/init.ts` | 导出 init_dirs_only()，移除硬编码用户创建 |
| `smaanga-adonis/app/utils/index.ts` | get_os() 增加 darwin → 'MacOS' 判断 |
| `smaanga-adonis/app/controllers/deploys_controller.ts` | 新增 init() 方法 |
| `smaanga-adonis/start/routes.ts` | 新增 POST /deploy/init 路由 |
| `smaanga/src/router/index.ts` | /init 路由指向新页面 |
| `smaanga/src/api/login.ts` | 新增 init_deploy() API |

### 需要新建的文件

| 文件 | 内容 |
|------|------|
| `smaanga/src/themes/theme-a/pages/init.vue` | 新初始化页面（Theme A 皮肤） |

### 需要删除的文件

| 路径 | 内容 |
|------|------|
| `smaanga/src/views/init/` | 整个目录，旧初始化页面 |

---

## 七、注意事项

1. **SQLite 场景**：如果用户选择 SQLite 并完成初始化，后续想切换到 MySQL/PG，需要手动修改 `smanga.json` 中 `sql.deploy` 为 `false` 并删除 `.env` 中的旧 DB 连接，删除 `data/db/smanga.db` 后重启服务，重新进入初始化模式。

2. **无需重启的特殊情况**：如果服务初次启动时就是 SQLite 且 `smanga.json` 已存在但 `deploy=false`，流程依然正确——`init_dirs_only()` 不会覆盖已有配置文件。

3. **安全考量**：初始化期间 `/deploy/init` 完全无鉴权。生产环境建议仅在首次部署时暴露，或通过防火墙限制访问来源。

4. **错误处理**：初始化过程中任一步骤失败（如数据库连接失败、prisma 命令报错），应返回明确错误信息，且**不设 deploy=true**，允许用户修正后重试。
