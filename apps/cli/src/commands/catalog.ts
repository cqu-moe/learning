import { CliError, getOutput, formatTable } from '../output.js';
import { createPrompts } from '../prompts.js';
import type { Prompts } from '../prompts.js';
import type { LearningClient, ResourceRef, ResourceKind, Resource } from '@learning/sdk';
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

function formatOutline(nodes: OutlineNode[], indent = ''): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    lines.push(`${indent}${node.title}`);
    for (const resource of node.resources) lines.push(`${indent}  ${resource.kind}\t${resource.title}\t${resource.ref.key}`);
    lines.push(...formatOutline(node.children, `${indent}  `));
  }
  return lines;
}

export async function cacheResources(runtime: CliRuntime, nodes: OutlineNode[]): Promise<void> {
  for (const node of nodes) {
    for (const resource of node.resources) {
      const key = resourceCacheKey(resource.ref.key);
      const kindKey = resourceKindCacheKey(resource.ref.key);
      const titleKey = resourceTitleCacheKey(resource.ref.key);
      const existing = await runtime.state.get(key);
      const existingKind = await runtime.state.get(kindKey);
      const existingTitle = await runtime.state.get(titleKey);
      const ok = await runtime.state.commit({ expected: [{ key, revision: existing?.revision ?? null }, { key: kindKey, revision: existingKind?.revision ?? null }, { key: titleKey, revision: existingTitle?.revision ?? null }], changes: [{ key, value: resource.ref as unknown as Json }, { key: kindKey, value: resource.kind }, { key: titleKey, value: resource.title }] });
      if (!ok) throw new LearningError({ code: 'CONFLICT', message: 'resource cache changed concurrently', retryAfterMs: null, operationId: null });
    }
    await cacheResources(runtime, node.children);
  }
}

export function registerCatalogCommands(program: Command): void {
  const courses = program.command('courses').description('列出课程').option('--all-profiles', '查询所有已配置账号');
  courses.action(async () => {
    await withCliRuntime(program, true, async (runtime) => {
      if (courses.opts<{ allProfiles?: boolean }>().allProfiles) {
        const profiles = await listProfiles(runtime.state);
        if (profiles.length === 0) {
          throw new CliError('INTERACTION_REQUIRED', 'no profiles configured', 3);
        }
        const clients = profiles.map((profile) => createLearningClient({ scope: profile.scope, runtime }));
        try {
          const results = await aggregateCourses(clients);
          for (const result of results) if ('page' in result) { await cacheCourses(runtime, result.page.items); for (const warning of result.page.warnings) getOutput(program).recordWarning(warning.code, warning.message); }
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
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const page = await client.catalog.courses();
        await cacheCourses(runtime, page.items);
        printResult(program, page, formatTable(['课程', '平台', '课程 key'], page.items.map(course => [course.title, course.ref.scope.platform, course.ref.key])) + `\n列表完整性：${page.completeness}`);
      } finally {
        await client.close();
      }
    });
  });

  program.command('outline [course-url-or-key]').description('查看课程目录与资源 key').action(async (input?: string) => {
    if (input === undefined && !getOutput(program).mode.interactive) throw new CliError('INVALID_INPUT', '缺少课程 URL 或 key。', 2, ['course-url-or-key']);
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        let ref: CourseRef;
        if (input === undefined) ref = await chooseCourse(client, runtime, createPrompts(getOutput(program).mode));
        else if (/^https?:\/\//i.test(input)) {
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
        printResult(program, result, formatOutline(result.value.roots).join('\n'));
      } finally {
        await client.close();
      }
    });
  });
}

