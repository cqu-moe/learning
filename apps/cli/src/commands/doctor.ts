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
    const fontPath = process.env.LEARNING_REFERENCE_FONT;
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
      font: fontPath && existsSync(fontPath) ? 'unavailable (reference corpus supplied; Canvas decoder is not implemented)' : 'unavailable (reference corpus and Canvas decoder are not configured)',
      browser: browserPath && existsSync(browserPath) ? 'configured but legacy slide browser handler is unavailable' : 'not configured (legacy slide handler unavailable)',
      ffprobe,
      model: process.env.LEARNING_MODEL_BASE_URL && process.env.LEARNING_MODEL_NAME && process.env.LEARNING_MODEL_API_KEY
        ? 'configured (requests only on explicit AI commands)'
        : 'not configured (set LEARNING_MODEL_BASE_URL, LEARNING_MODEL_NAME and LEARNING_MODEL_API_KEY)',
    };
    printResult(program, status, [
      runtime === 'Bun' ? `运行时：Bun ${runtimeVersion}` : `Node：${status.node}`,
      `数据目录：${status.home}`,
      `已初始化：${status.initialized ? '是' : '否，请运行 learning init'}`,
      `写入锁：${status.writerLock ? '存在' : '无'}`,
      'PDF：可用',
      `字体：${fontPath && existsSync(fontPath) ? '已提供参考字库；Canvas 解码器尚未实现' : '未配置参考字库；Canvas 解码器尚未实现'}`,
      `浏览器：${browserPath && existsSync(browserPath) ? '已配置路径，旧课件处理尚未实现' : '未配置，旧课件处理尚未实现'}`,
      `ffprobe：${ffprobe.available ? `可用（${ffprobe.version}）` : '未安装（仅影响缺失视频时长兜底）'}`,
      `模型：${status.model.startsWith('configured') ? '已配置，仅在明确请求时调用' : '未配置，仍可使用普通查询和手工草稿'}`,
    ].join('\n'));
  });
}
