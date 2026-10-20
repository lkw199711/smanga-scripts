# game-catalog

按月抓取 `acgyyg.cc` 的电脑游戏文章，输出可供后续网盘转存和 `game-organize` 使用的结构化 JSON。

当前记录：

- 发布时间、原始文章地址和 WordPress ID
- 原始标题、正式名称和跨平台安全目录名
- 游戏简介文本、保留排版的 HTML、正文图片地址
- 页面中的全部分享方式、链接、提取码和原始段落
- 单独的解压密码
- 每月文章总数、成功/失败数及各分享平台链接数量

## 环境要求

- Node.js 20.18.1 或更高版本
- pnpm
- 有权访问目标文章的 `acgyyg.cc` 登录 Cookie

## 安装

```bash
pnpm install
```

## 运行

最简单的方式是在 `game-catalog` 目录创建 `.env`：

```dotenv
ACGYYG_COOKIE=wordpress_logged_in_...; PHPSESSID=...
```

脚本会从自身目录自动读取该文件，即使从其他工作目录启动也能找到。`.env` 已被 Git 忽略。

也可以使用系统环境变量：

```bash
export ACGYYG_COOKIE='wordpress_logged_in_...; PHPSESSID=...'
pnpm start -- --month 2026-10
```

PowerShell：

```powershell
$env:ACGYYG_COOKIE = 'wordpress_logged_in_...; PHPSESSID=...'
pnpm start -- --month 2026-10
```

也可以将 Cookie 单独保存到不提交的文件中：

```bash
pnpm start -- --month 2026-10 --cookie-file ./cookie.txt
```

默认生成 `data/acgyyg/YYYY-MM.json`。使用 `--output` 可以指定其他目录：

```bash
pnpm start -- --month 2026-10 --output /data/acgyyg
```

查看全部选项：

```bash
pnpm start -- --help
```

## 安全与抓取策略

- Cookie 不接受命令行明文参数，防止进入 shell 历史；也不会写入输出文件或日志。
- 默认只并发请求两篇文章，每次请求间隔 500ms，并对暂时性错误重试。
- Cookie 失效时立即停止，不会生成看似成功但缺少正文的数据。
- 未识别的新分享域名仍以 `provider: "unknown"` 保存，不会静默丢弃。
- JSON 采用临时文件写完后再改名，避免中断时留下半份结果。

## 校验

```bash
pnpm typecheck
pnpm test
```

这个工具只采集元数据，不会自动转存或下载网盘文件。自动转存会在数据格式稳定后作为下一阶段接入。
