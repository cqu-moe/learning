import type { Command } from 'commander';
import { aggregateCourses, CourseSchema, createLearningClient, LearningError } from '@learning/sdk';
import type { Course, CourseRef, Json, OutlineNode } from '@learning/sdk/public';
import { listProfiles } from '../profiles.js';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import type { CliRuntime } from '../context.js';

function cacheKey(key: string): string { return `cli:course:${key}`; }
export function resourceCacheKey(key: string): string { return `cli:resource:${key}`; }
export function resourceKindCacheKey(key: string): string { return `cli:resource-kind:${key}`; }

async function cacheCourses(runtime: CliRuntime, courses: Course[]): Promise<void> {
  for (const course of courses) {
    const key = cacheKey(course.ref.key);
    const existing = await runtime.state.get(key);
    const ok = await runtime.state.commit({
      expected: [{ key, revision: existing?.revision ?? null }],
      changes: [{ key, value: course as unknown as Json }],
    });
    if (!ok) throw new LearningError({ code: 'CONFLICT', message: 'course cache changed concurrently', retryAfterMs: null, operationId: null });
  }
}

function formatOutline(nodes: OutlineNode[], indent = ''): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${indent}${node.title}`);
    for (const resource of node.resources) lines.push(`${indent}  ${resource.kind}\t${resource.title}\t${resource.ref.key}`);
    lines.push(...formatOutline(node.children, `${indent}  `));
  }
  return lines;
}

async function cacheResources(runtime: CliRuntime, nodes: OutlineNode[]): Promise<void> {
  for (const node of nodes) {
    for (const resource of node.resources) {
      const key = resourceCacheKey(resource.ref.key);
      const kindKey = resourceKindCacheKey(resource.ref.key);
      const existing = await runtime.state.get(key);
      const existingKind = await runtime.state.get(kindKey);
      const ok = await runtime.state.commit({ expected: [{ key, revision: existing?.revision ?? null }, { key: kindKey, revision: existingKind?.revision ?? null }], changes: [{ key, value: resource.ref as unknown as Json }, { key: kindKey, value: resource.kind }] });
      if (!ok) throw new LearningError({ code: 'CONFLICT', message: 'resource cache changed concurrently', retryAfterMs: null, operationId: null });
    }
    await cacheResources(runtime, node.children);
  }
}

export function registerCatalogCommands(program: Command): void {
  const courses = program.command('courses').description('list courses for local profiles').option('--all-profiles', 'query every configured profile');
  courses.action(async () => {
    await withCliRuntime(program, true, async (runtime) => {
      if (courses.opts<{ allProfiles?: boolean }>().allProfiles) {
        const profiles = await listProfiles(runtime.state);
        if (profiles.length === 0) {
          process.stderr.write('learning: no profiles configured\n');
          process.exitCode = 3;
          return;
        }
        const clients = profiles.map((profile) => createLearningClient({ scope: profile.scope, runtime }));
        try {
          const results = await aggregateCourses(clients);
          for (const result of results) if ('page' in result) await cacheCourses(runtime, result.page.items);
          if (results.some((result) => 'error' in result)) process.exitCode = 4;
          printResult(program, { results }, results.map((result, i) => 'page' in result
            ? `${profiles[i]?.name}: ${result.page.items.length} courses (${result.page.completeness})`
            : `${profiles[i]?.name}: ${result.error.message}`).join('\n'));
        } finally {
          await Promise.all(clients.map((client) => client.close()));
        }
        return;
      }
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const page = await client.catalog.courses();
        await cacheCourses(runtime, page.items);
        printResult(program, page, page.items.map((course) => `${course.title}\t${course.ref.key}`).join('\n'));
      } finally {
        await client.close();
      }
    });
  });

  program.command('outline <course-url-or-key>').description('show the course outline and resource keys').action(async (input: string) => {
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        let ref: CourseRef;
        if (/^https?:\/\//i.test(input)) {
          ref = await client.catalog.resolveCourse(input);
        } else {
          const stored = await runtime.state.get(cacheKey(input));
          if (stored === null) {
            process.stderr.write('learning: unknown course key; run learning courses first\n');
            process.exitCode = 2;
            return;
          }
          const course = CourseSchema.parse(stored.value);
          if (course.ref.scope.profileId !== profile.scope.profileId) {
            process.stderr.write('learning: course belongs to a different profile\n');
            process.exitCode = 2;
            return;
          }
          ref = course.ref;
        }
        const result = await client.catalog.outline(ref);
        await cacheResources(runtime, result.value.roots);
        printResult(program, result, formatOutline(result.value.roots).join('\n'));
      } finally {
        await client.close();
      }
    });
  });
}
