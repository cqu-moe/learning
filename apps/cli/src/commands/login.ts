import { CliError, getOutput } from '../output.js';
import { createPrompts } from '../prompts.js';
import { isWizard } from '../wizard.js';
import type { Command } from 'commander';
import { createLearningClient, LearningError } from '@learning/sdk';
import { lstatSync, readFileSync, unlinkSync, openSync, closeSync, fstatSync, ftruncateSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { printResult, selectProfile, withCliRuntime, unwrapResult } from '../context.js';
import { trackWorkflowEvent } from '../telemetry.js';

function readCookieFile(path: string): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'cookie import must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
  }
  const text = readFileSync(path, 'utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'cookie import is not JSON', retryAfterMs: null, operationId: null });
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

export function registerLoginCommands(program: Command): void {
  const login = program.command('login').description('扫码登录或导入本地 Cookie 文件')
    .option('--import <file>', '导入指定 Cookie 数组文件')
    .option('--qr-file <file>', '二维码图片的新文件路径；机器扫码模式必须明确指定')
    .option('--variant <variant>', '智慧树二维码：default 或 native', 'default');
  login.action(async () => {
    const output = getOutput(program);
    const options = login.opts<{ import?: string; qrFile?: string; variant: string }>();
    if (options.import !== undefined && options.qrFile !== undefined) throw new CliError('INVALID_INPUT', '--import 与 --qr-file 不能同时使用。');
    if (!['default', 'native'].includes(options.variant)) throw new CliError('INVALID_INPUT', '二维码类型必须为 default 或 native。');
    if (isWizard(program) && options.import === undefined && options.qrFile === undefined) {
      const prompts = createPrompts(output.mode);
      const method = await prompts.ask({ name: 'method', message: '选择登录方式', options: [{ value: 'qr', label: '扫描二维码' }, { value: 'import', label: '导入本地 Cookie 文件' }] });
      if (method === 'import') options.import = String(await prompts.ask({ name: 'file', message: 'Cookie 文件路径', validate: value => typeof value === 'string' && value.length > 0 ? undefined : '请输入文件路径。' }));
    }
    if (options.import !== undefined && login.getOptionValueSource('import') !== 'cli') login.setOptionValueWithSource('import', options.import, 'prompt');
    if (!output.mode.interactive && options.import === undefined && options.qrFile === undefined) throw new CliError('INTERACTION_REQUIRED', '扫码需要人工操作；自动化请明确使用 --import 或 --qr-file。', 3);
    await withCliRuntime(program, true, async (runtime, dataDir) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      let qrPath: string | null = null;
      let descriptor: number | null = null;
      try {
        if (options.import !== undefined) {
          const imported = await client.auth.importLegacy({ format: 'cookie-array', text: readCookieFile(options.import) });
          printResult(program, unwrapResult(program, imported), `已导入 ${profile.name} 的会话，身份尚未在线验证。`);
          trackWorkflowEvent(getOutput(program), { event: 'login_completed', properties: { method: 'cookie_import' } });
          return;
        }
        if (options.variant === 'native' && profile.scope.platform !== 'zhs') throw new CliError('INVALID_INPUT', 'native 二维码仅用于智慧树。');
        const openQr = (path: string) => {
          try { descriptor = openSync(path, 'wx', 0o600); qrPath = path; }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError('CONFLICT', '二维码文件已存在，请指定一个新路径。', 3); throw error; }
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
              let terminal: string | null = null;
              if (descriptor === null && output.mode.format === 'pretty' && output.mode.color && output.mode.interactive) {
                try {
                  const renderer = await import('../qr-terminal.js');
                  terminal = event.qr.type === 'text'
                    ? renderer.renderTextQrTerminal(event.qr.value)
                    : renderer.renderImageQrTerminal(Buffer.from(event.qr.base64, 'base64'));
                } catch {
                  terminal = null;
                }
              }
              if (terminal !== null) process.stderr.write(terminal);
              else {
                const extension = event.qr.type === 'text' ? 'png' : event.qr.type;
                if (descriptor === null) openQr(resolve(dataDir, `login-qr-${randomUUID()}.${extension}`));
                if (descriptor !== null) {
                  const bytes = event.qr.type === 'text' ? await qr.default.toBuffer(event.qr.value, { type: 'png' }) : Buffer.from(event.qr.base64, 'base64');
                  let offset = 0;
                  while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset, offset);
                  ftruncateSync(descriptor, bytes.length);
                  await output.message(`请扫描二维码图片：${qrPath}`);
                }
              }
              await output.event({ type: 'auth', data: { stage: 'qr', generation: event.generation, expiresAtMs: event.expiresAtMs, qrPath } });
            } else {
              await output.event({ type: 'auth', data: { stage: event.type, generation: 'generation' in event ? event.generation : null, expiresAtMs: null, qrPath: null } });
              if (event.type === 'scanned') await output.message('已扫码，请在官方应用确认。');
              if (event.type === 'exchanging') await output.message('正在完成登录。');
            }
          }
          const session = await flow.result;
          if (cancelError) throw cancelError;
          trackWorkflowEvent(getOutput(program), { event: 'login_completed', properties: { method: 'qr', variant: options.variant } });
          printResult(program, session, `已登录账号：${profile.name}`);
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
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') await output.warning('QR_CLEANUP', `二维码文件无法清理，请手动检查：${qrPath}`); }
          }
        }
        await client.close();
      }
    });
  });

  program.command('whoami').description('核验当前账号登录状态').action(async () => {
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const probe = await client.auth.probe();
        printResult(program, probe, `${profile.name}: ${probe.state}`);
      } finally {
        await client.close();
      }
    });
  });
}
