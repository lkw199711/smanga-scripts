# Smanga 第二轮扫描体验优化实施文档

日期: 2026-05-17

## 1. 背景

第一轮已经处理了几个会直接导致“点了扫描却扫不到”的硬伤:

- 路径管理页扫描按钮传错 `pathId`
- 空路径不清理旧漫画
- 漫画/章节对比过度依赖名称或数量
- include/exclude 误伤章节
- 队列任务未充分 await、timeout 不生效

第二轮的目标不是继续零散修 bug，而是把扫描逻辑变成用户能理解、开发者能排查的流程。核心思路是:

1. 扫描前先做“预检/试扫描”，告诉用户按当前设置会识别到什么、跳过什么、哪里可能设置错。
2. 正式扫描时生成可持久查看的“扫描报告”，而不是只在任务队列里一闪而过。
3. 将文件系统发现逻辑和数据库写入逻辑拆开，降低后续改动风险。

## 2. 第二轮目标

必须完成:

- 新增扫描预检接口，不写数据库，不删除任何内容。
- 新增扫描报告数据结构，正式扫描可记录状态、统计、警告、错误、跳过原因。
- 前端新增“试扫描”和“查看扫描报告”入口。
- 扫描任务接口返回 `scanRunId`，用户可以从前端追踪扫描结果。
- 让用户明确知道媒体库类型、双层目录、include/exclude 对扫描结果的影响。

非目标:

- 不在第二轮实现实时文件监听。
- 不重写压缩包解压、封面提取、元数据解析。
- 不改变现有漫画/章节表结构的核心含义。
- 不删除旧的 `/path/scan/:pathId`、`/path/:pathId/rescan`、`/media/:mediaId/scan` 接口；需要保持兼容。

## 3. 当前用户困惑点与对应解法

### 3.1 用户不知道媒体库类型怎么选

现状:

- 普通库、单本库、双层目录都只是开关。
- 用户不知道自己的目录形态是否匹配当前设置。

解法:

- 预检时根据实际目录结构给出 `MEDIA_TYPE_MISMATCH` 警告。
- 前端在媒体库编辑页显示目录示例:
  - 普通连载库: `路径/漫画/章节/图片`
  - 单本库: `路径/漫画/图片` 或 `路径/漫画.cbz`
  - 双层目录: `路径/分类/漫画/章节/图片`

### 3.2 用户不知道为什么扫不到

现状:

- 扫描任务只显示提交成功。
- 跳过隐藏目录、不支持文件、include/exclude 过滤、路径不存在等原因没有展示。

解法:

- 预检返回 `recognized`、`skipped`、`warnings`、`errors`。
- 正式扫描持久化这些信息。
- 前端报告页按“识别到 / 将新增 / 将删除 / 跳过 / 警告 / 错误”分类展示。

### 3.3 用户不知道扫描结束没有

现状:

- 任务管理只看 active/waiting，完成和失败后的上下文很少。

解法:

- 正式扫描创建 `scanRun` 记录，状态从 `pending -> running -> success/failed`。
- 前端轮询扫描报告接口，或者在第二轮先用手动刷新，第三轮再考虑 websocket。

## 4. 推荐信息架构

### 4.1 后端新增概念

建议新增两个模型，不建议继续复用现有 `scan` 表。现有 `scan` 表的 `pathId` 是 unique，不适合做历史报告。

#### scanRun

记录一次预检或正式扫描的整体状态。

字段建议:

```prisma
model scanRun {
  scanRunId      Int      @id @default(autoincrement())
  runType        String   // preview | incremental | rescan | media
  triggerType    String   // manual | auto | createPath | api
  status         String   // pending | running | success | failed | canceled
  mediaId        Int?
  pathId         Int?
  pathContent    String?
  configSnapshot String?  // JSON 字符串，兼容 sqlite/mysql/pgsql
  summaryJson    String?  // JSON 字符串
  message        String?
  error          String?
  startedAt      DateTime?
  finishedAt     DateTime?
  createTime     DateTime @default(now())
  updateTime     DateTime @default(now()) @updatedAt
}
```

#### scanRunItem

记录一次扫描中的具体事件、跳过原因、警告、错误。

