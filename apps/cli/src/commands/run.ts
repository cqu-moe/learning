import type { Command } from 'commander';
import { CourseSchema, ResourceRefSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { CourseRef, OutlineNode, ResourceRef } from '@learning/sdk/public';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { resourceCacheKey } from './catalog.js';
import { runJobForeground } from '../foreground.js';

function videos(nodes: OutlineNode[]): ResourceRef[] {
  return nodes.flatMap((node) => [
    ...node.resources.filter((resource) => resource.kind === 'video').map((resource) => resource.ref),
    ...videos(node.children),
  ]);
}

export function registerRunCommands(program: Command): void {
  const run = program.command('run <course-or-resource>')
    .description('drive a study job in the foreground; Ctrl+C pauses persistently')
    .option('--speed <number>', 'playback speed 1..5', '1')
    .option('--target <fraction>', 'target progress fraction 0..1', '1')
    .option('--dry-run', 'read current progress and show a preview without heartbeat writes')
    .option('--yes', 'confirm this study job');
  run.action(async (key: string) => {
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
          resources = videos((await client.catalog.outline(course)).value.roots);
        }
        if (resources.length === 0 || resources.some((resource) => resource.course.scope.profileId !== profile.scope.profileId)) {
          throw new LearningError({ code: 'INVALID_INPUT', message: 'no videos in this profile were selected', retryAfterMs: null, operationId: null });
        }
        if (profile.scope.platform === 'zhs' && resources.some((resource) => resource.native.kind === 'zhs-hike') && speed > 1.25) throw new LearningError({ code: 'INVALID_INPUT', message: 'ZHS hike speed cannot exceed 1.25', retryAfterMs: null, operationId: null });
        const preview = await client.actions.prepare({ kind: 'study', resources, settings: { speed, targetFraction, questionMode: 'pause', maxDurationSeconds: 24 * 60 * 60 } });
        if (options.dryRun || !options.yes) {
          if (!options.dryRun) { process.stderr.write('learning: preview only; rerun with --yes to start\n'); process.exitCode = 3; }
          printResult(program, preview, `${resources.length} video(s) previewed at ${speed}x to ${targetFraction}`);
          return;
        }
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
