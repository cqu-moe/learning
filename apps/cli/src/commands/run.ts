import { CliError, getOutput } from '../output.js';
import { createPrompts, confirmAction, askDefaults } from '../prompts.js';
import type { PromptField } from '../prompts.js';
import { isWizard } from '../wizard.js';
import type { Command } from 'commander';
import { CourseSchema, ResourceRefSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { CourseRef, OutlineNode, ResourceRef } from '@learning/sdk/public';
import { printResult, selectProfile, withCliRuntime, unwrapResult, executeAction } from '../context.js';
import { resourceCacheKey, chooseTarget } from './catalog.js';
import { runJobForeground } from '../foreground.js';

function studyResources(nodes: OutlineNode[], includeDocuments: boolean): ResourceRef[] {
  return nodes.flatMap((node) => [
    ...node.resources.filter((resource) => resource.kind === 'video' || includeDocuments && resource.kind === 'document').map((resource) => resource.ref),
    ...studyResources(node.children, includeDocuments),
  ]);
}

export function registerRunCommands(program: Command): void {
  const run = program.command('run [course-or-resource]')
    .description('前台运行学习任务，Ctrl+C 保存暂停状态')
    .option('--speed <number>', '倍速，仍受平台上限约束', '1')
    .option('--target <fraction>', '目标进度，大于 0、不超过 1', '1')
    .option('--dry-run', '只读进度并展示预览，不发送学习心跳')
    .option('--yes', '确认启动此学习任务');
  run.action(async (key?: string) => {
    if (key === undefined && !getOutput(program).mode.interactive) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
    const options = run.opts<{ speed: string; target: string; dryRun?: boolean; yes?: boolean }>();
    let speed = Number(options.speed);
    let targetFraction = Number(options.target);
    if (!Number.isFinite(speed) || speed < 1 || speed > 5 || !Number.isFinite(targetFraction) || targetFraction <= 0 || targetFraction > 1) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'speed must be 1..5 and target must be within (0,1]', retryAfterMs: null, operationId: null });
    }
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile.scope.platform !== 'zhs' && !Number.isSafeInteger(speed)) throw new LearningError({ code: 'INVALID_INPUT', message: 'Yuketang and Xuetang speed must be an integer', retryAfterMs: null, operationId: null });
      if (profile.scope.platform === 'zhs' && speed > 1.5) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS speed cannot exceed 1.5', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        key ??= await chooseTarget(client, runtime, createPrompts(getOutput(program).mode), profile.scope.platform === 'ykt' ? ['video', 'document'] : ['video']);
        run.processedArgs[0] = key;
        const cachedResource = await runtime.state.get(resourceCacheKey(key));
        let resources: ResourceRef[];
        if (cachedResource !== null) resources = [ResourceRefSchema.parse(cachedResource.value)];
        else {
          let course: CourseRef;
          if (/^https:\/\//i.test(key)) course = await client.catalog.resolveCourse(key);
          else {
            const cachedCourse = await runtime.state.get(`cli:course:${key}`);
            if (cachedCourse === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown course or resource; run courses and outline first', retryAfterMs: null, operationId: null });
            course = CourseSchema.parse(cachedCourse.value).ref;
          }
          if (course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'course belongs to another profile', retryAfterMs: null, operationId: null });
          resources = studyResources(unwrapResult(program, await client.catalog.outline(course)).roots, profile.scope.platform === 'ykt');
        }
        if (resources.length === 0 || resources.some((resource) => resource.course.scope.profileId !== profile.scope.profileId)) {
          throw new LearningError({ code: 'INVALID_INPUT', message: 'no study resources in this profile were selected', retryAfterMs: null, operationId: null });
        }
        if (profile.scope.platform === 'zhs' && resources.some((resource) => resource.native.kind === 'zhs-hike') && speed > 1.25) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS hike speed cannot exceed 1.25', retryAfterMs: null, operationId: null });
        const maxSpeed = profile.scope.platform === 'zhs' ? resources.some(resource => resource.native.kind === 'zhs-hike') ? 1.25 : 1.5 : 5;
        const settingFields: PromptField[] = [
          { name: 'speed', message: `倍速（1–${maxSpeed}）`, initialValue: String(maxSpeed), validate: value => Number(value) >= 1 && Number(value) <= maxSpeed && (profile.scope.platform === 'zhs' || Number.isInteger(Number(value))) ? undefined : '请输入当前平台允许的倍速。' },
          { name: 'target', message: '目标进度（大于 0、不超过 1）', initialValue: '1', validate: value => Number(value) > 0 && Number(value) <= 1 ? undefined : '请输入有效的目标进度。' },
        ];
        const explicit = run.getOptionValueSource('speed') === 'cli' || run.getOptionValueSource('target') === 'cli';
        if (isWizard(program) && !explicit) {
          const preset = String(await createPrompts(getOutput(program).mode).ask({ name: 'preset', message: '学习配置', options: [
            { value: 'default', label: `默认 — 倍速 ${maxSpeed}，刷完整门课` },
            { value: 'custom', label: '自定义 — 选择倍速和目标进度' },
          ], initialValue: 'default' }));
          if (preset === 'custom') await askDefaults(run, settingFields, true);
          else { run.setOptionValueWithSource('speed', String(maxSpeed), 'prompt'); run.setOptionValueWithSource('target', '1', 'prompt'); }
        } else {
          await askDefaults(run, settingFields, isWizard(program));
          if (!explicit) run.setOptionValueWithSource('speed', String(maxSpeed), 'default');
        }
        speed = Number(run.opts<{ speed: string }>().speed); targetFraction = Number(run.opts<{ target: string }>().target);
        getOutput(program).activity(`正在核对 ${resources.length} 个资源的服务器进度，请稍候…`);
        const preview = await client.actions.prepare({ kind: 'study', resources, settings: { speed, targetFraction, questionMode: 'pause', maxDurationSeconds: 24 * 60 * 60 } });
        const summary = `账号：${profile.name}\n学习 ${resources.length} 个资源，倍速 ${speed}，目标 ${targetFraction * 100}%\n${resources.map(resource => resource.key).join('\n')}`;
        if (options.dryRun) { getOutput(program).set(preview, summary, 'preview'); return; }
        if (!options.yes) getOutput(program).set(preview, '', 'preview');
        await confirmAction(program, summary, options.yes);
        const execution = await executeAction(getOutput(program), client, preview.id);
        if (execution.type !== 'job') throw new LearningError({ code: 'INTEGRITY', message: 'study action did not create a job', retryAfterMs: null, operationId: null });
        const job = await runJobForeground(client, runtime, execution.job.id);
        if (job.status === 'uncertain') process.exitCode = 5;
        else if (job.status === 'partial') process.exitCode = 4;
        else if (job.status !== 'succeeded') process.exitCode = 3;
        const reasons = job.items.filter((item) => item.state === 'needs-input' && item.message !== null).map((item) => item.key + ': ' + item.message);
        printResult(program, job, [job.id + ': ' + job.status + ' (' + job.completed + '/' + (job.total ?? '?') + ')', ...reasons].join('\n'));
      } finally { await client.close(); }
    });
  });
}
