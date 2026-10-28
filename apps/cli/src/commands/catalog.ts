import { CliError, getOutput } from '../output.js';
import type { Command } from 'commander';
import { aggregateCourses, CourseSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { Course, CourseRef, Json, OutlineNode } from '@learning/sdk/public';
import { listProfiles } from '../profiles.js';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import type { CliRuntime } from '../context.js';

export function courseCacheKey(key: string): string { return `cli:course:${key}`; }
export function resourceCacheKey(key: string): string { return `cli:resource:${key}`; }
export function resourceKindCacheKey(key: string): string { return `cli:resource-kind:${key}`; }
export function resourceTitleCacheKey(key: string): string { return `cli:resource-title:${key}`; }

export async function cacheCourses(runtime: CliRuntime, courses: Course[]): Promise<void> {
  for (const course of courses) {
    const key = courseCacheKey(course.ref.key);
    const existing = await runtime.state.get(key);
    const ok = await runtime.state.commit({
      expected: [{ key, revision: existing?.revision ?? null }],
      changes: [{ key, value: course as unknown as Json }],
    });
    if (!ok) throw new LearningError({ code: 'CONFLICT', message: 'course cache changed concurrently', retryAfterMs: null, operationId: null });
  }
}
export async function cacheResources(runtime: CliRuntime, nodes: OutlineNode[]): Promise<void> {
  for (const node of nodes) {
    for (const resource of node.resources) {
      const key = resourceCacheKey(resource.ref.key);
      const kindKey = resourceKindCacheKey(resource.ref.key);
      const titleKey = resourceTitleCacheKey(resource.ref.key);
      const pathKey = `cli:resource-path:${resource.ref.key}`;
      const existing = await runtime.state.get(key);
      const existingKind = await runtime.state.get(kindKey);
      const existingTitle = await runtime.state.get(titleKey);
      const existingPath = await runtime.state.get(pathKey);
      const ok = await runtime.state.commit({ expected: [{ key, revision: existing?.revision ?? null }, { key: kindKey, revision: existingKind?.revision ?? null }, { key: titleKey, revision: existingTitle?.revision ?? null }, { key: pathKey, revision: existingPath?.revision ?? null }], changes: [{ key, value: resource.ref as unknown as Json }, { key: kindKey, value: resource.kind }, { key: titleKey, value: resource.title }, { key: pathKey, value: resource.path }] });
      if (!ok) throw new LearningError({ code: 'CONFLICT', message: 'resource cache changed concurrently', retryAfterMs: null, operationId: null });
    }
    await cacheResources(runtime, node.children);
  }
}

export function registerCatalogCommands(program: Command): void {
  const courses = program.command('courses').description('列出课程')
    .option('--all-profiles', '查询所有已配置账号');
  courses.action(async () => {
    const options = courses.opts<{ allProfiles?: boolean }>();
    await withCliRuntime(program, true, async (runtime) => {
      if (options.allProfiles) {
        const profiles = await listProfiles(runtime.state);
        if (profiles.length === 0) {
          throw new CliError('INTERACTION_REQUIRED', 'no profiles configured', 3);
        }
        const clients = profiles.map((profile) => createLearningClient({ scope: profile.scope, runtime }));
        try {
          const results = await aggregateCourses(clients);
          for (const result of results) if ('page' in result) { await cacheCourses(runtime, result.page.items); for (const warning of result.page.warnings) getOutput(program).recordWarning(warning.code, warning.message); }
          if (results.some((result) => 'error' in result)) process.exitCode = 4;
          printResult(program, { results });
        } finally {
          await Promise.all(clients.map((client) => client.close()));
        }
        return;
      }
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const page = await client.catalog.courses();
        await cacheCourses(runtime, page.items);
        printResult(program, page);
      } finally {
        await client.close();
      }
    });
  });

  program.command('outline <course-url-or-key>').description('查看课程目录与资源 key').action(async (input?: string) => {
    if (input === undefined) throw new CliError('INVALID_INPUT', '缺少课程 URL 或 key。', 2, ['course-url-or-key']);
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        let ref: CourseRef;
        if (/^https?:\/\//i.test(input)) {
          ref = await client.catalog.resolveCourse(input);
        } else {
          const stored = await runtime.state.get(courseCacheKey(input));
          if (stored === null) {
            throw new CliError('INVALID_INPUT', 'unknown course key; run learning courses first', 2);
          }
          const course = CourseSchema.parse(stored.value);
          if (course.ref.scope.profileId !== profile.scope.profileId) {
            throw new CliError('INVALID_INPUT', 'course belongs to a different profile', 2);
          }
          ref = course.ref;
        }
        const result = await client.catalog.outline(ref);
        await cacheResources(runtime, result.value.roots);
        printResult(program, result);
      } finally {
        await client.close();
      }
    });
  });
}