```prisma
model scanRunItem {
  scanRunItemId Int      @id @default(autoincrement())
  scanRunId     Int
  level         String   // info | warning | error
  category      String   // found | change | skipped | warning | error | summary
  targetType    String   // path | directory | manga | chapter | file | rule
  action        String?  // found | create | update | delete | skip | none
  reasonCode    String?
  reason        String?
  targetName    String?
  targetPath    String?
  extraJson     String?
  createTime    DateTime @default(now())
}
```

三套 Prisma schema 都要同步:

- `smanga-adonis/prisma/sqlite/schema.prisma`
- `smanga-adonis/prisma/mysql/schema.prisma`
- `smanga-adonis/prisma/pgsql/schema.prisma`

并补齐三套 migration。

### 4.2 后端新增服务

建议新增文件:

- `smanga-adonis/app/services/scan/scan_discovery_service.ts`
- `smanga-adonis/app/services/scan/scan_apply_service.ts`
- `smanga-adonis/app/services/scan/scan_report_service.ts`
- `smanga-adonis/app/controllers/scan_runs_controller.ts`
- `smanga-adonis/app/validators/scan_run.ts`

如果不想新建 `scan/` 子目录，也可以放在 `app/services`，但建议新建子目录，避免继续扩大 `scan_job.ts` 和 `scan_manga_job.ts`。

## 5. 扫描核心流程

### 5.1 Discovery: 只读发现阶段

输入:

```ts
type ScanDiscoveryInput = {
  mediaId?: number
  pathId?: number
  pathContent: string
  mediaType: number // 0 普通连载, 1 单本
  directoryFormat: number // 0 单层, 1 双层
  include?: string
  exclude?: string
  ignoreHiddenFiles: boolean
  isCloudMedia?: number
}
```

输出:

```ts
type ScanDiscoveryResult = {
  ok: boolean
  summary: {
    mangaFound: number
    chapterFound: number
    skipped: number
    warnings: number
    errors: number
  }
  mangas: DiscoveredManga[]
  items: ScanReportItem[]
}
```

发现阶段只负责:

- 判断路径是否存在、是否目录、是否可读。
- 根据 `mediaType`、`directoryFormat` 识别漫画和章节。
- 应用 include/exclude，只过滤“漫画发现”，不要再过滤章节。
- 识别常见设置错误并输出 warning。
- 返回跳过原因。

发现阶段严禁:

- 写入 `manga`、`chapter`、`meta`、`tag`。
- 删除任何数据库记录。
- 提交任何 Bull 队列任务。
- 生成封面。

### 5.2 Diff: 对比数据库阶段

输入:

- Discovery 的 `mangas`
- 当前 `pathId` 下数据库中的 `manga`
- 每本漫画下已有 `chapter`

输出:

```ts
type ScanDiff = {
  newMangas: DiscoveredManga[]
  existingMangas: ExistingMangaPair[]
  deletedMangas: ExistingManga[]
  changedChapters: {
    mangaPath: string
    newChapters: DiscoveredChapter[]
    deletedChapters: ExistingChapter[]
  }[]
}
```

比较规则:

- 漫画用 `mediaId + normalized(mangaPath)`。
- 章节用 `mangaId + normalized(chapterPath)`。
- 不用名称做主键式判断，名称只用于显示和搜索。

### 5.3 Apply: 正式写入阶段

正式扫描时:

1. 创建 `scanRun(status=pending)`。
2. 入队 Bull 任务，接口返回 `scanRunId`。
3. Job 开始后更新 `scanRun(status=running, startedAt=now)`。
4. 执行 Discovery。
5. 执行 Diff。
6. 执行数据库写入/删除。
7. 记录报告明细。
8. 更新 `scanRun(status=success/failed, summaryJson, finishedAt=now)`。

注意:

- 如果 Discovery 阶段发生 `REGEX_INVALID`、`PATH_NOT_EXISTS`、`READ_DIR_FAILED`，正式扫描应失败并停止，不应进入 Apply。
- `rescan` 仍然是危险操作，需要在报告和前端文案里明确“会删除再重建”。
- 大型媒体库报告明细可能很多，建议默认最多保存前 2000 条 item，其余只计入 summary，并记录一条 `REPORT_TRUNCATED` warning。

