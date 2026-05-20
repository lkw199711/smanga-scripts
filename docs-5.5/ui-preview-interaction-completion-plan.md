# UI 预览页交互完善方案

## 1. 背景

当前 `smanga/src/views/ui-preview/index.vue` 已经有四套 UI 预览稿：

- A：现代简约
- B：漫画风
- C：暗色优先
- D：降饱和多主题

当前预览页通过顶部两排按钮切换内容：

- 第一排切换场景：`首页 / 阅读器 / 管理 / 设置`
- 第二排切换风格：`A / B / C / D`

这种方式适合快速查看单个页面，但不适合评估真实产品体验。实际用户不会通过“场景切换按钮”进入管理页，而是会点击侧边栏中的“管理”；不会通过顶部按钮进入阅读器，而是会点击继续阅读、漫画章节或书签。

因此，`ui-preview` 应从“静态页面切换器”升级为“可交互 UI 样机”。用户进入预览页后，应能通过正常应用交互完成视图跳转，从而更准确地比较四套新 UI 风格。

本方案只描述文档，不要求修改业务代码。

## 2. 现状梳理

### 2.1 当前入口

路由位置：

```text
smanga/src/router/index.ts
```

当前路由：

```ts
{
  path: '/ui-preview',
  name: 'ui-preview',
  meta: { sidebar: false, title: 'UI Preview' },
  component: () => import('../views/ui-preview/index.vue'),
}
```

预览页入口：

```text
smanga/src/views/ui-preview/index.vue
```

当前核心状态：

```ts
const activeScene = ref<SceneKey>('home')
const active = ref<TabKey>('A')
```

当前组件映射：

```ts
const viewMap: Record<SceneKey, Record<TabKey, any>> = {
  home: { A: StyleA, B: StyleB, C: StyleC, D: StyleD },
  reader: { A: ReaderA, B: ReaderB, C: ReaderC, D: ReaderD },
  manage: { A: ManageA, B: ManageB, C: ManageC, D: ManageD },
  setting: { A: SettingA, B: SettingB, C: SettingC, D: SettingD },
}
```

### 2.2 当前预览页面资源

当前目录结构已经比较完整：

```text
smanga/src/views/ui-preview/
  index.vue
  mock.ts
  styles/
    style-a-minimal.vue
    style-b-manga.vue
    style-c-dark.vue
    style-d-desat.vue
  reader/
    reader-a-minimal.vue
    reader-b-manga.vue
    reader-c-dark.vue
    reader-d-desat.vue
  manage/
    manage-a-minimal.vue
    manage-b-manga.vue
    manage-c-dark.vue
    manage-d-desat.vue
  setting/
    setting-a-minimal.vue
    setting-b-manga.vue
    setting-c-dark.vue
    setting-d-desat.vue
```

`mock.ts` 已有数据：

- `mediaList`
- `sidebarMenu`
- `continueReading`
- `recentAdded`
- `stats`
- `readerMock`
- `manageMock`
- `settingMock`
- `styleSpec`

这些数据足以支撑第一阶段交互样机，但若要覆盖更完整的应用流程，需要补充漫画详情、章节列表、历史、收藏、书签、搜索、标签和管理模块数据。

### 2.3 当前交互问题

当前主要问题不是视觉不足，而是交互模型不足：

1. 顶部“场景切换”承担了页面导航职责，和真实应用使用方式不一致。
2. 首页侧边栏的“管理 / 设置 / 搜索 / 书签 / 收藏”等项目只是视觉元素，点击后不会改变视图。
3. 继续阅读、最近添加、漫画卡片等关键入口不能进入阅读器或详情页。
4. 管理页直接显示漫画管理表格，没有先展示“管理入口面板”，无法评估真实管理信息架构。
5. 设置页与首页导航没有连通，不能通过正常路径进入。
6. 四套风格之间的可交互程度不一致，D 风格有主题色切换，但其他页面没有统一的页面导航协议。
7. 当前预览页只覆盖 4 个大场景，不足以判断真实应用迁移后的完整体验。

