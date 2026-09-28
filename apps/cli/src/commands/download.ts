import { resolve } from 'node:path';
import { CliError, getOutput } from '../output.js';
import { createPrompts, askDefaults } from '../prompts.js';
import { isWizard } from '../wizard.js';
import { readPreferences, setJobOutputRoot } from '../preferences.js';
import type { Command } from 'commander';
import { CourseSchema, ResourceRefSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { AssessmentRef, CourseRef, ResourceRef, OutlineNode } from '@learning/sdk/public';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { resourceCacheKey, resourceKindCacheKey, chooseTarget } from './catalog.js';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';

const TYPES = new Set(['video', 'homework', 'exam']);
function flatten(nodes: OutlineNode[]): Array<{ kind: string; ref: ResourceRef }> {
  return nodes.flatMap((node) => [
    ...node.resources.map((resource) => ({ kind: resource.kind, ref: resource.ref })),
    ...flatten(node.children),
  ]);
}

export function registerDownloadCommands(program: Command): void {
  const download = program.command('download [course-or-resource]')
    .description('导出可读取的视频、作业和试卷')
    .option('--types <types>', '资源类型：video,homework,exam，逗号分隔', 'video,homework,exam')
    .option('--quality <quality>', '视频质量：best、hd 或 sd', 'best')
    .option('--subtitles', '同时导出可用字幕')
    .option('--output-dir <dir>', '导出目标根目录，每个任务使用唯一子目录')
    .option('--dry-run', '只查看导出计划，不下载');
  download.action(async (key?: string) => {
    if (key === undefined && !getOutput(program).mode.interactive) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
    await askDefaults(download, [
      { name: 'types', message: '资源类型，逗号分隔 video,homework,exam', initialValue: 'video,homework,exam', validate: value => { const kinds = String(value).split(',').map(kind => kind.trim()); return kinds.every(kind => TYPES.has(kind)) && new Set(kinds).size === kinds.length ? undefined : '请输入不重复的 video、homework 或 exam。'; } },
      { name: 'quality', message: '视频质量', options: ['best','hd','sd'].map(value => ({ value, label: value })) },
      { name: 'subtitles', message: '同时导出可用字幕？', confirm: true },
    ], isWizard(program));
    const options = download.opts<{ types: string; quality: string; subtitles?: boolean; dryRun?: boolean; outputDir?: string }>();
    const types = options.types.split(',').map((item) => item.trim());
    if (types.length === 0 || types.some((item) => !TYPES.has(item)) || new Set(types).size !== types.length) {
      throw new LearningError({ code: 'INVALID_INPUT', message: 'download types must be unique video,homework,exam values', retryAfterMs: null, operationId: null });
    }
    if (!['best', 'hd', 'sd'].includes(options.quality)) throw new LearningError({ code: 'INVALID_INPUT', message: 'quality must be best, hd or sd', retryAfterMs: null, operationId: null });
    await withCliRuntime(program, true, async (runtime, dataDir) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        key ??= await chooseTarget(client, runtime, createPrompts(getOutput(program).mode), ['video', 'homework', 'exam']);
        const outputRoot = resolve(options.outputDir ?? (await readPreferences(runtime.state)).downloadDir ?? resolve(dataDir, 'exports'));
        const cachedResource = await runtime.state.get(resourceCacheKey(key));
        let resources: Array<{ kind: string; ref: ResourceRef }>;
        if (cachedResource !== null) {
          const ref = ResourceRefSchema.parse(cachedResource.value);
          const savedKind = (await runtime.state.get(resourceKindCacheKey(key)))?.value;
          if (typeof savedKind === 'string') resources = types.includes(savedKind) ? [{ kind: savedKind, ref }] : [];
          else if (download.getOptionValueSource('types') === 'default') {
            throw new LearningError({ code: 'INVALID_INPUT', message: 'cached resource has no kind; pass --types explicitly', retryAfterMs: null, operationId: null });
          } else resources = types.map((kind) => ({ kind, ref }));
        } else {
          let course: CourseRef;
          if (/^https:\/\//i.test(key)) course = await client.catalog.resolveCourse(key);
          else {
            const cachedCourse = await runtime.state.get(`cli:course:${key}`);
            if (cachedCourse === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown course or resource; run courses and outline first', retryAfterMs: null, operationId: null });
            course = CourseSchema.parse(cachedCourse.value).ref;
          }
          if (course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'course belongs to another profile', retryAfterMs: null, operationId: null });
          resources = flatten((await client.catalog.outline(course)).value.roots).filter((item) => types.includes(item.kind));
        }
        if (resources.some((item) => item.ref.course.scope.profileId !== profile.scope.profileId)) throw new LearningError({ code: 'FORBIDDEN', message: 'resource belongs to another profile', retryAfterMs: null, operationId: null });
        const media = resources.filter((item) => item.kind === 'video').map((item) => item.ref);
        const assessments: AssessmentRef[] = [];
        for (const item of resources.filter((entry) => entry.kind === 'homework' || entry.kind === 'exam')) {
          assessments.push(...(await client.assessments.resolve(item.ref)).filter((ref) => ref.kind === item.kind));
        }
        if (media.length === 0 && assessments.length === 0) throw new LearningError({ code: 'UNSUPPORTED', message: 'no matching downloadable resources', retryAfterMs: null, operationId: null });
        if (options.dryRun) {
          const plan = { media: media.map((ref) => ref.key), assessments: assessments.map((ref) => ref.assessmentId) };
          getOutput(program).set(plan, `${plan.media.length} 个视频，${plan.assessments.length} 份作业/试卷`, 'preview');
          return;
        }
        const jobs = [];
        const files: string[] = [];
        if (media.length > 0) {
          const created = await client.jobs.createExport({ type: 'media', resources: media, quality: options.quality as 'best' | 'hd' | 'sd', subtitles: options.subtitles === true });
          await setJobOutputRoot(runtime.state, created.id, outputRoot);
          const job = await runJobForeground(client, runtime, created.id);
          jobs.push(job);
          files.push(...await publishJobArtifacts(runtime, job, dataDir));
        }
        if (assessments.length > 0) {
          const created = await client.jobs.createExport({ type: 'assessments', refs: assessments, format: 'json' });
          await setJobOutputRoot(runtime.state, created.id, outputRoot);
          const job = await runJobForeground(client, runtime, created.id);
          jobs.push(job);
          files.push(...await publishJobArtifacts(runtime, job, dataDir));
        }
        if (jobs.some((job) => job.status === 'uncertain')) process.exitCode = 5;
        else if (jobs.some((job) => job.status === 'partial')) process.exitCode = 4;
        else if (jobs.some((job) => job.status !== 'succeeded')) process.exitCode = 3;
        const result = jobs.length === 1 ? { job: jobs[0], files } : { jobs, files };
        printResult(program, result, `${jobs.map((job) => `${job.id}: ${job.status}`).join('\n')}\n${files.join('\n')}`);
      } finally { await client.close(); }
    });
  });
}
