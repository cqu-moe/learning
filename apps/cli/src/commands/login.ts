import { CliError, getOutput } from '../output.js';
import type { Command } from 'commander';
import type { LearningClient, SessionView } from '@learning/sdk';
import type { Output } from '../output.js';
import { createLearningClient, LearningError } from '@learning/sdk';
import { lstatSync, readFileSync, unlinkSync, openSync, closeSync, fstatSync, ftruncateSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { printResult, selectProfile, withCliRuntime, unwrapResult } from '../context.js';
import { trackWorkflowEvent, trackException } from '../telemetry.js';

function readCookieFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'cookie import must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
  }
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (error) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'cookie import is not JSON', retryAfterMs: null, operationId: null }, { cause: error });
  }
  if (!Array.isArray(parsed) || parsed.some((item) => item === null || typeof item !== 'object' ||
    typeof item.name !== 'string' || typeof item.value !== 'string' || typeof item.domain !== 'string' ||
    (item.path !== undefined && typeof item.path !== 'string') ||
    (item.secure !== undefined && typeof item.secure !== 'boolean') ||
    (item.httpOnly !== undefined && typeof item.httpOnly !== 'boolean') ||
    (item.expires !== undefined && item.expires !== null && typeof item.expires !== 'number') ||
    (item.sameSite !== undefined && !['Strict', 'Lax', 'None'].includes(item.sameSite)))) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'cookie import must be a cookie array', retryAfterMs: null, operationId: null });
  }
  return text;
}

export async function loginWithQr(client: LearningClient, output: Output, dataDir: string, options: { qrFile?: string; variant: string }): Promise<SessionView> {
  let qrPath: string | null = null;
  let descriptor: number | null = null;
  try {
    if (options.variant === 'native' && client.scope.platform !== 'zhs') throw new CliError('INVALID_INPUT', 'native 二维码仅用于智慧树。');
    const openQr = (path: string) => {
      try { descriptor = openSync(path, 'wx', 0o600); qrPath = path; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('CONFLICT', '二维码文件已存在，请指定一个新路径。', 3, [], [], null, { cause: error }); throw error; }
    };
    if (options.qrFile !== undefined) openQr(resolve(options.qrFile));
    const flow = await client.auth.begin({ method: 'qr', variant: options.variant as 'default' | 'native' });
    void flow.result.catch(() => {});
    let cancelError: unknown;
    const onSignal = () => { void flow.cancel().catch(error => { cancelError = error; }); };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    output.signal.addEventListener('abort', onSignal, { once: true });
    try {
      for await (const event of flow.events) {
        if (event.type === 'qr') {
          const qr = await import('qrcode');
          const extension = event.qr.type === 'text' ? 'png' : event.qr.type;
          if (descriptor === null) openQr(resolve(dataDir, `login-qr-${randomUUID()}.${extension}`));
          if (descriptor !== null) {
            const bytes = event.qr.type === 'text' ? await qr.default.toBuffer(event.qr.value, { type: 'png' }) : Buffer.from(event.qr.base64, 'base64');
            let offset = 0;
            while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
            ftruncateSync(descriptor, bytes.length);
          }
          await output.event({ type: 'auth', data: { stage: 'qr', generation: event.generation, expiresAtMs: event.expiresAtMs, qrPath } });
        } else {
          await output.event({ type: 'auth', data: { stage: event.type, generation: 'generation' in event ? event.generation : null, expiresAtMs: null, qrPath: null } });
        }
      }
      const session = await flow.result;
      if (cancelError) throw cancelError;
      trackWorkflowEvent(output, { event: 'login_completed', properties: { method: 'qr', variant: options.variant } });
      output.set(session);
      return session;
    } finally {
      process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
      output.signal.removeEventListener('abort', onSignal);
    }
  } finally {
    if (descriptor !== null) {
      const owned = fstatSync(descriptor);
      closeSync(descriptor);
      if (qrPath !== null) {
        try { const current = lstatSync(qrPath); if (current.ino === owned.ino && current.dev === owned.dev) unlinkSync(qrPath); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { trackException(output, error, { stage: 'login.qr.cleanup' }); await output.warning('QR_CLEANUP', `二维码文件无法清理，请手动检查：${qrPath}`); } }
      }
    }
  }
}

export function registerLoginCommands(program: Command): void {
  const login = program.command('login').description('扫码登录或导入本地 Cookie 文件')
    .option('--import <file>', '导入指定 Cookie 数组文件')
    .option('--qr-file <file>', '二维码图片的新文件路径；JSON 模式必填，JSONL 可自动生成')
    .option('--variant <variant>', '智慧树二维码：default 或 native', 'default');
  login.action(async () => {
    const output = getOutput(program);
    const options = login.opts<{ import?: string; qrFile?: string; variant: string }>();
    if (options.import !== undefined && options.qrFile !== undefined) throw new CliError('INVALID_INPUT', '--import 与 --qr-file 不能同时使用。');
    if (!['default', 'native'].includes(options.variant)) throw new CliError('INVALID_INPUT', '二维码类型必须为 default 或 native。');
    if (output.mode.format === 'json' && options.import === undefined && options.qrFile === undefined) throw new CliError('INTERACTION_REQUIRED', '扫码登录需要 --qr-file，或使用 --output-format jsonl 获取二维码文件事件。', 3, ['qr-file']);
    await withCliRuntime(program, true, async (runtime, dataDir) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        if (options.import !== undefined) {
          const imported = await client.auth.importLegacy({ format: 'cookie-array', text: readCookieFile(options.import) });
          printResult(program, unwrapResult(program, imported));
          trackWorkflowEvent(output, { event: 'login_completed', properties: { method: 'cookie_import' } });
          return;
        }
        await loginWithQr(client, output, dataDir, options);
      } finally { await client.close(); }
    });
  });

  program.command('whoami').description('核验当前账号登录状态').action(async () => {
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const probe = await client.auth.probe();
        printResult(program, probe);
      } finally {
        await client.close();
      }
    });
  });
}
