import type { Command } from 'commander';
import { createLearningClient, LearningError } from '@learning/sdk';
import type { AuthEvent } from '@learning/sdk/public';
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { printResult, selectProfile, withCliRuntime } from '../context.js';

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

async function displayQr(event: Extract<AuthEvent, { type: 'qr' }>, dataDir: string): Promise<string | null> {
  if (event.qr.type === 'text') {
    const qr = await import('qrcode');
    process.stderr.write(await qr.default.toString(event.qr.value, { type: 'terminal', small: true }));
    return null;
  }
  const path = resolve(dataDir, `login-qr-${randomUUID()}.png`);
  writeFileSync(path, Buffer.from(event.qr.base64, 'base64'), { flag: 'wx', mode: 0o600 });
  process.stderr.write(`Scan QR image: ${path}\n`);
  return path;
}

export function registerLoginCommands(program: Command): void {
  const login = program.command('login').description('QR login or import a local cookie array')
    .option('--import <file>', 'import a local cookie-array JSON file')
    .option('--variant <variant>', 'ZHS QR variant: default WeChat or native', 'default');
  login.action(async () => {
    await withCliRuntime(program, true, async (runtime, dataDir) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const file = login.opts<{ import?: string }>().import;
        if (file !== undefined) {
          const imported = await client.auth.importLegacy({ format: 'cookie-array', text: readCookieFile(file) });
          printResult(program, imported.value, `imported session for ${profile.name} (identity unverified)`);
          return;
        }
        const variant = login.opts<{ variant: string }>().variant;
        if (variant !== 'default' && variant !== 'native') throw new LearningError({ code: 'INVALID_INPUT', message: 'QR variant must be default or native', retryAfterMs: null, operationId: null });
        if (variant === 'native' && profile.scope.platform !== 'zhs') throw new LearningError({ code: 'UNSUPPORTED', message: 'native QR variant is only defined for ZHS', retryAfterMs: null, operationId: null });
        const flow = await client.auth.begin({ method: 'qr', variant });
        void flow.result.catch(() => {}); // handle rejection before the event consumer reaches result
        const onSignal = () => { void flow.cancel(); };
        process.once('SIGINT', onSignal);
        let qrPath: string | null = null;
        try {
          for await (const event of flow.events) {
            if (event.type === 'qr') {
              if (qrPath !== null) { try { unlinkSync(qrPath); } catch { /* already removed */ } }
              qrPath = await displayQr(event, dataDir);
            } else if (event.type === 'scanned' || event.type === 'exchanging') {
              process.stderr.write(`login: ${event.type}\n`);
            }
          }
          const session = await flow.result;
          printResult(program, session, `logged in ${profile.name}`);
        } finally {
          process.off('SIGINT', onSignal);
          if (qrPath !== null) { try { unlinkSync(qrPath); } catch { /* already removed */ } }
        }
      } finally {
        await client.close();
      }
    });
  });

  program.command('whoami').description('probe the selected platform session').action(async () => {
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
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