## 3. 目标

### 3.1 总目标

将 `/ui-preview` 做成一个自包含的交互式 UI 预览环境。

用户应该可以在不离开 `/ui-preview` 的情况下，像使用真实应用一样操作：

- 点击“管理”进入管理页面
- 点击“设置”进入设置页面
- 点击“继续阅读”进入阅读器
- 点击漫画卡片进入漫画详情
- 点击章节进入阅读器
- 输入关键词搜索并进入搜索结果
- 点击媒体库进入漫画列表
- 在阅读器内翻页、打开目录、切换章节、返回上一层
- 切换 A/B/C/D 风格时保持当前页面上下文

### 3.2 非目标

本方案不建议在 `ui-preview` 中做以下事情：

- 不接真实后端接口。
- 不复用真实用户数据。
- 不从 `/ui-preview` 真实跳转到 `/t`、`/manage`、`/setting` 等业务路由。
- 不把预览页做成生产可用页面。
- 不为了预览而修改业务路由结构。

预览页的价值是安全、快速、可对比。它应该保持自包含。

## 4. 设计原则

### 4.1 真实交互优先

主要页面切换必须来自页面内部真实入口，而不是顶部场景按钮。

例如：

- 用户点击侧边栏“管理”进入管理页。
- 用户点击侧边栏“设置”进入设置页。
- 用户点击漫画封面进入漫画详情。
- 用户点击章节进入阅读器。

顶部工具栏只能作为预览辅助，不应成为主要导航方式。

### 4.2 四套风格交互一致

A/B/C/D 的视觉可以完全不同，但操作能力应该一致。

如果 A 风格支持点击“管理”进入管理页，则 B/C/D 也必须支持。

如果 B 风格支持点击漫画卡片进入详情，则 A/C/D 也必须支持。

不能出现某一套风格只是静态稿，另一套风格可以完整操作的情况。

### 4.3 预览内状态驱动

`ui-preview` 内部应维护自己的轻量路由状态，而不是使用真实 `vue-router` 跳业务页面。

推荐使用内部状态：

```ts
type PreviewPage =
  | 'home'
  | 'media'
  | 'manga-list'
  | 'manga-info'
  | 'chapter-list'
  | 'reader'
  | 'history'
  | 'bookmark'
  | 'collect'
  | 'search'
  | 'tag-list'
  | 'manage'
  | 'manage-user'
  | 'manage-media'
  | 'manage-manga'
  | 'manage-chapter'
  | 'manage-bookmark'
  | 'manage-tag'
  | 'manage-jobs'
  | 'setting-user'
  | 'setting-serve'

type PreviewStyle = 'A' | 'B' | 'C' | 'D'
```

推荐状态：

```ts
const activeStyle = ref<PreviewStyle>('A')
const currentPage = ref<PreviewPage>('home')
const previewParams = reactive({
  mediaId: undefined as number | undefined,
  mangaId: undefined as number | undefined,
  chapterId: undefined as number | undefined,
  keyword: '',
})
const pageStack = ref<Array<{ page: PreviewPage; params: Record<string, any> }>>([])
```

### 4.4 Mock 数据必须能串联

mock 数据不能只是页面展示数据，还应该支持页面间跳转。

例如：

- 漫画卡片有 `mangaId`
- 漫画属于某个 `mediaId`
- 章节属于某个 `mangaId`
- 阅读器通过 `chapterId` 找到章节
- 书签、历史、收藏都能指向漫画或章节

这样用户点击后看到的页面才有上下文，不会像随机切图。

## 5. 推荐信息架构

### 5.1 顶层页面

建议 `ui-preview` 至少覆盖以下页面：

