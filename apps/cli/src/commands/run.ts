import { CliError, getOutput, jobStates } from '../output.js';
import { createPrompts, confirmAction, askDefaults } from '../prompts.js';
import type { PromptField } from '../prompts.js';
import { isWizard } from '../wizard.js';
import type { Command } from 'commander';
import { CourseSchema, ResourceRefSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { CourseRef, OutlineNode, ResourceKind, ResourceRef } from '@learning/sdk/public';
import { printResult, selectProfile, withCliRuntime, unwrapResult, executeAction, inferTargetScope } from '../context.js';
import { courseCacheKey, resourceCacheKey, resourceKindCacheKey, resourceTitleCacheKey, chooseCourse, cacheResources } from './catalog.js';
import { runJobForeground } from '../foreground.js';
import type { CliRuntime } from '../context.js';

type StudyResource = { kind: ResourceKind; ref: ResourceRef; title: string };

function studyResources(nodes: OutlineNode[], includeDocuments: boolean): StudyResource[] {
  return nodes.flatMap((node) => [
    ...node.resources.filter((resource) => resource.kind === 'video' || includeDocuments && resource.kind === 'document').map((resource) => ({ kind: resource.kind, ref: resource.ref, title: resource.title })),
    ...studyResources(node.children, includeDocuments),
  ]);
}

async function courseTitle(runtime: CliRuntime, course: CourseRef): Promise<string> {
  const stored = await runtime.state.get(courseCacheKey(course.key));
  if (stored === null) return '课程名称暂不可用';
  const cached = CourseSchema.parse(stored.value);
  if (cached.ref.scope.profileId !== course.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'course belongs to another profile', retryAfterMs: null, operationId: null });
  return cached.title;
}