## 6. API 设计

### 6.1 预检已有路径

```http
GET /path/:pathId/scan-preview
```

返回:

```json
{
  "code": 200,
  "message": "",
  "data": {
    "summary": {
      "mangaFound": 12,
      "chapterFound": 268,
      "skipped": 6,
      "warnings": 1,
      "errors": 0
    },
    "items": [
      {
        "level": "info",
        "category": "found",
        "targetType": "manga",
        "action": "found",
        "targetName": "示例漫画",
        "targetPath": "/vol1/manga/示例漫画"
      },
      {
        "level": "warning",
        "category": "warning",
        "targetType": "path",
        "reasonCode": "MEDIA_TYPE_MISMATCH",
        "reason": "当前是普通连载库，但路径根目录下发现多个 cbz 文件，可能应选择单本库。"
      }
    ]
  }
}
```

### 6.2 预检未保存路径

用于新增路径时先试扫。

```http
POST /path/scan-preview
```

请求:

```json
{
  "mediaId": 1,
  "pathContent": "/vol1/manga",
  "autoScan": 0,
  "include": "",
  "exclude": "",
  "mediaType": 0,
  "directoryFormat": 0
}
```

`mediaType` 和 `directoryFormat` 可选。未传时从 `mediaId` 对应的媒体库读取。

### 6.3 正式扫描路径

保留旧接口:

```http
PUT /path/scan/:pathId
```

建议响应增加 `scanRunId`:

```json
{
  "code": 200,
  "message": "扫描任务已提交",
  "data": {
    "pathId": 3,
    "scanRunId": 1024
  }
}
```

### 6.4 重新扫描路径

保留旧接口:

```http
PUT /path/:pathId/rescan
```

建议响应增加 `scanRunId`。

### 6.5 扫描整个媒体库

保留旧接口:

```http
PUT /media/:mediaId/scan
```

建议返回多个 `scanRunId`:

```json
{
  "code": 200,
  "message": "已加入扫描队列",
  "data": {
    "mediaId": 1,
    "scanRunIds": [1024, 1025]
  }
}
```

### 6.6 查询扫描报告

```http
GET /scan-run?page=1&pageSize=20&mediaId=1&pathId=3
GET /scan-run/:scanRunId
GET /scan-run/:scanRunId/items?page=1&pageSize=100&level=warning
```

返回列表时只返回 summary；详情接口再返回 items。

## 7. reasonCode 建议表

| reasonCode | level | 说明 | 用户提示 |
|---|---|---|---|
| PATH_NOT_EXISTS | error | 路径不存在 | 路径不存在，请检查 Docker 映射或路径拼写 |
| PATH_NOT_DIRECTORY | error | 路径不是目录 | 当前路径不是文件夹 |
| READ_DIR_FAILED | error | 无法读取目录 | 程序没有权限读取该路径 |
| REGEX_INVALID | error | include/exclude 正则错误 | 匹配规则不是有效正则表达式 |
| HIDDEN_SKIPPED | info | 隐藏文件/目录被跳过 | 已按设置跳过隐藏项 |
| SMANGA_INFO_SKIPPED | info | 元数据目录被跳过 | smanga-info 是元数据目录，不作为漫画扫描 |
| UNSUPPORTED_FILE_EXTENSION | info | 不支持的文件类型 | 仅支持目录、zip、cbz、cbr、rar、7z、epub、pdf |
| INCLUDE_NOT_MATCHED | info | include 未命中 | 当前条目未匹配包含规则 |
| EXCLUDE_MATCHED | info | exclude 命中 | 当前条目命中排除规则 |
| MEDIA_TYPE_MISMATCH | warning | 媒体库类型疑似错误 | 当前目录结构可能需要切换普通/单本模式 |
| DIRECTORY_FORMAT_MISMATCH | warning | 双层目录设置疑似错误 | 当前目录结构可能需要切换双层目录 |
| EMPTY_MANGA | warning | 漫画目录下没有章节/图片 | 已识别漫画目录，但没有可用章节 |
| EMPTY_PATH | warning | 路径下没有识别到漫画 | 当前设置下没有找到漫画 |
| SAME_NAME_DIFFERENT_PATH | warning | 同名不同路径 | 存在同名漫画，系统会按路径区分 |
| REPORT_TRUNCATED | warning | 报告明细被截断 | 条目过多，仅展示部分明细 |