export async function chooseCourse(client: LearningClient, runtime: CliRuntime, prompts: Prompts): Promise<CourseRef> {
  if (!prompts.interactive) throw new CliError('INVALID_INPUT', '请提供课程 URL 或 key。', 2, ['course']);
  const courses: Course[] = [];
  let cursor: string | undefined;
  const cursors = new Set<string>();
  for (;;) {
    const page = await client.catalog.courses(cursor === undefined ? undefined : { cursor });
    for (const course of page.items) {
      if (course.ref.scope.profileId !== client.scope.profileId) throw new CliError('FORBIDDEN', '课程列表包含其他账号的数据。', 3);
      if (!courses.some(item => item.ref.key === course.ref.key)) courses.push(course);
    }
    for (const warning of page.warnings) runtime.output?.recordWarning(warning.code, warning.message);
    await cacheCourses(runtime, page.items);
    if (!courses.length && !page.nextCursor) throw new CliError('INTERACTION_REQUIRED', '没有可选择的课程，请检查账号登录状态。', 3);
    const more = page.completeness === 'more' && page.nextCursor !== null && !cursors.has(page.nextCursor);
    const labels = courses.map(course => {
      if (!prompts.guided) return `${course.title} · ${course.ref.scope.platform} · ${course.ref.key}`;
      const duplicate = courses.some(other => other !== course && other.title === course.title);
      return duplicate ? [course.title, course.term, course.teachers.join('、')].filter(Boolean).join(' · ') : course.title;
    });
    const selected = await prompts.ask({ name: 'course', message: page.completeness === 'unknown' ? prompts.guided ? '选择课程（部分课程暂未加载）' : '选择课程（列表完整性未知）' : '搜索并选择课程', options: [
      ...courses.map((course, index) => ({ value: course.ref.key, label: prompts.guided && labels.filter(label => label === labels[index]).length > 1 ? `${labels[index]}（${labels.slice(0, index + 1).filter(label => label === labels[index]).length}）` : labels[index]! })),
      ...(more ? [{ value: '__more__', label: '加载下一页课程' }] : []),
    ] });
    if (selected === '__more__' && more) { cursor = page.nextCursor!; cursors.add(cursor); continue; }
    const course = courses.find(course => course.ref.key === selected);
    if (!course) throw new CliError('INVALID_INPUT', '没有选中有效课程。');
    return course.ref;
  }
}
export async function chooseResource(client: LearningClient, runtime: CliRuntime, prompts: Prompts, kinds: ResourceKind[]): Promise<ResourceRef> {
  const course = await chooseCourse(client, runtime, prompts);
  const outline = await client.catalog.outline(course);
  for (const warning of outline.warnings) runtime.output?.recordWarning(warning.code, warning.message);
  await cacheResources(runtime, outline.value.roots);
  const flatten = (nodes: OutlineNode[]): Resource[] => nodes.flatMap(node => [...node.resources, ...flatten(node.children)]);
  const resources = flatten(outline.value.roots).filter(resource => kinds.includes(resource.kind) && resource.locked !== true);
  if (!resources.length) throw new CliError('UNSUPPORTED', '此课程没有符合操作要求的可用资源。', 3);
  const key = await prompts.ask({ name: 'resource', message: '选择资源', options: resources.map(resource => ({ value: resource.ref.key, label: `${resource.path.join(' / ')} / ${resource.title}${prompts.guided ? '' : ` · ${resource.ref.key}`}` })) });
  const resource = resources.find(resource => resource.ref.key === key);
  if (!resource || resource.ref.course.scope.profileId !== client.scope.profileId) throw new CliError('INVALID_INPUT', '没有选中当前账号的有效资源。');
  return resource.ref;
}

export async function chooseTarget(client: LearningClient, runtime: CliRuntime, prompts: Prompts, kinds: ResourceKind[]): Promise<string> {
  const range = await prompts.ask({ name: 'range', message: '选择操作范围', options: [{ value: 'course', label: '整门课程' }, { value: 'resource', label: '单个资源' }] });
  return range === 'course' ? (await chooseCourse(client, runtime, prompts)).key : (await chooseResource(client, runtime, prompts, kinds)).key;
}
