import fs from 'fs';
import path from 'path';
import seven from 'node-7z';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface GameInfo {
    name: string;
    sourcePath: string;
    errors: string[];
}

/**
 * 游戏整理服务
 * 处理压缩包中包格式的游戏文件整理
 */
class GameOrganize {
    private sourceDir: string;
    private organizedDir: string;
    private zipDir: string;
    private extractPassword: string = '嘤嘤嘤';
    private extractCounter: number = 0; // 全局解压计数器,用于扁平化编号

    constructor(sourceDir: string) {
        this.sourceDir = sourceDir;
        this.organizedDir = path.join(path.dirname(sourceDir), 'organized');
        this.zipDir = path.join(path.dirname(sourceDir), 'zipped');
    }

    /**
     * 主执行方法
     */
    async execute(): Promise<void> {
        console.log('🎮 开始整理游戏文件...');
        
        // 创建输出目录
        this.ensureDirectories();
        
        // 获取所有游戏目录
        const gameDirs = this.getGameDirectories();
        console.log(`📁 找到 ${gameDirs.length} 个游戏目录`);
        
        // 处理每个游戏
        const results: GameInfo[] = [];
        for (const gameDir of gameDirs) {
            const gameName = path.basename(gameDir);
            console.log(`\n🔄 处理游戏: ${gameName}`);
            
            const gameInfo: GameInfo = {
                name: gameName,
                sourcePath: gameDir,
                errors: []
            };
            
            try {
                await this.processGame(gameInfo);
                results.push(gameInfo);
            } catch (error) {
                gameInfo.errors.push(`处理失败: ${error.message}`);
                results.push(gameInfo);
            }
        }
        
        // 输出结果
        this.printResults(results);
    }

    /**
     * 确保输出目录存在
     */
    private ensureDirectories(): void {
        if (!fs.existsSync(this.organizedDir)) {
            fs.mkdirSync(this.organizedDir, { recursive: true });
            console.log(`✅ 创建整理目录: ${this.organizedDir}`);
        }
        
        if (!fs.existsSync(this.zipDir)) {
            fs.mkdirSync(this.zipDir, { recursive: true });
            console.log(`✅ 创建压缩目录: ${this.zipDir}`);
        }
    }

    /**
     * 获取所有游戏目录
     */
    private getGameDirectories(): string[] {
        const entries = fs.readdirSync(this.sourceDir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isDirectory())
            .map(entry => path.join(this.sourceDir, entry.name));
    }

    /**
     * 处理单个游戏
     */
    private async processGame(gameInfo: GameInfo): Promise<void> {
        console.log(`  📁 游戏目录: ${gameInfo.sourcePath}`);
        
        // 检查是否已经压缩完成(断点续传)
        const zipFilePath = path.join(this.zipDir, `${gameInfo.name}.zip`);
        if (fs.existsSync(zipFilePath)) {
            console.log(`  ⏭️  已存在压缩文件,跳过: ${gameInfo.name}.zip`);
            return;
        }
        
        // 重置解压计数器(每个游戏独立编号)
        this.extractCounter = 0;
        
        // 第一步:文件改名映射 mkv->zip, tif->7z
        console.log(`  🔄 开始文件改名映射...`);
        await this.renameArchiveFiles(gameInfo.sourcePath);
        
        // 第二步:递归解压所有压缩包,直到找到游戏文件
        console.log(`  🔍 开始递归解压...`);
        await this.extractUntilGameFound(gameInfo.sourcePath, gameInfo);
        
        console.log(`  🔎 查找游戏目录...`);
        // 解压完成后,查找所有游戏目录(PC和APK)
        const gameDirs = await this.findAllGameDirs(gameInfo.sourcePath, gameInfo);
        
        if (gameDirs.length === 0) {
            console.log(`  ❌ 未找到游戏根目录`);
            gameInfo.errors.push('未找到有效的游戏目录(无exe/apk文件)');
            return;
        }
        
        console.log(`  ✅ 找到 ${gameDirs.length} 个游戏目录`);
        
        // 检查游戏类型
        const hasPC = gameDirs.some(d => d.type === 'PC');
        const hasAPK = gameDirs.some(d => d.type === 'APK');
        const needSubDir = hasPC && hasAPK; // 只有同时有PC和APK才需要子目录
        
        // 根据游戏类型分别整理
        for (const gameDir of gameDirs) {
            const gameType = gameDir.type; // 'PC' 或 'APK'
            const relativePath = path.relative(gameInfo.sourcePath, gameDir.path);
            console.log(`  📂 ${gameType}游戏目录: ${relativePath}`);
            
            // 创建整理目录
            let typeDir: string;
            if (needSubDir) {
                // PC和APK都有,创建子目录
                typeDir = path.join(this.organizedDir, gameInfo.name, gameType);
            } else {
                // 只有一种类型,直接放到游戏目录
                typeDir = path.join(this.organizedDir, gameInfo.name);
            }
            
            if (!fs.existsSync(typeDir)) {
                fs.mkdirSync(typeDir, { recursive: true });
            }
            
            console.log(`  📋 移动${gameType}游戏文件到整理目录...`);
            await this.moveGameFiles(gameDir.path, typeDir, gameInfo);
            
            // 删除免费游戏网站.txt
            await this.removeFreeGameFile(typeDir, gameInfo);
        }
        
        // 压缩整理完成的目录
        console.log(`  🗜️  压缩游戏目录...`);
        await this.zipGame(gameInfo);
    }