## 8. 前端改造

### 8.1 媒体库管理页

涉及文件:

- `smanga/src/views/media-manage/index.vue`
- `smanga/src/views/media-manage/components/mediaEdit.vue`
- `smanga/src/api/path.ts`
- 建议新增 `smanga/src/api/scan.ts`
- `smanga/src/language/zh-Cn.json`
- `smanga/src/language/zh-Tw.json`
- `smanga/src/language/en-US.json`

新增能力:

- 新增路径输入框旁增加“试扫描”按钮。
- 试扫描成功后打开扫描预检弹窗。
- 添加路径成功后，接口返回扫描任务已提交时展示“查看扫描报告”按钮。

新增媒体库弹窗文案建议:

```text
普通连载库: 路径/漫画/章节/图片
单本库: 路径/漫画/图片 或 路径/漫画.cbz
双层目录: 路径/分类/漫画/章节/图片
```

### 8.2 路径管理页

涉及文件:

- `smanga/src/views/path-manage/index.vue`
- `smanga/src/api/path.ts`

表格新增列:

- 最近扫描时间
- 最近扫描状态
- 识别漫画数
- 警告数
- 错误数

操作新增:

- 试扫描
- 查看报告

### 8.3 扫描报告组件

建议新增:

- `smanga/src/components/scan-report-dialog.vue`

组件能力:

- summary 卡片:
  - 识别漫画
  - 识别章节
  - 将新增
  - 将删除
  - 跳过
  - 警告
  - 错误
- tabs:
  - 识别到
  - 变更
  - 跳过
  - 警告
  - 错误
- 支持复制报告 JSON。
- 支持按 `reasonCode` 筛选。

### 8.4 任务管理页

短期做法:

- 保留现有 Bull 任务列表。
- 在任务详情里，如果 `job.data.args.scanRunId` 存在，显示“查看扫描报告”。

中期做法:

- 新增扫描报告入口，弱化 Bull 任务列表对普通用户的暴露。

## 9. 后端改造步骤

### 9.1 数据库

1. 三套 schema 增加 `scanRun`、`scanRunItem`。
2. 三套 migration 增加对应表。
3. 给常用查询字段加索引:
   - `scanRun.mediaId`
   - `scanRun.pathId`
   - `scanRun.status`
   - `scanRun.createTime`
   - `scanRunItem.scanRunId`
   - `scanRunItem.level`
   - `scanRunItem.reasonCode`

### 9.2 服务拆分

从现有 `ScanPathJob.scan_path` 和 `ScanMangaJob.scan_path` 抽取只读逻辑。

建议函数:

```ts
class ScanDiscoveryService {
  discoverPath(input: ScanDiscoveryInput): Promise<ScanDiscoveryResult>
  discoverMangas(input: ScanDiscoveryInput): DiscoveredManga[]
  discoverChapters(manga: DiscoveredManga, input: ScanDiscoveryInput): DiscoveredChapter[]
  classifyEntry(absPath: string): ScanEntryType
  validateRules(include?: string, exclude?: string): void
}
```

```ts
class ScanApplyService {
  buildDiff(pathId: number, discovery: ScanDiscoveryResult): Promise<ScanDiff>
  applyDiff(scanRunId: number, diff: ScanDiff): Promise<ScanApplySummary>
}
```

```ts
class ScanReportService {
  createRun(args: CreateScanRunArgs): Promise<number>
  markRunning(scanRunId: number): Promise<void>
  appendItems(scanRunId: number, items: ScanReportItem[]): Promise<void>
  finishSuccess(scanRunId: number, summary: object): Promise<void>
  finishFailed(scanRunId: number, error: unknown): Promise<void>
}
```

### 9.3 Controller

新增 `ScanRunsController`:

- `index`
- `show`
- `items`

扩展 `PathsController`:

- `preview`
- `scan` 响应带 `scanRunId`
- `re_scan` 响应带 `scanRunId`

扩展 `MediaController.scan`:

- 每个 path 创建一个 `scanRun`
- 返回 `scanRunIds`

### 9.4 Queue args

正式扫描任务 args 增加:

```ts
{
  pathId: number,
  scanRunId: number,
  scanMode: 'incremental' | 'rescan'
}
```

`ScanPathJob` 开始时如果有 `scanRunId`，就写报告；如果没有，保持旧行为，防止旧队列里的任务出错。

## 10. 前端交互流程

### 10.1 新增路径

1. 用户输入路径和 include/exclude。
2. 用户点击“试扫描”。
3. 前端调用 `POST /path/scan-preview`。
4. 弹窗显示预检结果。
5. 如果 `errors > 0`，禁用“添加并扫描”，只允许返回修改。
6. 如果 `mangaFound === 0`，允许继续，但必须二次确认。
7. 添加路径成功后展示“扫描任务已提交”，并提供“查看报告”。

### 10.2 增量扫描

1. 用户点击路径的“增量扫描”。
2. 后端创建 `scanRun` 并入队。
3. 前端提示任务已提交。
4. 用户可打开报告弹窗查看状态。

### 10.3 重新扫描

1. 用户点击“重新扫描”。
2. 前端确认文案必须明确:

```text
重新扫描会先删除该路径下已入库的漫画、章节、阅读历史关联数据，再按当前文件重新入库。是否继续?
```

3. 后端创建 `scanRun(runType=rescan)`。
4. 报告必须记录删除数量。

## 11. 验收标准

### 11.1 预检

- 给一个正确普通库目录，预检能显示漫画数和章节数。
- 给一个单本库目录，但媒体库设置为普通，预检出现 `MEDIA_TYPE_MISMATCH` warning。
- include 写成非法正则，预检返回 400 或 `errors > 0`，不写数据库。
- include 只影响漫画发现，不影响章节发现。
- 路径不存在时，预检明确提示路径不存在。

### 11.2 正式扫描报告

- 手动增量扫描接口返回 `scanRunId`。
- 任务运行中，报告状态为 `running`。
- 任务成功后，报告状态为 `success`，有 summary。
- 任务失败后，报告状态为 `failed`，有 error。
- 扫描完成后，即使 Bull 任务不在 active/waiting 中，报告仍可查看。

### 11.3 数据正确性

- 同名不同路径的漫画不会互相覆盖。
- 删除文件后增量扫描会删除对应漫画/章节。
- 同时新增一个章节、删除一个章节，扫描能同时识别两种变化。
- 空路径扫描会清理该路径下旧漫画。
- 隐藏文件是否跳过受 `scan.ignoreHiddenFiles` 控制。

### 11.4 前端

- 新增路径弹窗可试扫描。
- 路径管理页可查看最近扫描结果。
- 报告弹窗能清楚展示错误和跳过原因。
- 中文文案不再把定时扫描描述成“文件变化监听”。

## 12. 测试建议

### 12.1 后端单元测试目录样例

在测试中构造临时目录:

```text
normal/
  Manga A/
    001/
      001.jpg
    002.cbz

single-dir/
  Manga B/
    001.jpg
    002.jpg

single-archive/
  Manga C.cbz
  Manga D.zip

double/
  2024/
    Manga E/
      001/
        001.jpg

bad/
  readme.txt
  .hidden/
  Manga F-smanga-info/
```

覆盖用例:

- 普通库识别 `normal/Manga A`。
- 单本目录库识别 `single-dir/Manga B`。
- 单本压缩包库识别 `single-archive/Manga C.cbz`。
- 双层目录识别 `double/2024/Manga E`。
- include=`Manga A` 时不影响 `Manga A/001` 章节。
- exclude=`2024` 时双层目录下对应漫画被排除。
- include 非法正则时报错且不进入 apply。

### 12.2 后端集成测试

- 创建媒体库和路径。
- 调用预检接口，验证不产生 manga/chapter。
- 调用正式扫描接口，等待任务或使用同步 debug 模式，验证产生 manga/chapter 和 scanRun。
- 删除目录内容后再次扫描，验证删除对应数据库记录并生成报告。

### 12.3 前端手动测试

