import GameOrganize from './game-organize.js';
import path from 'path';
import fs from 'fs';

async function main() {
    const cliArgs = process.argv.slice(2);
    const sourceDir = (cliArgs[0] === '--' ? cliArgs[1] : cliArgs[0]) ?? process.env.GAME_SOURCE_DIR;

    if (!sourceDir) {
        console.error('用法: pnpm start -- <游戏源目录>');
        console.error('或设置环境变量 GAME_SOURCE_DIR');
        process.exit(1);
    }

    const gamesDir = path.resolve(sourceDir);
    
    // 检查目录是否存在
    if (!fs.existsSync(gamesDir)) {
        console.error('❌ games目录不存在:', gamesDir);
        process.exit(1);
    }
    
    console.log('🎮 游戏整理工具');
    console.log('源目录:', gamesDir);
    console.log('');
    
    const organizer = new GameOrganize(gamesDir);
    
    try {
        await organizer.execute();
    } catch (error: unknown) {
        const reason = error instanceof Error ? error : new Error(String(error));
        console.error('❌ 整理失败:', reason.message);
        console.error(reason.stack);
        process.exit(1);
    }
}

main();
