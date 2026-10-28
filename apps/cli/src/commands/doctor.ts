import type { Command } from 'commander';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { printResult } from '../context.js';
import { resolveDataDir } from '../data-dir.js';

type FfprobeStatus = { available: true; version: string } | { available: false; version: null };

function checkFfprobe(): Promise<FfprobeStatus> {
  return new Promise(resolveStatus => {
    execFile('ffprobe', ['-version'], { timeout: 1000, maxBuffer: 16 * 1024, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      const version = /^ffprobe version (\S+)/m.exec(String(stdout))?.[1];
      resolveStatus(error || !version ? { available: false, version: null } : { available: true, version });
    });
  });
}

export function registerDoctorCommand(program: Command): void {
  program.command('doctor').description('检查本地配置与依赖，不自动安装').action(async () => {
    const home = resolveDataDir(program.opts<{ home?: string }>().home);
    const browserPath = process.env.LEARNING_BROWSER_PATH;
    const ffprobe = await checkFfprobe();
    const bun = (globalThis as { Bun?: { version?: unknown } }).Bun;
    const runtime = bun ? 'Bun' : 'Node';
    const runtimeVersion = bun?.version === undefined ? process.version : String(bun.version);
    const status = {
      node: process.version,
      runtime,
      runtimeVersion,
      home,
      initialized: existsSync(resolve(home, 'master.key')) && existsSync(resolve(home, 'state.db')),
      writerLock: existsSync(resolve(home, 'learning.lock')),
      pdf: 'available',
      font: 'available (reference font is verified and cached automatically on first use)',
      browser: browserPath && existsSync(browserPath) ? 'configured but legacy slide browser handler is unavailable' : 'not configured (legacy slide handler unavailable)',
      ffprobe,
      model: process.env.LEARNING_MODEL_BASE_URL && process.env.LEARNING_MODEL_NAME && process.env.LEARNING_MODEL_API_KEY
        ? 'configured (requests only on explicit AI commands)'
        : 'not configured (set LEARNING_MODEL_BASE_URL, LEARNING_MODEL_NAME and LEARNING_MODEL_API_KEY)',
    };
    printResult(program, status);
  });
}