- 媒体库管理 -> 新增路径 -> 试扫描 -> 查看结果 -> 添加。
- 路径管理 -> 增量扫描 -> 查看报告。
- 路径管理 -> 重新扫描 -> 确认文案 -> 查看报告。
- 错误路径、非法正则、空目录、错误媒体库类型分别测试一次。

## 13. 迁移与兼容策略

- 第二轮上线后，旧接口仍然可用。
- 旧接口返回值只新增字段，不移除字段。
- 旧队列任务没有 `scanRunId` 时，Job 走兼容逻辑，不写报告但不能报错。
- 现有 `scan` 表暂不删除，避免迁移风险。可在第三轮决定废弃或迁移。

## 14. 性能与安全注意事项

- 预检只扫描目录结构，不解压压缩包。
- 压缩包章节数在第二轮可以先按 1 个章节计，不读取包内图片数量。
- 单次报告明细设置上限，例如 2000 条。
- 预检和正式扫描都要捕获目录读取异常，不能让整个服务崩溃。
- 错误正则必须阻止扫描写库，避免误删。
- 不要在接口响应里返回超大 items，明细走分页接口。

## 15. 推荐开发顺序

1. 数据库新增 `scanRun`、`scanRunItem`。
2. 实现 `ScanReportService`。
3. 实现 `ScanDiscoveryService`，先只接预检接口。
4. 实现预检 API 和后端测试。
5. 将 `ScanPathJob` 接入 `scanRunId`，正式扫描写报告。
6. 路径/媒体库扫描接口返回 `scanRunId`。
7. 前端新增 `scanApi` 和扫描报告组件。
8. 媒体库管理页接入“试扫描”。
9. 路径管理页接入“查看报告”。
10. 修改文案和 wiki。
11. 完成回归测试。

## 16. 交付清单

后端:

- 新表和 migration
- 新增扫描预检接口
- 新增扫描报告接口
- 正式扫描写报告
- 单元测试和集成测试

前端:

- 试扫描按钮和预检弹窗
- 扫描报告弹窗
- 路径管理页扫描状态展示
- 中文、繁中、英文文案

文档:

- 更新项目 wiki 的“新增媒体库”和“添加路径”
- 增加“为什么扫不到”的排查说明
- 增加目录结构示例

## 17. 可直接分派的任务单

### Backend-1: 建表与报告服务

负责人产出:

- `scanRun`、`scanRunItem` 三套 schema 和 migration
- `ScanReportService`
- `GET /scan-run`、`GET /scan-run/:id`、`GET /scan-run/:id/items`

验收:

- 能创建 run、写 item、分页读取 item。
- 三种数据库 schema 保持一致。

### Backend-2: Discovery 预检

负责人产出:

- `ScanDiscoveryService`
- `GET /path/:pathId/scan-preview`
- `POST /path/scan-preview`
- reasonCode 覆盖表中主要场景

验收:

- 预检不写 manga/chapter。
- 错误路径、非法正则、错误媒体类型都有明确结果。

### Backend-3: 正式扫描接入报告

负责人产出:

- `PathsController.scan/re_scan` 返回 `scanRunId`
- `MediaController.scan` 返回 `scanRunIds`
- `ScanPathJob` 写运行状态和报告

验收:

- 成功、失败、空目录、删除、警告均能在报告中看到。
- 无 `scanRunId` 的旧任务兼容。

### Frontend-1: 预检弹窗

负责人产出:

- `scanApi`
- `scan-report-dialog.vue`
- 媒体库管理新增路径时可试扫描

验收:

- 用户能看到识别数量、跳过数量、警告和错误。
- `errors > 0` 时不建议继续添加并扫描。

### Frontend-2: 路径页报告入口

负责人产出:

- 路径管理页新增最近扫描状态列
- 路径管理页新增查看报告
- 任务详情可跳转报告

验收:

- 扫描提交后用户能找到报告。
- 已完成或失败的扫描仍可查看。

### Docs-1: 用户说明

负责人产出:

- wiki/README 中新增目录结构示例
- 新增“扫描不到内容怎么办”
- 修正“定时扫描”文案，不再暗示文件变化监听

验收:

- 新用户可以根据示例判断自己该选普通、单本还是双层目录。