| 页面 key | 页面名称 | 说明 |
| --- | --- | --- |
| `home` | 首页 | 仪表盘、继续阅读、最近添加 |
| `media` | 媒体库 | 媒体库总览 |
| `manga-list` | 漫画列表 | 某媒体库下的漫画 |
| `manga-info` | 漫画详情 | 漫画信息、标签、章节入口 |
| `chapter-list` | 章节列表 | 某漫画的章节 |
| `reader` | 阅读器 | 阅读章节 |
| `history` | 最近阅读 | 历史记录 |
| `bookmark` | 书签 | 书签列表 |
| `collect` | 收藏 | 收藏列表 |
| `search` | 搜索 | 搜索结果 |
| `tag-list` | 标签 | 标签集合 |
| `manage` | 管理入口 | 管理模块总览 |
| `setting-user` | 用户设置 | 用户偏好 |
| `setting-serve` | 服务器设置 | 服务配置 |

### 5.2 管理子页面

管理页建议不要直接进入漫画表格，而是先展示管理面板。

管理面板建议包含：

| 页面 key | 页面名称 | 说明 |
| --- | --- | --- |
| `manage-user` | 用户管理 | 用户、权限、角色 |
| `manage-media` | 媒体库管理 | 媒体库、新建、扫描 |
| `manage-manga` | 漫画管理 | 当前已有管理表格 |
| `manage-chapter` | 章节管理 | 章节、封面、排序 |
| `manage-bookmark` | 书签管理 | 书签批量整理 |
| `manage-tag` | 标签管理 | 标签颜色、关联关系 |
| `manage-jobs` | 任务管理 | 扫描、同步、压缩任务 |

第一阶段可以只完整实现 `manage` 和 `manage-manga`，其他管理子页使用同风格的占位面板，但必须能点击进入并返回。

## 6. 交互流程设计

### 6.1 首页到管理

目标行为：

```text
打开 /ui-preview
点击侧边栏“管理”
进入管理入口页
点击“漫画管理”
进入漫画管理表格
点击返回
回到管理入口页
```

状态变化：

```text
home -> manage -> manage-manga
```

说明：

- 原顶部“管理”场景按钮不再作为主入口。
- 管理入口页应展示多个管理模块，让用户评估管理区整体视觉。
- 漫画管理表格可以复用当前 `manage-a/b/c/d` 的内容。

### 6.2 首页到设置

目标行为：

```text
打开 /ui-preview
点击侧边栏“设置”
进入用户设置页
点击服务器设置
进入服务器设置页
点击返回
回到用户设置页或首页
```

状态变化：

```text
home -> setting-user -> setting-serve
```

说明：

- 当前 `setting-a/b/c/d` 可以作为 `setting-user`。
- 应补一个 `setting-serve` 的预览页面，用于展示服务器设置、缓存策略、扫描配置、连接配置等。

### 6.3 首页到阅读器

目标行为：

```text
打开 /ui-preview
点击“继续阅读”中的漫画卡片
进入阅读器
点击下一页
页码变化
点击目录
打开章节目录
点击其他章节
阅读器切换章节
点击返回
回到首页或上一页
```

状态变化：

```text
home -> reader
```

说明：

- 当前 `reader-a/b/c/d` 已有翻页和目录显示能力。
- 需要把“返回”按钮接入预览内 `goBack()`。
- 目录章节点击应能改变 `chapterId` 和标题。

### 6.4 漫画详情链路

目标行为：

```text
打开 /ui-preview
点击“最近添加”漫画卡片
进入漫画详情
点击“查看章节”
进入章节列表
点击某一章
进入阅读器
点击返回
回到章节列表
```

状态变化：

```text
home -> manga-info -> chapter-list -> reader
```

说明：

- 这是最重要的阅读业务链路。
- 四套 UI 风格都应该展示这条链路，否则无法判断新 UI 是否适合真实使用。

### 6.5 搜索链路

目标行为：

```text
在顶部搜索框输入“芙莉莲”
按 Enter
进入搜索结果页
点击搜索结果漫画
进入漫画详情
```

