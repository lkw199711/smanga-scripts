import { spawn } from 'node:child_process';
import path from 'node:path';
import type { InterpretedTransferResult, TransferPlanItem } from './types.js';

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface JsonObject {
  [key: string]: unknown;
}

export class BdpanCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BdpanCommandError';
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number') return String(value);
  return null;
}

export function parseJsonOutput(output: string): unknown {
  const trimmed = output.trim();
  if (!trimmed) throw new BdpanCommandError('bdpan 没有返回 JSON');
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    const objectStart = trimmed.indexOf('{');
    const arrayStart = trimmed.indexOf('[');
    const candidates = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b);
    for (const start of candidates) {
      try {
        return JSON.parse(trimmed.slice(start)) as unknown;
      } catch {
        // Try the next possible JSON start.
      }
    }
    throw new BdpanCommandError('无法解析 bdpan JSON 输出');
  }
}

export function interpretTransferResult(value: unknown): InterpretedTransferResult {
  const result = asObject(value);
  if (!result) throw new BdpanCommandError('bdpan 返回结果不是 JSON 对象');

  const errno = typeof result.errno === 'number' ? result.errno : Number(result.errno ?? 0);
  if (Number.isFinite(errno) && errno !== 0) {
    const message = stringValue(result.message) ?? stringValue(result.error) ?? `errno=${errno}`;
    throw new BdpanCommandError(message);
  }

  const status = stringValue(result.status)?.toLowerCase() ?? '';
  const taskId = stringValue(result.task_id) ?? stringValue(result.taskid);
  if (status === 'submitted' || (taskId && !Array.isArray(result.files))) {
    return { status: 'submitted', taskId, savedPaths: [], items: [] };
  }

  const savedPaths = new Set<string>();
  const items: InterpretedTransferResult['items'] = [];
  if (Array.isArray(result.files)) {
    for (const file of result.files) {
      const item = asObject(file);
      if (!item) continue;
      const savedPath = stringValue(item.saved_path) ?? stringValue(item.path) ?? stringValue(item.remote_path);
      if (savedPath) savedPaths.add(savedPath);
      const remotePath = stringValue(item.path) ?? stringValue(item.remote_path);
      if (!remotePath) continue;
      const name = stringValue(item.name) ?? stringValue(item.server_filename) ?? path.posix.basename(remotePath);
      items.push({
        name: name ?? path.posix.basename(remotePath),
        path: remotePath,
        saved_path: stringValue(item.saved_path),
        is_dir: item.is_dir === true || item.isdir === true || item.isdir === 1 || item.is_dir === 1,
      });
    }
  }

  if (items.length > 0 || savedPaths.size > 0 || ['completed', 'complete', 'success', 'succeeded', 'done'].includes(status)) {
    return { status: 'completed', taskId, savedPaths: [...savedPaths], items };
  }

  throw new BdpanCommandError('bdpan 返回内容无法确认转存已经提交或完成');
}

export function redactSensitiveText(text: string, item: TransferPlanItem): string {
  let redacted = text.replaceAll(item.share_url, '[分享链接已隐藏]');
  if (item.share_code) redacted = redacted.replaceAll(item.share_code, '[提取码已隐藏]');
  return redacted.trim();
}

export class BdpanClient {
  constructor(
    private readonly binary: string,
    private readonly timeoutMs = 5 * 60_000,
  ) {}

  async assertLoggedIn(): Promise<void> {
    const result = await this.run(['whoami']);
    if (!/(?:已登录|logged\s*in)/iu.test(`${result.stdout}\n${result.stderr}`)) {
      throw new BdpanCommandError('bdpan 当前未登录，请先运行官方 login.sh');
    }
  }

  async transfer(item: TransferPlanItem): Promise<InterpretedTransferResult> {
    const args = ['transfer', item.share_url];
    if (item.share_code) args.push('-p', item.share_code);
    args.push('-d', item.transfer_dir, '--json');

    try {
      const result = await this.run(args);
      return interpretTransferResult(parseJsonOutput(result.stdout));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new BdpanCommandError(redactSensitiveText(message, item));
    }
  }

  async normalizeTransferredItems(item: TransferPlanItem, transferredItems: InterpretedTransferResult['items']): Promise<string[]> {
    if (transferredItems.length === 0) {
      throw new BdpanCommandError('转存已完成，但返回结果没有可用于整理的文件路径');
    }

    const expectedParent = `/apps/bdpan/${item.transfer_dir}`;
    for (const transferred of transferredItems) {
      const parent = path.posix.dirname(transferred.path);
      if (parent !== expectedParent && parent !== item.transfer_dir) {
        throw new BdpanCommandError(`拒绝整理预期目录之外的返回路径：${parent}`);
      }
    }

    const finalName = path.posix.basename(item.target_dir);
    if (transferredItems.length === 1 && transferredItems[0]?.is_dir) {
      const source = transferredItems[0];
      if (source.name !== finalName) {
        await this.run(['rename', source.path, finalName, '--json']);
      }
      return [path.posix.join(path.posix.dirname(source.path), finalName)];
    }

    await this.run(['mkdir', item.target_dir, '--json']);
    const finalPaths: string[] = [];
    for (const transferred of transferredItems) {
      await this.run(['mv', transferred.path, item.target_dir, '--json']);
      finalPaths.push(path.posix.join('/apps/bdpan', item.target_dir, transferred.name));
    }
    return finalPaths;
  }

  private run(args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, args, {
        env: process.env,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const maxOutput = 5 * 1024 * 1024;

      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new BdpanCommandError(`bdpan 命令超过 ${this.timeoutMs}ms 未完成`));
      }, this.timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
        if (stdout.length > maxOutput) child.kill('SIGTERM');
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > maxOutput) child.kill('SIGTERM');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new BdpanCommandError(`无法启动 bdpan：${error.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (stdout.length > maxOutput || stderr.length > maxOutput) {
          reject(new BdpanCommandError('bdpan 输出超过安全上限'));
        } else if (code !== 0) {
          reject(new BdpanCommandError(stderr.trim() || stdout.trim() || `bdpan 退出码 ${String(code)}`));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  }
}
