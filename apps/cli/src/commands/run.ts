import { CliError, getOutput } from '../output.js';
import { requireConfirmation } from '../input.js';
import type { Command } from 'commander';
import { CourseSchema, ResourceRefSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { CourseRef, OutlineNode, ResourceKind, ResourceRef } from '@learning/sdk/public';
import { printResult, selectProfile, withCliRuntime, unwrapResult, executeAction, inferTargetScope } from '../context.js';
import { courseCacheKey, resourceCacheKey, resourceKindCacheKey, cacheResources } from './catalog.js';
import { runJobForeground } from '../foreground.js';
import type { CliRuntime } from '../context.js';
import { trackWorkflowEvent } from '../telemetry.js';

type StudyResource = { kind: ResourceKind; ref: ResourceRef };

function studyResources(nodes: OutlineNode[], includeDocuments: boolean): StudyResource[] {
  return nodes.flatMap((node) => [
    ...node.resources.filter((resource) => resource.kind === 'video' || includeDocuments && resource.kind === 'document').map((resource) => ({ kind: resource.kind, ref: resource.ref })),
    ...studyResources(node.children, includeDocuments),
  ]);
}

async function cachedStudyResource(runtime: CliRuntime, key: string, profileId: string): Promise<StudyResource> {
  const stored = await runtime.state.get(resourceCacheKey(key));
  if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown resource key; run outline first', retryAfterMs: null, operationId: null });
  const ref = ResourceRefSchema.parse(stored.value);
  if (ref.course.scope.profileId !== profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'resource belongs to another profile', retryAfterMs: null, operationId: null });
  const savedKind = (await runtime.state.get(resourceKindCacheKey(key)))?.value;
  if (savedKind === 'homework' || savedKind === 'exam' || savedKind === 'discussion') throw new LearningError({ code: 'INVALID_INPUT', message: 'resource kind cannot be studied', retryAfterMs: null, operationId: null });
  const kind: ResourceKind = savedKind === 'video' || savedKind === 'document' ? savedKind : 'unknown';
  return { kind, ref };
}

export function registerRunCommands(program: Command): void {
  const run = program.command('run [course-or-resource]')
    .description('前台运行学习任务，Ctrl+C 保存暂停状态')
    .option('--resource <key>', '高级：只运行一个已缓存资源 key')
    .option('--speed <number>', '倍速，仍受平台上限约束', '1')
    .option('--target <fraction>', '目标进度，大于 0、不超过 1', '1')
    .option('--dry-run', '只读进度并展示预览，不发送学习心跳')
    .option('--yes', '确认启动此学习任务');
  run.action(async (key?: string) => {
    const options = run.opts<{ speed: string; target: string; resource?: string; dryRun?: boolean; yes?: boolean }>();
    const resourceKey = options.resource;
    if (key !== undefined && resourceKey !== undefined) throw new CliError('INVALID_INPUT', '课程参数和 --resource 只能选择一个。', 2, ['course-or-resource', 'resource']);
    if (key === undefined && resourceKey === undefined) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
    if (resourceKey !== undefined) await inferTargetScope(program, 'resource', resourceKey);
    requireConfirmation(program, options.yes, options.dryRun);
    const speed = Number(options.speed);
    const targetFraction = Number(options.target);
    if (!Number.isFinite(speed) || speed < 1 || speed > 5 || !Number.isFinite(targetFraction) || targetFraction <= 0 || targetFraction > 1) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'speed must be 1..5 and target must be within (0,1]', retryAfterMs: null, operationId: null });
    }
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile.scope.platform !== 'zhs' && !Number.isSafeInteger(speed)) throw new LearningError({ code: 'INVALID_INPUT', message: 'Yuketang and Xuetang speed must be an integer', retryAfterMs: null, operationId: null });
      if (profile.scope.platform === 'zhs' && speed > 1.5) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS speed cannot exceed 1.5', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        getOutput(program).assertActive();
        let scopeLabel: '整门课程' | '单个资源';
        let resources: StudyResource[];
        const selectedKey = resourceKey ?? key;
        const cachedResource = selectedKey === undefined ? null : await runtime.state.get(resourceCacheKey(selectedKey));
        if (selectedKey !== undefined && (resourceKey !== undefined || cachedResource !== null)) {
          const selected = await cachedStudyResource(runtime, selectedKey, profile.scope.profileId);
          scopeLabel = '单个资源';
          resources = [selected];
        } else {
          let course: CourseRef;
          if (key === undefined) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
          if (/^https:\/\//i.test(key)) course = await client.catalog.resolveCourse(key);
          else {
            const cachedCourse = await runtime.state.get(courseCacheKey(key));
            if (cachedCourse === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown course or resource; run courses and outline first', retryAfterMs: null, operationId: null });
            course = CourseSchema.parse(cachedCourse.value).ref;
          }
          if (course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'course belongs to another profile', retryAfterMs: null, operationId: null });
          scopeLabel = '整门课程';
          const outline = unwrapResult(program, await client.catalog.outline(course));
          await cacheResources(runtime, outline.roots);
          resources = studyResources(outline.roots, profile.scope.platform === 'ykt');
        }
        if (resources.length === 0 || resources.some((resource) => resource.ref.course.scope.profileId !== profile.scope.profileId)) {
          throw new LearningError({ code: 'INVALID_INPUT', message: 'no study resources in this profile were selected', retryAfterMs: null, operationId: null });
        }
        if (profile.scope.platform === 'zhs' && resources.some((resource) => resource.ref.native.kind === 'zhs-hike') && speed > 1.25) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS hike speed cannot exceed 1.25', retryAfterMs: null, operationId: null });
        const preview = await client.actions.prepare({ kind: 'study', resources: resources.map(resource => resource.ref), settings: { speed, targetFraction, questionMode: 'pause', maxDurationSeconds: 24 * 60 * 60 } }, { signal: getOutput(program).signal });
        const skippedKeys = new Set(preview.warnings.filter(warning => warning.code === 'SKIPPED_UNKNOWN_DURATION').map(warning => warning.resourceKey));
        const skippedCount = resources.filter(resource => skippedKeys.has(resource.ref.key)).length;
        getOutput(program).set(preview, 'preview');
        if (options.dryRun) {
          return;
        }
        const execution = await executeAction(getOutput(program), client, preview.id);
        if (execution.type !== 'job') throw new LearningError({ code: 'INTEGRITY', message: 'study action did not create a job', retryAfterMs: null, operationId: null });
        const job = await runJobForeground(client, runtime, execution.job.id);
        if (job.status === 'uncertain') process.exitCode = 5;
        else if (job.status === 'partial' || job.status === 'succeeded' && skippedCount > 0) process.exitCode = 4;
        else if (job.status !== 'succeeded') process.exitCode = 3;
        trackWorkflowEvent(getOutput(program), {
          event: 'learning_run_completed',
          properties: { status: job.status, scope: scopeLabel === '整门课程' ? 'course' : 'resource', resource_count: resources.length, skipped_resource_count: skippedCount, speed, target_fraction: targetFraction },
        });
        printResult(program, job);
      } finally { await client.close(); }
    });
  });
}