状态变化：

```text
home -> search -> manga-info
```

说明：

- 搜索结果不需要真实检索后端。
- 可以在 mock 数据中按漫画名、章节名、标签做简单过滤。
- 若关键词为空，可以展示推荐搜索或空状态。

### 6.6 媒体库链路

目标行为：

```text
点击侧边栏某个媒体库
进入该媒体库漫画列表
点击漫画
进入漫画详情
```

状态变化：

```text
home -> manga-list -> manga-info
```

说明：

- 现有 `mediaList` 只有 `id/name/icon/count`，建议补充具体漫画归属。
- 媒体库列表可以先使用 mock 漫画按 `mediaId` 过滤。

## 7. 父子组件交互协议

### 7.1 推荐事件

建议所有 `ui-preview` 子组件统一通过事件通知父组件，不直接使用真实 `router.push`。

推荐事件：

```ts
const emit = defineEmits<{
  navigate: [payload: NavigatePayload]
  back: []
  changeStyle: [style: PreviewStyle]
}>()

type NavigatePayload = {
  page: PreviewPage
  params?: Record<string, any>
  replace?: boolean
}
```

### 7.2 使用示例

侧边栏点击管理：

```vue
<div class="nav-item" @click="emit('navigate', { page: 'manage' })">
  管理
</div>
```

点击继续阅读：

```vue
<div class="continue-card" @click="emit('navigate', {
  page: 'reader',
  params: { chapterId: item.chapterId }
})">
  ...
</div>
```

点击漫画卡片：

```vue
<div class="manga-card" @click="emit('navigate', {
  page: 'manga-info',
  params: { mangaId: item.mangaId }
})">
  ...
</div>
```

阅读器返回：

```vue
<button @click="emit('back')">返回</button>
```

### 7.3 父组件处理

父组件 `index.vue` 中可以维护：

```ts
function navigate(payload: NavigatePayload) {
  if (!payload.replace) {
    pageStack.value.push({
      page: currentPage.value,
      params: { ...previewParams },
    })
  }

  currentPage.value = payload.page
  Object.assign(previewParams, payload.params || {})
}

function goBack() {
  const last = pageStack.value.pop()
  if (!last) {
    currentPage.value = 'home'
    return
  }

  currentPage.value = last.page
  Object.assign(previewParams, last.params)
}
```

## 8. 组件映射建议

当前 `viewMap` 以 `SceneKey` 为维度。建议改成以完整页面为维度。

推荐结构：

```ts
const pageMap: Record<PreviewPage, Record<PreviewStyle, Component>> = {
  home: { A: HomeA, B: HomeB, C: HomeC, D: HomeD },
  reader: { A: ReaderA, B: ReaderB, C: ReaderC, D: ReaderD },
  manage: { A: ManageHomeA, B: ManageHomeB, C: ManageHomeC, D: ManageHomeD },
  'manage-manga': { A: ManageMangaA, B: ManageMangaB, C: ManageMangaC, D: ManageMangaD },
  'setting-user': { A: SettingUserA, B: SettingUserB, C: SettingUserC, D: SettingUserD },
  ...
}
```

如果第一阶段不想创建太多文件，也可以先使用同一批组件兜底：

```ts
const pageFallback = {
  history: home,
  bookmark: home,
  collect: home,
  search: home,
}
```

但最终验收时不建议长期使用兜底，因为无法判断真实页面设计。

## 9. 顶部预览工具栏调整

当前顶部工具栏：

- 场景切换
- 风格切换
- 规格浮层
- 返回应用

建议调整为：

### 9.1 保留

- UI 预览标题
- 当前风格名称
- A/B/C/D 风格切换
- 查看/隐藏规格
- 返回应用

### 9.2 新增

- 当前页面面包屑，例如：

```text
UI 预览 / A 现代简约 / 漫画详情 / 葬送的芙莉莲
```

- 预览内返回按钮，例如：

