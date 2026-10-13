import type { Command } from 'commander';
import { LearningError } from '@learning/sdk';
import { ensureDataDir, resolveDataDir } from '../data-dir.js';
import { printResult } from '../context.js';
import { getOutput } from '../output.js';
import { disableTelemetry, telemetryStatus, writeTelemetryPreference } from '../telemetry.js';

export function registerTelemetryCommand(program: Command): void {
  const telemetry = program.command('telemetry').description('查看或设置匿名使用统计');
  telemetry.command('status').description('查看遥测状态，不显示采集令牌').action(() => {
    const status = telemetryStatus(resolveDataDir(program.opts<{ home?: string }>().home));
    const reasons = { persistent: '已通过本地偏好关闭', environment: '已通过环境变量关闭', automatic: '开发、测试或 CI 环境自动关闭', configuration: '遥测配置不可用', active: '默认开启，可运行 learning telemetry off 关闭' };
    printResult(program, status, `匿名使用统计：${status.enabled ? '开启' : '关闭'}（${reasons[status.reason]}）。`);
  });
  telemetry.command('off').description('持久关闭匿名使用统计').action(() => {
    const dataDir = ensureDataDir(program.opts<{ home?: string }>().home);
    try {
      writeTelemetryPreference(dataDir, false);
      disableTelemetry(getOutput(program));
      printResult(program, { enabled: false, reason: 'persistent' }, '已关闭匿名使用统计。');
    } catch {
      throw new LearningError({ code: 'STORAGE', message: '无法保存遥测偏好。', retryAfterMs: null, operationId: null });
    }
  });
  telemetry.command('on').description('持久开启匿名使用统计').action(() => {
    const dataDir = ensureDataDir(program.opts<{ home?: string }>().home);
    try {
      writeTelemetryPreference(dataDir, true);
      printResult(program, { enabled: true, reason: 'persistent' }, '已开启匿名使用统计。');
    } catch {
      throw new LearningError({ code: 'STORAGE', message: '无法保存遥测偏好。', retryAfterMs: null, operationId: null });
    }
  });
}