async function cachedStudyResource(runtime: CliRuntime, key: string, profileId: string): Promise<StudyResource> {
  const stored = await runtime.state.get(resourceCacheKey(key));
  if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown resource key; run outline first', retryAfterMs: null, operationId: null });
  const ref = ResourceRefSchema.parse(stored.value);
  if (ref.course.scope.profileId !== profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'resource belongs to another profile', retryAfterMs: null, operationId: null });
  const savedKind = (await runtime.state.get(resourceKindCacheKey(key)))?.value;
  if (savedKind === 'homework' || savedKind === 'exam' || savedKind === 'discussion') throw new LearningError({ code: 'INVALID_INPUT', message: 'resource kind cannot be studied', retryAfterMs: null, operationId: null });
  const kind: ResourceKind = savedKind === 'video' || savedKind === 'document' ? savedKind : 'unknown';
  const savedTitle = (await runtime.state.get(resourceTitleCacheKey(key)))?.value;
  return { kind, ref, title: typeof savedTitle === 'string' ? savedTitle : '未命名视频' };
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
    if (key === undefined && resourceKey === undefined && !getOutput(program).mode.interactive) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
    if (resourceKey !== undefined) await inferTargetScope(program, 'resource', resourceKey);
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
        let title: string;
        let scopeLabel: '整门课程' | '单个资源';
        let resources: StudyResource[];
        const selectedKey = resourceKey ?? key;
        const cachedResource = selectedKey === undefined ? null : await runtime.state.get(resourceCacheKey(selectedKey));
        if (selectedKey !== undefined && (resourceKey !== undefined || cachedResource !== null)) {
          const selected = await cachedStudyResource(runtime, selectedKey, profile.scope.profileId);
          title = await courseTitle(runtime, selected.ref.course);
          scopeLabel = '单个资源';
          resources = [selected];
        } else {
          let course: CourseRef;
          if (key === undefined) {
            course = await chooseCourse(client, runtime, createPrompts(getOutput(program).mode));
            run.processedArgs[0] = course.key;
          } else if (/^https:\/\//i.test(key)) course = await client.catalog.resolveCourse(key);
          else {
            const cachedCourse = await runtime.state.get(courseCacheKey(key));
            if (cachedCourse === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown course or resource; run courses and outline first', retryAfterMs: null, operationId: null });
            course = CourseSchema.parse(cachedCourse.value).ref;
          }
          if (course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'course belongs to another profile', retryAfterMs: null, operationId: null });
          title = await courseTitle(runtime, course);
          scopeLabel = '整门课程';
          const outline = unwrapResult(program, await client.catalog.outline(course));
          await cacheResources(runtime, outline.roots);
          resources = studyResources(outline.roots, profile.scope.platform === 'ykt');
        }
        if (resources.length === 0 || resources.some((resource) => resource.ref.course.scope.profileId !== profile.scope.profileId)) {
          throw new LearningError({ code: 'INVALID_INPUT', message: 'no study resources in this profile were selected', retryAfterMs: null, operationId: null });
        }
        if (profile.scope.platform === 'zhs' && resources.some((resource) => resource.ref.native.kind === 'zhs-hike') && speed > 1.25) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS hike speed cannot exceed 1.25', retryAfterMs: null, operationId: null });
        const maxSpeed = profile.scope.platform === 'zhs' ? resources.some(resource => resource.ref.native.kind === 'zhs-hike') ? 1.25 : 1.5 : 5;
        const settingFields: PromptField[] = [
          { name: 'speed', message: `倍速（1–${maxSpeed}）`, initialValue: String(maxSpeed), validate: value => Number(value) >= 1 && Number(value) <= maxSpeed && (profile.scope.platform === 'zhs' || Number.isInteger(Number(value))) ? undefined : '请输入当前平台允许的倍速。' },
          { name: 'target', message: '目标进度（大于 0、不超过 1）', initialValue: '1', validate: value => Number(value) > 0 && Number(value) <= 1 ? undefined : '请输入有效的目标进度。' },
        ];
        const explicit = run.getOptionValueSource('speed') === 'cli' || run.getOptionValueSource('target') === 'cli';
        if (isWizard(program) && !explicit) {
          const preset = String(await createPrompts(getOutput(program).mode).ask({ name: 'preset', message: '学习配置', options: [
            { value: 'default', label: `默认配置（${maxSpeed} 倍速，${scopeLabel === '整门课程' ? '刷完整门课' : '完成这个资源'}）` },
            { value: 'custom', label: '自定义倍速和目标进度' },
          ], initialValue: 'default' }));
          if (preset === 'custom') await askDefaults(run, settingFields, true);
          else { run.setOptionValueWithSource('speed', String(maxSpeed), 'prompt'); run.setOptionValueWithSource('target', '1', 'prompt'); }
        } else {
          await askDefaults(run, settingFields, isWizard(program));
          if (!explicit) run.setOptionValueWithSource('speed', String(maxSpeed), 'default');
        }
        speed = Number(run.opts<{ speed: string }>().speed); targetFraction = Number(run.opts<{ target: string }>().target);
        const videoCount = resources.filter(resource => resource.kind === 'video').length;
        const documentCount = resources.filter(resource => resource.kind === 'document').length;
        const otherCount = resources.length - videoCount - documentCount;
        getOutput(program).activity(`正在核对 ${resources.length} 个资源的学习进度…`);
        const preview = await client.actions.prepare({ kind: 'study', resources: resources.map(resource => resource.ref), settings: { speed, targetFraction, questionMode: 'pause', maxDurationSeconds: 24 * 60 * 60 } }, { signal: getOutput(program).signal });
        const skippedKeys = new Set(preview.warnings.filter(warning => warning.code === 'SKIPPED_UNKNOWN_DURATION').map(warning => warning.resourceKey));
        const skippedResources = resources.filter(resource => skippedKeys.has(resource.ref.key));
        const pendingSummary = skippedResources.length === 0 ? [] : [
          `暂不处理：${skippedResources.length} 个视频（未能读取时长）`,
          ...skippedResources.slice(0, 5).map(resource => `  · ${resource.title}`),
          ...(skippedResources.length > 5 ? [`  …另有 ${skippedResources.length - 5} 个`] : []),
          '请在官方网页播放后重试；这些视频尚未完成。',
        ];
        const summary = [
          `课程：${title}`,
          `账号：${profile.name}`,
          `范围：${scopeLabel}`,
          ...(videoCount > 0 ? [`视频：${videoCount} 个`] : []),
          ...(documentCount > 0 ? [`图文：${documentCount} 个`] : []),
          ...(otherCount > 0 ? [`其他资源：${otherCount} 个`] : []),
          `本次可处理：${resources.length - skippedResources.length} / ${resources.length} 个资源`,
          ...pendingSummary,
          `倍速：${speed}×`,
          `目标进度：${Number((targetFraction * 100).toFixed(1))}%`,
        ].join('\n');
        if (options.dryRun) { getOutput(program).set(preview, summary, 'preview'); return; }
        getOutput(program).set(preview, '', 'preview');
        await confirmAction(program, summary, options.yes);
        const execution = await executeAction(getOutput(program), client, preview.id);
        if (execution.type !== 'job') throw new LearningError({ code: 'INTEGRITY', message: 'study action did not create a job', retryAfterMs: null, operationId: null });
        const job = await runJobForeground(client, runtime, execution.job.id, { study: { courseTitle: title, profileName: profile.name, speed, targetFraction } });
        if (job.status === 'uncertain') process.exitCode = 5;
        else if (job.status === 'partial' || job.status === 'succeeded' && skippedResources.length > 0) process.exitCode = 4;
        else if (job.status !== 'succeeded') process.exitCode = 3;
        const reasons = [...new Set(job.items.flatMap((item) => item.state === 'needs-input' && item.message !== null ? [item.message] : []))];
        printResult(program, job, [
          `课程：${title}`,
          `状态：${jobStates[job.status] ?? job.status}（${job.completed}/${job.total ?? '?'}）`,
          `任务 ID：${job.id}`,
          ...pendingSummary,
          ...reasons,
        ].join('\n'));
      } finally { await client.close(); }
    });
  });
}