```text
返回上一页
```

### 9.3 弱化

原来的“首页 / 阅读器 / 管理 / 设置”场景切换按钮不建议删除，可以先折叠为“快速跳转”调试菜单。

它只用于开发检查，不再作为主要交互方式。

## 10. Mock 数据扩展建议

### 10.1 漫画数据

建议新增：

```ts
export const previewMangas = [
  {
    mangaId: 1,
    mediaId: 1,
    name: '进击的巨人',
    author: '谏山创',
    status: '完结',
    chapterCount: 139,
    unread: 0,
    progress: 87,
    tags: ['热血', '剧情', '完结'],
    gradient: ['#FFB5A7', '#FEC89A'],
    desc: '人类与巨人之间的生存故事。',
  },
]
```

### 10.2 章节数据

建议新增：

```ts
export const previewChapters = [
  {
    chapterId: 1001,
    mangaId: 1,
    name: '第 139 话 · 最终话',
    pageCount: 24,
    read: true,
    progress: 100,
  },
]
```

### 10.3 管理模块数据

建议新增：

```ts
export const manageModules = [
  {
    key: 'manage-user',
    title: '用户管理',
    desc: '管理用户、权限与角色',
    count: 8,
  },
  {
    key: 'manage-manga',
    title: '漫画管理',
    desc: '批量编辑漫画元数据、封面与标签',
    count: 1284,
  },
]
```

### 10.4 搜索数据

搜索页可以从 `previewMangas` 和 `previewChapters` 派生，不需要单独维护。

## 11. 四套风格的页面建议

### 11.1 A 现代简约

定位：

- 信息密度高
- 管理操作清楚
- 长时间使用不疲劳

建议：

- 保留左侧栏固定宽度。
- 顶部搜索和操作按钮保持简洁。
- 管理页使用表格和紧凑工具栏。
- 详情页用左右布局：封面 / 元信息 / 章节摘要。
- 阅读器按钮克制，不遮挡内容。

### 11.2 B 漫画风

定位：

- 视觉更轻松
- 适合个人漫画库
- 卡片感强

建议：

- 继续保留玻璃卡、渐变和圆角。
- 交互反馈可以更明显，例如 hover 上浮。
- 管理页可以使用卡片列表，而不是强制表格。
- 搜索结果页可突出封面和标签。
- 阅读器目录可以做成轻量抽屉。

### 11.3 C 暗色优先

定位：

- 夜间使用
- 阅读友好
- 边框分层而非大阴影

建议：

- 避免大面积高亮色。
- 管理表格维持高对比但不过曝。
- 阅读器背景使用深色，控件透明度适中。
- 搜索框和列表 hover 需要有明确边界。
- 强调色只用于当前状态和主操作。

### 11.4 D 降饱和多主题

定位：

- 保留原来的多主题用户习惯
- 相对低风险迁移
- 适合从旧 UI 平滑过渡

建议：

- 主题色切换状态应跨页面保留。
- 首页、管理、设置、阅读器都使用同一套 CSS 变量。
- 深色主题应作为 D 的一个主题色，而不是独立风格。
- 页面结构尽量接近 A，方便维护和复用。

## 12. 响应式要求

预览页虽然主要用于桌面参考，但仍建议检查窄屏表现。

最低要求：

- 1366px 桌面：完整展示侧边栏、内容区和顶部工具栏。
- 1024px 平板：侧边栏可缩窄，卡片网格减少列数。
- 768px 以下：侧边栏可转为顶部或抽屉，不出现主要文字重叠。
- 阅读器：窄屏下底部按钮不挤压页码。
- 管理表格：窄屏下允许横向滚动或切换卡片模式。

预览工具栏本身不能遮挡预览内容。规格浮层默认可以显示，但必须能关闭。

## 13. 验收标准

### 13.1 基础验收

完成后 `/ui-preview` 应满足：

