import { CliError, getOutput } from '../output.js';
import { createPrompts, confirmAction, askDefaults } from '../prompts.js';
import { isWizard } from '../wizard.js';
import type { Command } from 'commander';
import { CourseSchema, ResourceRefSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { CourseRef, OutlineNode, ResourceRef } from '@learning/sdk/public';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
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
    .description('drive a study job in the foreground; Ctrl+C pauses persistently')
    .option('--speed <number>', 'playback speed 1..5', '1')
    .option('--target <fraction>', 'target progress fraction 0..1', '1')
    .option('--dry-run', 'read current progress and show a preview without heartbeat writes')
    .option('--yes', 'confirm this study job');
  run.action(async (key?: string) => {
    if (key === undefined && !getOutput(program).mode.interactive) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
    await askDefaults(run, [
      { name: 'speed', message: '倍速（仍受平台上限约束）', initialValue: '1', validate: value => Number(value) >= 1 && Number(value) <= 5 ? undefined : '请输入 1–5 之间的倍速。' },
      { name: 'target', message: '目标进度（0–1）', initialValue: '1', validate: value => Number(value) > 0 && Number(value) <= 1 ? undefined : '请输入大于 0、不超过 1 的进度。' },
    ], isWizard(program));
    const options = run.opts<{ speed: string; target: string; dryRun?: boolean; yes?: boolean }>();
    const speed = Number(options.speed);
    const targetFraction = Number(options.target);
    if (!Number.isFinite(speed) || speed < 1 || speed > 5 || !Number.isFinite(targetFraction) || targetFraction <= 0 || targetFraction > 1) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'speed must be 1..5 and target must be within (0,1]', retryAfterMs: null, operationId: null });
    }
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      if (profile.scope.platform !== 'zhs' && !Number.isSafeInteger(speed)) throw new LearningError({ code: 'INVALID_INPUT', message: 'Yuketang and Xuetang speed must be an integer', retryAfterMs: null, operationId: null });
      if (profile.scope.platform === 'zhs' && speed > 1.5) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS speed cannot exceed 1.5', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        key ??= await chooseTarget(client, runtime, createPrompts(getOutput(program).mode), profile.scope.platform === 'ykt' ? ['video', 'document'] : ['video']);
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
          resources = studyResources((await client.catalog.outline(course)).value.roots, profile.scope.platform === 'ykt');
        }
        if (resources.length === 0 || resources.some((resource) => resource.course.scope.profileId !== profile.scope.profileId)) {
          throw new LearningError({ code: 'INVALID_INPUT', message: 'no study resources in this profile were selected', retryAfterMs: null, operationId: null });
        }
        if (profile.scope.platform === 'zhs' && resources.some((resource) => resource.native.kind === 'zhs-hike') && speed > 1.25) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS hike speed cannot exceed 1.25', retryAfterMs: null, operationId: null });
        const preview = await client.actions.prepare({ kind: 'study', resources, settings: { speed, targetFraction, questionMode: 'pause', maxDurationSeconds: 24 * 60 * 60 } });
        const summary = `账号：${profile.name}\n学习 ${resources.length} 个资源，倍速 ${speed}，目标 ${targetFraction * 100}%\n${resources.map(resource => resource.key).join('\n')}`;
        if (options.dryRun) { getOutput(program).set(preview, summary, 'preview'); return; }
        if (!options.yes) getOutput(program).set(preview, '', 'preview');
        await confirmAction(program, summary, options.yes);
        const execution = await client.actions.execute(preview.id);
        if (execution.type !== 'job') throw new LearningError({ code: 'INTEGRITY', message: 'study action did not create a job', retryAfterMs: null, operationId: null });
        const job = await runJobForeground(client, runtime, execution.job.id);
        if (job.status === 'uncertain') process.exitCode = 5;
        else if (job.status === 'partial') process.exitCode = 4;
        else if (job.status !== 'succeeded') process.exitCode = 3;
        printResult(program, job, `${job.id}: ${job.status} (${job.completed}/${job.total ?? '?'})`);
      } finally { await client.close(); }
    });
  });
}
