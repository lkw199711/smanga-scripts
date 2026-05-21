# UI Preview 管理/设置上下文菜单方案

## 背景

当前 `ui-preview` 的管理入口偏向“入口页中转”：

1. 侧边栏点击“管理”。
2. 进入管理入口页。
3. 再从一组管理卡片中选择用户管理、漫画管理、任务管理等具体页面。

这能展示管理信息架构，但实际操作路径会多一次中转。之前考虑过把所有管理项直接展开到主菜单里，不过主菜单会明显变长，浏览入口和管理入口混在一起，视觉上会显得臃肿。

新的方向参考 Emby/Jellyfin 一类媒体库产品：侧边栏不是始终展示全部入口，而是根据当前上下文切换菜单集合。

## 目标

仅完善 `smanga/src/views/ui-preview` 内的预览界面，不修改真实应用页面、真实主题页面、真实业务路由或后端接口。

调整后的 `ui-preview` 应满足：

- 默认展示浏览菜单，适合阅读和媒体库浏览。
- 点击“管理”后，侧边栏切换为管理菜单。
- 点击“设置”后，侧边栏切换为设置菜单。
- 管理菜单中的具体项可以点击直达对应预览页面。
- 设置菜单中的具体项可以点击直达对应预览页面。
- 管理概览可以保留，但不再是进入具体管理页的必经中转。
- 用户可以通过“返回浏览”切回普通浏览菜单。

## 菜单结构

### 浏览菜单

浏览菜单用于日常阅读和内容发现。

```text
首页
媒体库
最近阅读
书签
收藏
搜索
标签

管理
设置
```

其中“管理”和“设置”不是简单跳转到中转页，而是切换侧边栏菜单模式。

### 管理菜单

点击浏览菜单中的“管理”后，侧边栏切换为管理上下文。

```text
返回浏览

管理概览
用户管理
媒体库管理
漫画管理
路径管理
章节管理
书签管理
标签管理
解压管理
任务管理
```

第一阶段 `ui-preview` 已有或计划覆盖的页面包括：

- `manage`
- `manage-user`
- `manage-media`
- `manage-manga`
- `manage-chapter`
- `manage-bookmark`
- `manage-tag`
- `manage-jobs`

`path`、`compress` 可以先进入同风格占位面板，或后续补充对应 `manage-path`、`manage-compress` 预览页。

### 设置菜单

点击浏览菜单中的“设置”后，侧边栏切换为设置上下文。

```text
返回浏览

用户设置
服务器设置
```

第一阶段对应：

- `setting-user`
- `setting-serve`

## 状态模型

在 `ui-preview` 内部维护轻量菜单模式，不使用真实 `vue-router` 切换业务页面。

建议模型：

```ts
type PreviewMenuMode = 'browse' | 'manage' | 'setting'
```

菜单模式由当前预览页自动推导：

- 当前页是 `manage` 或以 `manage-` 开头时，显示管理菜单。
- 当前页是 `setting-user` 或 `setting-serve` 时，显示设置菜单。
- 其他页面显示浏览菜单。

这样用户通过顶部快速跳转、页面内部按钮、返回按钮进入不同页面时，侧边栏上下文也会保持正确。

## 交互规则

### 点击“管理”

从浏览菜单点击“管理”：

1. 切换到管理菜单。
2. 默认打开 `manage` 管理概览，或者后续可扩展为打开上次访问的管理子页。

### 点击管理子项

从管理菜单点击“漫画管理”等具体项：

1. 直接切换到对应预览页，例如 `manage-manga`。
2. 侧边栏保持管理菜单。
3. 不再经过管理入口卡片页。

### 点击“设置”

从浏览菜单点击“设置”：

1. 切换到设置菜单。
2. 默认打开 `setting-user`。

### 返回浏览

从管理菜单或设置菜单点击“返回浏览”：

1. 切回浏览菜单。
2. 优先回到进入管理/设置之前的浏览页。
3. 如果没有可恢复的浏览页，则回到 `home`。

## 实现范围

本次只修改：

- `smanga/src/views/ui-preview/index.vue`
- `smanga/src/views/ui-preview/mock.ts`
- `smanga/src/views/ui-preview/preview-page.vue`
- `smanga/src/views/ui-preview/styles/style-a-minimal.vue`
- `smanga/src/views/ui-preview/styles/style-b-manga.vue`
- `smanga/src/views/ui-preview/styles/style-c-dark.vue`
- `smanga/src/views/ui-preview/styles/style-d-desat.vue`

不修改：

- `smanga/src/router/index.ts`
- `smanga/src/themes/**`
- `smanga/src/views/*-manage/**`
- 任何后端代码

## 验收点

- 打开 `/ui-preview` 默认是浏览菜单。
- 点击侧边栏“管理”后，菜单变为管理菜单。
- 管理菜单中点击“漫画管理”直接进入漫画管理预览页。
- 管理菜单中点击“用户管理”等占位项能进入对应占位预览页。
- 点击“返回浏览”后恢复浏览菜单。
- 点击侧边栏“设置”后，菜单变为设置菜单。
- A/B/C/D 四套预览风格行为一致。
- 不影响真实应用页面和真实主题路由。
