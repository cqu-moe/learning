import type { Command } from 'commander';
import { resolveDataDir } from '../data-dir.js';
import { printResult } from '../context.js';
import { telemetryStatus } from '../telemetry.js';

export function registerTelemetryCommand(program: Command): void {
  const telemetry = program.command('telemetry').description('查看匿名使用统计状态');
  telemetry.command('status').description('查看遥测状态，不显示采集令牌').action(() => {
    const status = telemetryStatus(resolveDataDir(program.opts<{ home?: string }>().home));
    printResult(program, status);
  });
}