- 默认进入 A 风格首页。
- 顶部可以切换 A/B/C/D 风格。
- 切换风格后保留当前页面和参数。
- 规格浮层能打开和关闭。
- 返回应用按钮回到 `/`。

### 13.2 导航验收

以下交互必须可用：

- 点击侧边栏“首页”进入首页。
- 点击侧边栏“管理”进入管理入口页。
- 点击管理入口中的“漫画管理”进入漫画管理页。
- 点击侧边栏“设置”进入用户设置页。
- 点击媒体库进入漫画列表。
- 点击漫画卡片进入漫画详情。
- 点击漫画详情的章节入口进入章节列表。
- 点击章节进入阅读器。
- 点击继续阅读进入阅读器。
- 点击搜索框输入关键词并回车进入搜索结果页。
- 点击阅读器返回按钮返回上一页。

### 13.3 四套风格验收

对 A/B/C/D 分别执行：

```text
首页 -> 管理 -> 漫画管理 -> 返回
首页 -> 设置 -> 返回
首页 -> 漫画详情 -> 章节列表 -> 阅读器 -> 返回
首页 -> 搜索 -> 漫画详情
首页 -> 切换风格 -> 保持当前页面
```

任意一套风格失败，都视为交互预览不完整。

### 13.4 视觉验收

检查点：

- 不出现按钮文字溢出。
- 不出现卡片内容重叠。
- 不出现规格浮层遮挡关键按钮后无法关闭。
- 阅读器页码、目录、上一页、下一页状态明确。
- 管理表格或管理卡片在窄屏下可阅读。
- D 风格主题色切换后，文本仍有足够对比度。

## 14. 推荐实施步骤

### 阶段一：建立预览内导航

目标：

- 在 `ui-preview/index.vue` 中引入 `currentPage`、`previewParams`、`pageStack`。
- 将顶部场景按钮降级为快速跳转。
- 给首页侧边栏接入 `navigate`。
- 接入 `home -> manage`、`home -> setting-user`、`home -> reader`。

产出：

- 用户能通过自然点击进入管理、设置、阅读器。

### 阶段二：补齐核心阅读链路

目标：

- 新增 `manga-info` 预览页。
- 新增 `chapter-list` 预览页。
- 补充 `previewMangas`、`previewChapters`。
- 接入 `home -> manga-info -> chapter-list -> reader`。

产出：

- 可以完整评估从找漫画到阅读章节的体验。

### 阶段三：补齐列表类页面

目标：

- 新增 `history`、`bookmark`、`collect`、`search`、`tag-list`。
- 搜索支持本地 mock 过滤。
- 媒体库点击进入 `manga-list`。

产出：

- 侧边栏所有主要入口都可点击。

### 阶段四：完善管理与设置

目标：

- 管理入口页展示管理模块总览。
- 漫画管理复用当前已有表格或卡片。
- 其他管理子页提供同风格占位面板。
- 设置拆分为用户设置和服务器设置。

产出：

- 可以评估新 UI 是否适合实际管理工作流。

### 阶段五：统一四套风格细节

目标：

- A/B/C/D 全部接入同一交互协议。
- 风格切换保留当前页面。
- D 的主题色状态在预览页内跨页面保留。
- 清理重复 mock 和重复跳转逻辑。

产出：

- `/ui-preview` 成为完整可对比的交互式样机。

## 15. 文件组织建议

当前按场景分目录：

```text
styles/
reader/
manage/
setting/
```

当页面增多后，建议改成以下结构之一。

### 方案 A：按页面分组

```text
ui-preview/
  index.vue
  mock.ts
  types.ts
  pages/
    home/
      home-a.vue
      home-b.vue
      home-c.vue
      home-d.vue
    reader/
    manage/
    setting/
    manga-info/
    chapter-list/
    search/
```

优点：

- 同一页面的四套风格容易对比。
- 适合当前预览工作。

缺点：

- 如果未来每套风格独立发展，跨页面复用稍弱。

