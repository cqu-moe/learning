import type { Command } from 'commander';
import { resolveDataDir } from '../data-dir.js';
import { printResult } from '../context.js';
import { telemetryStatus } from '../telemetry.js';

export function registerTelemetryCommand(program: Command): void {
  const telemetry = program.command('telemetry').description('查看匿名使用统计状态');
  telemetry.command('status').description('查看遥测状态，不显示采集令牌').action(() => {
    const status = telemetryStatus(resolveDataDir(program.opts<{ home?: string }>().home));
    const reasons = { automatic: '开发、测试或 CI 环境自动隔离', configuration: '遥测配置不可用', active: '匿名使用统计已启用' };
    printResult(program, status, `匿名使用统计：${status.enabled ? '开启' : '未发送'}（${reasons[status.reason]}）。`);
  });
}
