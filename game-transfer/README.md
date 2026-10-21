# game-transfer

读取 `game-catalog` 生成的月度 JSON，通过 `bdpan` CLI 将百度分享转存到“我的应用数据/bdpan”目录。

这个工具不会修改抓取 JSON。转存进度单独保存在 `data/transfer-state/YYYY-MM.json`，因此重新抓取或覆盖月度数据不会丢失已经完成的转存状态。

## 环境要求

- Debian/Linux AMD64 或 ARM64
- Node.js 20.18.1 或更高版本
- pnpm
- 已安装并登录 `bdpan`

## 安装

```bash
cd game-transfer
pnpm install
```

如果 `bdpan` 不在 PATH 中，可以在 `.env` 或系统环境中设置：

```dotenv
BDPAN_BIN=/home/lkw/.local/bin/bdpan
```

当前版本也支持直接使用 `--bdpan-bin`。

## 先预览

默认不会写入网盘：

```bash
pnpm start -- \
  --catalog ../game-catalog/data/acgyyg/2026-10.json \
  --limit 1
```

预览内容不显示分享链接和提取码，只显示文章 ID、游戏名称、目标目录以及是否有提取码。

## 单条 PoC

确认预览正确后，显式加入 `--execute`：

```bash
pnpm start -- \
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
pnpm start -- \
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

## 校验

```bash
pnpm typecheck
pnpm test
```

旧版本已经产生的双层目录不会被自动删除或移动。请先人工处理测试目录，随后用新版对新的游戏进行 PoC。
