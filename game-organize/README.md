# game-organize

独立的游戏文件整理工具，用于递归解压、识别 PC/APK 游戏文件、整理目录并生成 ZIP 压缩包。

## 环境要求

- Node.js 20 或更高版本
- Windows 上安装 WinRAR 和 7-Zip
- 默认尝试从常见安装路径查找 `WinRAR.exe` 和 `7z.exe`

## 安装与运行

```powershell
pnpm install
pnpm start -- "D:\\17H-game整理\\04"
```

也可通过环境变量指定源目录：

```powershell
$env:GAME_SOURCE_DIR = "D:\\17H-game整理\\04"
pnpm start
```

工具会在源目录的同级目录中创建 `organized` 和 `zipped` 目录。处理过程会改名、移动和解压源目录中的文件，请先用可恢复的数据进行测试。
