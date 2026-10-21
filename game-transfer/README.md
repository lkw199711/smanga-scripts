# game-transfer

读取 `game-catalog` 生成的月度 JSON，通过 `bdpan` CLI 将百度分享转存到“我的应用数据/bdpan”目录。

这个工具不会修改抓取 JSON。转存进度单独保存在 `data/transfer-state/YYYY-MM.json`，因此重新抓取或覆盖月度数据不会丢失已经完成的转存状态。

## 环境要求

- Debian/Linux AMD64 或 ARM64
- Node.js 20.18.1 或更高版本
- npm（也可使用 pnpm）
- 已安装并登录 `bdpan`

## 安装

```bash
cd game-transfer
npm install
```

如果 `bdpan` 不在 PATH 中，可以在 `.env` 或系统环境中设置：

```dotenv
BDPAN_BIN=/home/lkw/.local/bin/bdpan
```

当前版本也支持直接使用 `--bdpan-bin`。

## 先预览

默认不会写入网盘：

```bash
npm start -- \
  --catalog ../game-catalog/data/acgyyg/2026-10.json \
  --limit 1
```

预览内容不显示分享链接和提取码，只显示文章 ID、游戏名称、目标目录以及是否有提取码。

## 单条 PoC

确认预览正确后，显式加入 `--execute`：

```bash
npm start -- \
  --catalog ../game-catalog/data/acgyyg/2026-10.json \
  --limit 1 \
  --execute
```

默认最终目录：

```text
我的应用数据/bdpan/games/YYYY-MM/<safe_name>
```

脚本实际先将分享转入月份目录，再处理顶层结果：

- 只有一个顶层文件夹：直接将分享者目录重命名为正式游戏名。
- 有多个顶层项目或顶层是文件：创建正式游戏目录，再逐项移动进去。
- 转存完成后会先写入 `transferred` 状态，再执行整理。整理失败时重新运行只会继续整理，不会再次转存。

## 批量运行

```bash
npm start -- \
  --catalog ../game-catalog/data/acgyyg/2026-10.json \
  --execute
```

脚本始终串行转存，默认在两次请求间等待 3 秒。

## 状态与重复运行

- `completed`：直接跳过。
- `submitted`：任务已经提交，直接跳过，避免重复创建任务。
- `transferred`：分享已转存但目录尚未整理；重新运行只继续整理。
- `failed`：默认跳过；显式提供 `--retry-failed` 才重试。
- 分享链接或提取码变化：指纹变化，作为新任务处理。

状态文件只保存分享指纹，不保存原始分享链接和提取码；文件权限为 `0600`。

## 调试时清除单条转存记录

清除操作按文章 ID 定位，只修改本地状态文件，不会调用 `bdpan`，也不会删除网盘文件。先预览：

```bash
npm start -- \
  --catalog ../game-catalog/data/acgyyg/2026-09.json \
  --post-id 31526 \
  --clear-record
```

确认后加入 `--execute`：

```bash
npm start -- \
  --catalog ../game-catalog/data/acgyyg/2026-09.json \
  --post-id 31526 \
  --clear-record \
  --execute
```

清除以后，该游戏会重新成为待转存项目。再次转存前请确认或移走百度网盘中已经存在的同名目录，否则可能发生重复或名称冲突。

## 校验

```bash
npm run typecheck
npm test
```

## 修复旧版已经产生的双层目录

旧状态中的 `completed` 会继续被正常运行跳过，防止同一个分享被重复转存。先预览指定文章的修复：

```bash
npm start -- \
  --catalog ../game-catalog/data/acgyyg/2026-09.json \
  --post-id 31526 \
  --repair-completed
```

确认文章与正式目录正确后，再加入 `--execute`。修复程序只接受一个明确的 `--post-id`，并要求正式目录中恰好只有一个内层文件夹。它会逐项上移内层内容，复查内层目录为空后才删除该空目录；任一安全检查不满足都会停止，不会重新转存分享。