    /**
     * 文件改名映射: 测试mkv/tif是zip还是7z格式,然后改名
     * 支持分卷压缩包: .mkv.001 -> .7z.001
     */
    private async renameArchiveFiles(dir: string): Promise<void> {
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
            const filePath = path.join(dir, file);
            
            if (!fs.existsSync(filePath)) {
                continue;
            }
            
            const stat = fs.statSync(filePath);
            
            // 如果是目录,递归处理
            if (stat.isDirectory()) {
                await this.renameArchiveFiles(filePath);
                continue;
            }
            
            // 直接改名,不测试
            let ext = path.extname(file).toLowerCase();
            const baseName = path.basename(file, ext);
            let newExt = '';
            
            // 检查是否是分卷压缩包 (.001, .002 等)
            const volumeMatch = file.match(/\.(\d{3})$/);
            if (volumeMatch) {
                // 是分卷,需要检查前面的扩展名
                const volumeNum = volumeMatch[1];
                const nameWithoutVolume = path.basename(file, `.${volumeNum}`);
                const realExt = path.extname(nameWithoutVolume).toLowerCase();
                const realBaseName = path.basename(nameWithoutVolume, realExt);
                
                if (realExt === '.mkv') {
                    // .mkv.001 -> .zip.001
                    newExt = `.zip.${volumeNum}`;
                } else if (realExt === '.tif' || realExt === '.tiff') {
                    // .tif.001 -> .7z.001
                    newExt = `.7z.${volumeNum}`;
                }
                
                if (newExt) {
                    const newPath = path.join(dir, realBaseName + newExt);
                    fs.renameSync(filePath, newPath);
                    console.log(`    📝 改名: ${file} -> ${realBaseName}${newExt}`);
                }
            } else {
                // 普通文件
                if (ext === '.mkv') {
                    newExt = '.zip';
                } else if (ext === '.tif' || ext === '.tiff') {
                    newExt = '.7z';
                }
                
                if (newExt) {
                    const newPath = path.join(dir, baseName + newExt);
                    fs.renameSync(filePath, newPath);
                    console.log(`    📝 改名: ${file} -> ${baseName}${newExt}`);
                }
            }
        }
    }

    /**
     * 测试文件是否为 zip 格式 (使用WinRAR测试)
     */
    private async testZipFormat(filePath: string): Promise<boolean> {
        try {
            const winrar = this.getWinRARPath();
            const cmd = `"${winrar}" t -p- "${filePath}"`;
            await execAsync(cmd, { timeout: 10000 });
            return true;
        } catch {
            return false;
        }
    }

    /**
     * 测试文件是否为 7z 格式 (使用7z测试)
     */
    private async test7zFormat(filePath: string): Promise<boolean> {
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve(false);
            }, 30000);
            
            try {
                const stream = seven.list(filePath, {
                    $bin: this.get7zBinPath(),
                    password: this.extractPassword
                });
                
                stream.on('end', () => {
                    clearTimeout(timeout);
                    resolve(true);
                });
                
                stream.on('error', () => {
                    clearTimeout(timeout);
                    resolve(false);
                });
            } catch {
                clearTimeout(timeout);
                resolve(false);
            }
        });
    }

    /**
     * 递归解压所有压缩包 - 扁平化结构,所有extract都在游戏根目录
     */
    private async recursiveExtract(dir: string, gameInfo: GameInfo, depth: number = 0): Promise<void> {
        if (depth > 20) {
            gameInfo.errors.push('解压层级过深(>20),可能存在循环引用');
            return;
        }
        
        console.log(`    🔍 扫描目录: ${path.basename(dir)} (层级 ${depth})`);
        
        // **关键**: 先执行改名逻辑,处理当前目录下的mkv/tif文件
        await this.renameArchiveFiles(dir);
        
        // 收集当前目录下所有需要解压的文件
        const filesToExtract: string[] = [];
        let subDirs: string[] = [];
        
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const filePath = path.join(dir, file);
            
            if (!fs.existsSync(filePath)) {
                continue;
            }
            
            const stat = fs.statSync(filePath);
            
            if (stat.isDirectory()) {
                // 跳过extract_目录,避免重复处理
                if (!file.startsWith('extract_')) {
                    subDirs.push(filePath);
                }
            } else {
                const ext = path.extname(file).toLowerCase();
                // 处理普通压缩包和分卷压缩包
                if (ext === '.7z' || ext === '.zip') {
                    filesToExtract.push(filePath);
                } else if (/\.\d{3}$/.test(file)) {
                    // 分卷压缩包: .001, .002, .003 等
                    // 只收集第一个分卷(.001)
                    if (/\.001$/.test(file)) {
                        filesToExtract.push(filePath);
                    }
                }
            }
        }
        
        // 单线程顺序解压每个文件 - 全部解压到游戏根目录
        for (const filePath of filesToExtract) {
            const fileName = path.basename(filePath);
            const ext = path.extname(filePath).toLowerCase();
            
            // **扁平化**: 所有解压目录都创建在游戏根目录,使用全局计数器
            this.extractCounter++;
            const extractDirName = `extract_${String(this.extractCounter).padStart(3, '0')}`;
            const extractDir = path.join(gameInfo.sourcePath, extractDirName);
            
            if (!fs.existsSync(extractDir)) {
                fs.mkdirSync(extractDir, { recursive: true });
            }
            
            try {
                console.log(`    📂 解压: ${fileName} -> ${extractDirName}`);
                
                // 根据扩展名选择不同的解压工具
                if (ext === '.7z') {
                    // 7z文件使用7z解压(带密码)
                    await this.extract7z(filePath, extractDir, gameInfo);
                } else if (ext === '.zip') {
                    // zip文件使用WinRAR解压(无密码)
                    await this.extractZip(filePath, extractDir, gameInfo);
                } else if (/\.001$/.test(fileName)) {
                    // 分卷压缩包(.001)使用7z解压(带密码)
                    await this.extract7z(filePath, extractDir, gameInfo);
                }
                
                // 不删除原压缩包
                console.log(`    ✅ 解压完成: ${fileName}`);
                
            } catch (error) {
                console.log(`    ❌ 觐压失败: ${fileName} - ${error.message}`);
                gameInfo.errors.push(`解压失败 ${fileName}: ${error.message}`);
                
                // 如果解压失败,删除空的解压目录
                if (fs.existsSync(extractDir)) {
                    const extractFiles = fs.readdirSync(extractDir);
                    if (extractFiles.length === 0) {
                        fs.rmdirSync(extractDir);
                    }
                }
            }
            
            // 添加小延迟,避免系统压力
            await this.sleep(500);
        }
        
        // 重新获取子目录列表(过滤extract_目录)
        subDirs = fs.readdirSync(dir)
            .filter(f => {
                const fullPath = path.join(dir, f);
                return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory() && !f.startsWith('extract_');
            })
            .map(f => path.join(dir, f));
        
        // 递归扫描所有子目录,找到所有压缩包
        for (const subDir of subDirs) {
            await this.recursiveExtract(subDir, gameInfo, depth + 1);
        }
    }

    /**
     * 延迟函数
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * 测试文件是否为有效的压缩包
     */
    private async testArchive(filePath: string): Promise<boolean> {
        const fileName = path.basename(filePath);
        console.log(`      🧪 测试文件: ${fileName}`);
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                console.log(`      ⏱️  测试超时: ${fileName}`);
                resolve(false);
            }, 30000); // 30秒超时
            
            try {
                const stream = seven.list(filePath, {
                    $bin: this.get7zBinPath()
                });
                
                stream.on('end', () => {
                    clearTimeout(timeout);
                    console.log(`      ✅ 是压缩包: ${fileName}`);
                    resolve(true);
                });
                
                stream.on('error', () => {
                    clearTimeout(timeout);
                    console.log(`      ❌ 不是压缩包: ${fileName}`);
                    resolve(false);
                });
            } catch (error) {
                clearTimeout(timeout);
                console.log(`      ❌ 测试失败: ${fileName} - ${error.message}`);
                resolve(false);
            }
        });
    }

    /**
     * 使用 WinRAR 解压 ZIP 文件
     */
    private async extractZip(filePath: string, extractDir: string, gameInfo: GameInfo): Promise<void> {
        const winrar = this.getWinRARPath();
        const cmd = `"${winrar}" e -o+ -p- "${filePath}" "${extractDir}\"`;
        
        try {
            await execAsync(cmd, { timeout: 300000 });
        } catch (error) {
            throw new Error(`WinRAR解压失败: ${error.message}`);
        }
    }

    /**
     * 使用 7z 解压 7Z 文件(带密码)
     */
    private async extract7z(filePath: string, extractDir: string, gameInfo: GameInfo): Promise<void> {
        return new Promise((resolve, reject) => {
            const stream = seven.extractFull(filePath, extractDir, {
                $bin: this.get7zBinPath(),
                password: this.extractPassword
            });
            
            stream.on('end', () => {
                resolve();
            });
            
            stream.on('error', (err: Error) => {
                reject(err);
            });
        });
    }

    /**
     * 递归解压直到找到游戏文件
     * 聚焦刚解压出来的目录,只检查它内部的压缩包
     */
    private async extractUntilGameFound(startDir: string, gameInfo: GameInfo): Promise<void> {
        // 检查当前目录是否已有游戏文件
        const hasGame = await this.containsGameFiles(startDir);
        if (hasGame) {
            console.log(`  🎯 起始目录已包含游戏文件`);
            return;
        }
        
        // **关键**: 先执行改名逻辑,处理tif/tif文件
        await this.renameArchiveFiles(startDir);
        
        // 查找当前目录下的压缩包
        const archives = await this.findArchivesInDir(startDir);
        
        if (archives.length === 0) {
            console.log(`  ⚠️  未找到压缩包`);
            return;
        }
        
        console.log(`  📦 找到 ${archives.length} 个压缩包`);
        
        // 逐个解压
        for (const archivePath of archives) {
            const fileName = path.basename(archivePath);
            const ext = path.extname(archivePath).toLowerCase();
            
            this.extractCounter++;
            const extractDirName = `extract_${String(this.extractCounter).padStart(3, '0')}`;
            const extractDir = path.join(gameInfo.sourcePath, extractDirName);
            
            if (!fs.existsSync(extractDir)) {
                fs.mkdirSync(extractDir, { recursive: true });
            }
            
            try {
                console.log(`    📂 解压: ${fileName} -> ${extractDirName}`);
                
                if (ext === '.7z') {
                    await this.extract7z(archivePath, extractDir, gameInfo);
                } else if (ext === '.zip') {
                    await this.extractZip(archivePath, extractDir, gameInfo);
                } else if (/\.001$/.test(fileName)) {
                    await this.extract7z(archivePath, extractDir, gameInfo);
                }
                
                console.log(`    ✅ 解压完成: ${fileName}`);
                
                // **关键**: 解压后立即改名,处理tif等伪装文件
                console.log(`    🔄 对 ${extractDirName} 执行改名...`);
                await this.renameArchiveFiles(extractDir);
                
                // 聚焦检查: 先检查extractDir本身是否有游戏文件
                const hasGameInExtract = await this.containsGameFiles(extractDir);
                if (hasGameInExtract) {
                    console.log(`    🎯 在 ${extractDirName} 中找到游戏文件,停止解压`);
                    return;
                }
                
                // 查找extractDir下的压缩包(改名后可能有新的7z/zip)
                const newArchives = await this.findArchivesInDir(extractDir);
                if (newArchives.length > 0) {
                    console.log(`    📦 在 ${extractDirName} 中发现 ${newArchives.length} 个新压缩包`);
                    // 递归处理这些新压缩包
                    for (const newArchive of newArchives) {
                        const newFileName = path.basename(newArchive);
                        const newExt = path.extname(newArchive).toLowerCase();
                        
                        this.extractCounter++;
                        const newExtractDirName = `extract_${String(this.extractCounter).padStart(3, '0')}`;
                        const newExtractDir = path.join(gameInfo.sourcePath, newExtractDirName);
                        
                        if (!fs.existsSync(newExtractDir)) {
                            fs.mkdirSync(newExtractDir, { recursive: true });
                        }
                        
                        try {
                            console.log(`    📂 解压: ${newFileName} -> ${newExtractDirName}`);
                            
                            if (newExt === '.7z') {
                                await this.extract7z(newArchive, newExtractDir, gameInfo);
                            } else if (newExt === '.zip') {
                                await this.extractZip(newArchive, newExtractDir, gameInfo);
                            } else if (/\.001$/.test(newFileName)) {
                                await this.extract7z(newArchive, newExtractDir, gameInfo);
                            }
                            
                            console.log(`    ✅ 解压完成: ${newFileName}`);
                            
                            // 递归检查新解压的目录
                            console.log(`    🔍 聚焦检查: ${newExtractDirName}`);
                            await this.extractUntilGameFound(newExtractDir, gameInfo);
                            
                            // 检查是否找到游戏
                            const foundGame = await this.containsGameFiles(gameInfo.sourcePath);
                            if (foundGame) {
                                console.log(`    🎯 找到游戏文件,停止解压`);
                                return;
                            }
                        } catch (error) {
                            console.log(`    ❌ 解压失败: ${newFileName} - ${error.message}`);
                            gameInfo.errors.push(`解压失败 ${newFileName}: ${error.message}`);
                        }
                        
                        await this.sleep(500);
                    }
                }
                
                // 查找extractDir下的子目录,递归检查每个子目录
                const subDirs = fs.readdirSync(extractDir)
                    .filter(f => {
                        const fullPath = path.join(extractDir, f);
                        return fs.existsSync(fullPath) && fs.statSync(fullPath).isDirectory();
                    });
                
                for (const subDir of subDirs) {
                    const subDirPath = path.join(extractDir, subDir);
                    console.log(`    🔍 检查子目录: ${subDir}`);
                    await this.extractUntilGameFound(subDirPath, gameInfo);
                    
                    // 检查是否已找到游戏文件
                    const foundGame = await this.containsGameFiles(extractDir);
                    if (foundGame) {
                        console.log(`    🎯 在 ${extractDirName} 中找到游戏文件,停止解压`);
                        return;
                    }
                }
                
            } catch (error) {
                console.log(`    ❌ 解压失败: ${fileName} - ${error.message}`);
                gameInfo.errors.push(`解压失败 ${fileName}: ${error.message}`);
                
                if (fs.existsSync(extractDir)) {
                    const extractFiles = fs.readdirSync(extractDir);
                    if (extractFiles.length === 0) {
                        fs.rmdirSync(extractDir);
                    }
                }
            }
            
            await this.sleep(500);
        }
    }

    /**
     * 查找目录下的压缩包(不递归)
     */
    private async findArchivesInDir(dir: string): Promise<string[]> {
        const archives: string[] = [];
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
            const filePath = path.join(dir, file);
            
            if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
                continue;
            }
            
            const ext = path.extname(file).toLowerCase();
            if (ext === '.7z' || ext === '.zip') {
                archives.push(filePath);
            } else if (/\.001$/.test(file)) {
                archives.push(filePath);
            }
        }
        
        return archives;
    }

    /**
     * 查找所有压缩包(递归扫描所有目录,包括extract_)
     */
    private async findAllArchives(dir: string): Promise<string[]> {
        const archives: string[] = [];
        
        const scanDirectory = (currentDir: string) => {
            const files = fs.readdirSync(currentDir);
            
            for (const file of files) {
                const filePath = path.join(currentDir, file);
                
                if (!fs.existsSync(filePath)) {
                    continue;
                }
                
                const stat = fs.statSync(filePath);
                
                if (stat.isDirectory()) {
                    // 递归扫描所有子目录(包括extract_)
                    scanDirectory(filePath);
                } else {
                    const ext = path.extname(file).toLowerCase();
                    // 收集压缩包
                    if (ext === '.7z' || ext === '.zip') {
                        archives.push(filePath);
                    } else if (/\.001$/.test(file)) {
                        // 分卷只收集.001
                        archives.push(filePath);
                    }
                }
            }
        };
        
        scanDirectory(dir);
        return archives;
    }

    /**
     * 检查目录是否包含游戏文件(exe/apk)
     */
    private async containsGameFiles(dir: string): Promise<boolean> {
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
            const filePath = path.join(dir, file);
            
            if (!fs.existsSync(filePath)) {
                continue;
            }
            
            const stat = fs.statSync(filePath);
            
            if (stat.isDirectory()) {
                // 递归检查子目录
                const hasGame = await this.containsGameFiles(filePath);
                if (hasGame) return true;
            } else {
                const ext = path.extname(file).toLowerCase();
                const fileName = file.toLowerCase();
                
                if (ext === '.exe' || fileName.endsWith('.apk')) {
                    return true;
                }
            }
        }
        
        return false;
    }

    /**
     * 查找所有游戏目录(PC和APK)
     */
    private async findAllGameDirs(dir: string, gameInfo: GameInfo, depth: number = 0): Promise<{path: string, type: string}[]> {
        if (depth > 20) {
            return [];
        }
        
        const results: {path: string, type: string}[] = [];
        const files = fs.readdirSync(dir);
        
        // 检查当前目录是否包含 exe 或 apk
        let hasExe = false;
        let hasApk = false;
        
        for (const file of files) {
            const filePath = path.join(dir, file);
            
            if (!fs.existsSync(filePath)) {
                continue;
            }
            
            const ext = path.extname(file).toLowerCase();
            const fileName = file.toLowerCase();
            
            if (ext === '.exe') {
                hasExe = true;
            }
            if (fileName.endsWith('.apk')) {
                hasApk = true;
            }
        }
        
        // 如果当前目录有exe或apk,记录
        if (hasExe) {
            console.log(`    🎯 找到PC游戏文件`);
            results.push({ path: dir, type: 'PC' });
        }
        if (hasApk) {
            console.log(`    🎯 找到APK游戏文件`);
            results.push({ path: dir, type: 'APK' });
        }
        
        // 如果当前目录已经是游戏目录,不再递归子目录
        if (results.length > 0) {
            return results;
        }
        
        // 递归查找子目录
        for (const file of files) {
            const filePath = path.join(dir, file);
            
            if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
                const subResults = await this.findAllGameDirs(filePath, gameInfo, depth + 1);
                results.push(...subResults);
            }
        }
        
        return results;
    }

    /**
     * 删除免费游戏网站.txt文件
     */
    private async removeFreeGameFile(dir: string, gameInfo: GameInfo): Promise<void> {
        const files = fs.readdirSync(dir);
        
        for (const file of files) {
            const filePath = path.join(dir, file);
            
            if (fs.statSync(filePath).isDirectory()) {
                // 递归处理子目录
                await this.removeFreeGameFile(filePath, gameInfo);
            } else if (file === '免费游戏网站.txt') {
                try {
                    fs.unlinkSync(filePath);
                    console.log(`    🗑️  删除: ${file}`);
                } catch (error) {
                    gameInfo.errors.push(`删除文件失败 ${file}: ${error.message}`);
                }
            }
        }
    }

    /**
     * 移动游戏文件到整理目录
     */
    private async moveGameFiles(sourceDir: string, targetDir: string, gameInfo: GameInfo): Promise<void> {
        const files = fs.readdirSync(sourceDir);
        
        for (const file of files) {
            const sourcePath = path.join(sourceDir, file);
            const targetPath = path.join(targetDir, file);
            
            try {
                if (fs.statSync(sourcePath).isDirectory()) {
                    // 递归移动目录
                    await this.moveDirectory(sourcePath, targetPath);
                } else {
                    // 移动文件
                    fs.renameSync(sourcePath, targetPath);
                }
            } catch (error) {
                gameInfo.errors.push(`移动失败 ${file}: ${error.message}`);
            }
        }
    }

    /**
     * 递归移动目录
     */
    private async moveDirectory(sourceDir: string, targetDir: string): Promise<void> {
        if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
        }
        
        const files = fs.readdirSync(sourceDir);
        
        for (const file of files) {
            const sourcePath = path.join(sourceDir, file);
            const targetPath = path.join(targetDir, file);
            
            if (fs.statSync(sourcePath).isDirectory()) {
                await this.moveDirectory(sourcePath, targetPath);
            } else {
                fs.renameSync(sourcePath, targetPath);
            }
        }
        
        // 移动完成后删除空目录
        try {
            fs.rmdirSync(sourceDir);
        } catch (error) {
            // 忽略删除失败
        }
    }

    /**
     * 压缩游戏目录为 zip
     */
    private async zipGame(gameInfo: GameInfo): Promise<void> {
        // 动态导入archiver
        const archiver = (await import('archiver')).default;
        
        const zipPath = path.join(this.zipDir, `${gameInfo.name}.zip`);
        const organizedGameDir = path.join(this.organizedDir, gameInfo.name);
        
        // 检查整理目录是否存在
        if (!fs.existsSync(organizedGameDir)) {
            console.log(`  ⚠️  整理目录不存在,跳过压缩`);
            return;
        }
        
        return new Promise((resolve, reject) => {
            const output = fs.createWriteStream(zipPath);
            const archive = archiver('zip', {
                zlib: { level: 9 } // 最大压缩
            });
            
            output.on('close', () => {
                console.log(`  ✅ 压缩完成: ${gameInfo.name}.zip (${archive.pointer()} bytes)`);
                resolve();
            });
            
            archive.on('error', (err: Error) => {
                reject(err);
            });
            
            archive.pipe(output);
            archive.directory(organizedGameDir, gameInfo.name);
            archive.finalize();
        });
    }

    /**
     * 获取 WinRAR 可执行文件路径
     */
    private getWinRARPath(): string {
        const possiblePaths = [
            'C:\\user\\WinRAR\\WinRAR.exe',
            'C:\\Program Files\\WinRAR\\WinRAR.exe',
            'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe'
        ];
        
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                console.log(`  🔧 使用 WinRAR: ${p}`);
                return p;
            }
        }
        
        return 'C:\\user\\WinRAR\\WinRAR.exe';
    }

    /**
     * 获取 7z 可执行文件路径
     */
    private get7zBinPath(): string {
        const possiblePaths = [
            'C:\\rely\\7-Zip\\7z.exe',
            'C:\\Program Files\\7-Zip\\7z.exe',
            'C:\\Program Files (x86)\\7-Zip\\7z.exe'
        ];
        
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                console.log(`  🔧 使用 7z: ${p}`);
                return p;
            }
        }
        
        return 'C:\\rely\\7-Zip\\7z.exe';
    }

    /**
     * 输出处理结果
     */
    private printResults(results: GameInfo[]): void {
        console.log('\n' + '='.repeat(60));
        console.log('📊 整理完成报告');
        console.log('='.repeat(60));
        
        let successCount = 0;
        let errorCount = 0;
        
        for (const result of results) {
            if (result.errors.length === 0) {
                successCount++;
                console.log(`✅ ${result.name}`);
            } else {
                errorCount++;
                console.log(`❌ ${result.name}`);
                for (const error of result.errors) {
                    console.log(`   ⚠️  ${error}`);
                }
            }
        }
        
        console.log('\n' + '-'.repeat(60));
        console.log(`总计: ${results.length} 个游戏`);
        console.log(`成功: ${successCount} 个`);
        console.log(`失败: ${errorCount} 个`);
        console.log('='.repeat(60));
    }
}

export default GameOrganize;