### 方案 B：按风格分组

```text
ui-preview/
  index.vue
  mock.ts
  types.ts
  styles/
    a/
      home.vue
      reader.vue
      manage.vue
      setting.vue
    b/
    c/
    d/
```

优点：

- 每套风格更独立。
- 适合后续把某套预览稿迁移成真实主题。

缺点：

- 对比同一页面时要跨目录查看。

推荐：

短期使用方案 A，便于继续完善 UI 预览；如果后续决定把某套风格正式产品化，再迁移到 `smanga/src/themes` 的真实主题结构。

## 16. 与真实主题系统的关系

项目中已经存在真实主题系统：

```text
smanga/src/themes/
```

真实主题目前通过 `/t` 路由使用：

```text
/t
/t/media
/t/media/:mediaId
/t/manga/:mangaId
/t/manga/:mangaId/chapters
/t/history
/t/bookmark
/t/collect
/t/search
/t/tags
/t/setting/user
/t/setting/serve
/t/manage
/t/reader/:chapterId
```

`ui-preview` 与真实主题系统的关系建议如下：

- `ui-preview` 负责快速验证视觉和交互。
- `/t` 负责真实主题落地。
- 预览页不直接跳 `/t`，避免受到后端数据、登录态、真实路由的影响。
- 预览页中验证成熟的页面，再迁移到 `smanga/src/themes`。

当前真实主题只注册了 `A | B | D`：

```ts
export type ThemeKey = 'A' | 'B' | 'D'
```

而 `ui-preview` 中包含 `C` 暗色优先。因此，如果 C 后续要进入真实主题系统，需要额外补充：

- `theme-c/layout`
- `theme-c/pages`
- `theme-c/reader`
- `resolver.ts` 注册 C
- `store.ts` 注册 C
- 顶部主题切换项注册 C

这属于真实主题落地阶段，不是 `ui-preview` 阶段的必需项。

## 17. 风险点

### 17.1 预览页复杂度膨胀

如果把所有真实页面都复制一遍，`ui-preview` 会变重。

建议：

- 只实现关键交互链路。
- 数据都保持 mock。
- 管理子页允许使用轻量占位。

### 17.2 四套风格维护成本上升

页面越多，四套风格组件数量越多。

建议：

- 共享 `types.ts`、`mock.ts` 和导航事件。
- 可共享无视觉倾向的小组件，例如空状态、预览返回逻辑。
- 不强制共享 CSS，避免损伤风格差异。

### 17.3 与真实主题系统重复

`ui-preview` 和 `src/themes` 可能出现重复实现。

建议：

- `ui-preview` 保持样机定位。
- 确认某套风格后，再有计划地迁移到 `src/themes`。
- 不在预览期过早抽象真实业务组件。

## 18. 最小可交付版本

如果只做一个最小版本，建议包含：

1. 移除对顶部场景按钮的依赖。
2. 首页侧边栏能进入管理、设置、搜索、历史、收藏、书签。
3. 继续阅读能进入阅读器。
4. 最近添加能进入漫画详情。
5. 漫画详情能进入章节列表。
6. 章节列表能进入阅读器。
7. 阅读器能返回上一页。
8. 风格切换保留当前页面。
9. A/B/C/D 全部具备相同路径。

这个版本已经足够用于判断四套 UI 风格是否适合继续投入。

## 19. 建议结论

`ui-preview` 不应继续作为“二排按钮切换页面”的静态看稿页。

更合适的方向是：

- 顶部只控制风格和预览辅助能力。
- 页面切换全部通过真实 UI 元素触发。
- 内部维护轻量预览路由。
- mock 数据支持页面之间的上下文串联。
- 四套风格共享交互协议，但保留各自视觉语言。

这样完成后，你可以在一个安全的本地预览环境里，从首页一路点击到管理、设置、详情、章节和阅读器，更真实地判断哪套 UI 适合后续产品化。
