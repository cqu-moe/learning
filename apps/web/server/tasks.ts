import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ServerResponse } from 'node:http';
import { z } from 'zod';
import { createLearningClient } from '@learning/sdk';
import { LocalHeavyRenderer } from '@learning/sdk/render-node';
import type { Runtime } from '@learning/sdk/node';
import { CourseSchema, ResourceSchema, LessonSchema } from '@learning/sdk/public';
import type { ExportInput, Job, Scope } from '@learning/sdk/public';
import { TaskInputSchema, JobDetailSchema, TaskPreviewSchema, JobControlInputSchema } from '../shared/contracts.ts';
import type { TaskPreview } from '../shared/contracts.ts';
import { HttpError, errorFrom } from './errors.ts';

type Client = ReturnType<typeof createLearningClient>;
type Profile = { name: string; scope: Scope };
type Pending = { view: TaskPreview; client: Client; exportInput?: ExportInput; actionId?: string; started?: Promise<Job> };
const runnable = (job: Job) => ['queued', 'running', 'waiting'].includes(job.status);
const sameScope = (a: Scope, b: Scope) => a.userId === b.userId && a.profileId === b.profileId && a.platform === b.platform;

export function createTaskService(options: {
  runtime: Runtime;
  lock(): () => void;
  profile(id: string): Promise<Profile>;
  job(id: string): Promise<{ job: Job; profile: Profile }>;
}) {
  const { runtime } = options;
  const pending = new Map<string, Pending>();
  const errors = new Map<string, string>();
  let active: { id: string | null; client: Client; stop: boolean; controller: AbortController; done: Promise<void> } | undefined;
  let closed = false;
  const clientFor = (scope: Scope) => createLearningClient({ scope, runtime: { ...runtime, heavy: new LocalHeavyRenderer({ artifacts: runtime.artifacts, scope }) } });

  async function courseFor(key: string) {
    const stored = await runtime.state.get(`cli:course:${key}`);
    if (!stored) throw new HttpError(404, 'NOT_FOUND', '请先同步课程。');
    const course = CourseSchema.parse(stored.value);
    const profile = await options.profile(course.ref.scope.profileId);
    if (!sameScope(course.ref.scope, profile.scope)) throw new HttpError(403, 'FORBIDDEN', '课程不属于该账号。');
    if (course.locked) throw new HttpError(409, 'CONFLICT', '课程尚未解锁。');
    return { course, profile };
  }

  async function lessons(courseKey: string, search: URLSearchParams) {
    if ([...search.keys()].some(key => key !== 'cursor') || search.getAll('cursor').length > 1 || search.get('cursor') === '') throw new HttpError(422, 'INVALID_INPUT', '分页参数无效。');
    const release = options.lock();
    let client: Client | undefined;
    try {
      const { course, profile } = await courseFor(courseKey);
      client = clientFor(profile.scope);
      const cursor = search.get('cursor');
      const page = await client.resources.lessons(course.ref, cursor === null ? undefined : { cursor });
      for (const lesson of page.items) {
        const key = `web:lesson:${courseKey}:${lesson.ref.lessonId}`;
        const old = await runtime.state.get(key);
        if (!await runtime.state.commit({ expected: [{ key, revision: old?.revision ?? null }], changes: [{ key, value: lesson }] })) throw new HttpError(409, 'CONFLICT', '课件列表已变化，请刷新。');
      }
      return page;
    } finally { try { await client?.close(); } finally { release(); } }
  }

  async function preview(raw: unknown): Promise<TaskPreview> {
    if (closed) throw new HttpError(503, 'UNAVAILABLE', '本地服务正在关闭。');
    const input = TaskInputSchema.parse(raw);
    const release = options.lock();
    let client: Client | undefined;
    try {
      for (const [id, item] of pending) if (item.view.expiresAtMs <= Date.now()) {
        if (!item.started) await item.client.close();
        pending.delete(id);
      }
      const { course, profile } = await courseFor(input.courseKey);
      client = clientFor(profile.scope);
      const view: TaskPreview = { id: randomUUID(), kind: input.kind, courseTitle: course.title, profileName: profile.name, items: [], settings: [], warnings: [], blockers: [], expiresAtMs: Date.now() + 600_000 };
      const entry: Pending = { view, client };
      if ('resourceKeys' in input) {
        if (new Set(input.resourceKeys).size !== input.resourceKeys.length) throw new HttpError(422, 'INVALID_INPUT', '资源不能重复选择。');
        const resources = await Promise.all(input.resourceKeys.map(async key => {
          const stored = await runtime.state.get(`web:resource:${key}`);
          if (!stored) throw new HttpError(409, 'PRECONDITION_CHANGED', '请先刷新课程目录，再选择资源。');
          const resource = ResourceSchema.parse(stored.value);
          if (resource.ref.key !== key || resource.ref.course.key !== course.ref.key || !sameScope(resource.ref.course.scope, profile.scope)) throw new HttpError(403, 'FORBIDDEN', '所选资源不属于该课程。');
          const kinds = input.kind === 'study' ? ['video', 'document'] : input.kind === 'media' ? ['video'] : ['homework'];
          if (resource.locked || !kinds.includes(resource.kind)) throw new HttpError(422, 'INVALID_INPUT', '所选资源尚未解锁或不支持该任务。');
          return resource;
        }));
        const refs = resources.map(item => item.ref);
        view.items = resources.map(item => item.title);
        if (input.kind === 'study') {
          const prepared = await client.actions.prepare({ kind: 'study', resources: refs, settings: { speed: input.speed, targetFraction: input.targetPercent / 100, questionMode: 'pause', maxDurationSeconds: input.maxMinutes * 60 } });
          entry.actionId = prepared.id;
          view.expiresAtMs = prepared.expiresAtMs;
          view.warnings = prepared.warnings.map(warning => warning.message);
          view.blockers = prepared.blockers;
          view.settings = [`${input.speed} 倍速`, `目标进度 ${input.targetPercent}%`, `最长 ${input.maxMinutes} 分钟`, '遇到题目或验证时暂停'];
        } else if (input.kind === 'media') {
          entry.exportInput = { type: 'media', resources: refs, quality: input.quality, subtitles: input.subtitles };
          view.settings = [`清晰度：${{ best: '最佳', hd: '高清', sd: '标清' }[input.quality]}`, input.subtitles ? '同时导出字幕' : '仅导出视频'];
        } else {
          const refs = (await Promise.all(resources.map(resource => client!.assessments.resolve(resource.ref)))).flat();
          if (!refs.length || refs.some(ref => ref.kind === 'exam')) throw new HttpError(422, 'INVALID_INPUT', '所选资源不包含可导出的普通作业。');
          entry.exportInput = { type: 'assessments', refs, format: input.format };
          view.settings = [`文件格式：${input.format}`, '只读取作业内容'];
        }
      } else {
        const ids = input.kind === 'live' ? [input.lessonId] : input.lessonIds;
        if (new Set(ids).size !== ids.length) throw new HttpError(422, 'INVALID_INPUT', '课堂不能重复选择。');
        const selected = await Promise.all(ids.map(async id => {
          const stored = await runtime.state.get(`web:lesson:${course.ref.key}:${id}`);
          if (!stored) throw new HttpError(409, 'PRECONDITION_CHANGED', '请先加载课堂列表，再选择课堂。');
          const lesson = LessonSchema.parse(stored.value);
          if (lesson.ref.lessonId !== id || lesson.ref.course?.key !== course.ref.key || !sameScope(lesson.ref.scope, profile.scope)) throw new HttpError(403, 'FORBIDDEN', '课堂不属于该课程。');
          return lesson;
        }));
        view.items = selected.map(item => item.title);
        if (input.kind === 'slides') {
          entry.exportInput = { type: 'slides', lessons: selected.map(item => item.ref), format: input.format, liveJobId: null };
          view.settings = [`文件格式：${input.format === 'pdf' ? 'PDF' : '图片'}`];
        } else {
          const prepared = await client.actions.prepare({ kind: 'live.join', lesson: selected[0]!.ref, maxDurationSeconds: input.maxMinutes * 60 });
          entry.actionId = prepared.id;
          view.expiresAtMs = prepared.expiresAtMs;
          view.warnings = ['加入课堂会产生签到记录。', ...prepared.warnings.map(warning => warning.message)];
          view.blockers = prepared.blockers;
          view.settings = [`最长 ${input.maxMinutes} 分钟`];
        }
      }
      if (closed) throw new HttpError(503, 'UNAVAILABLE', '本地服务正在关闭。');
      pending.set(view.id, entry);
      client = undefined;
      return TaskPreviewSchema.parse(view);
    } finally { try { await client?.close(); } finally { release(); } }
  }

  function launch(client: Client, initialize: (signal: AbortSignal) => Promise<Job>): Promise<Job> {
    if (closed) throw new HttpError(503, 'UNAVAILABLE', '本地服务正在关闭。');
    const release = options.lock();
    const owner = { id: null as string | null, client, stop: false, controller: new AbortController(), done: Promise.resolve() };
    active = owner;
    const started = initialize(owner.controller.signal);
    owner.done = (async () => {
      try {
        let job = await started;
        owner.id = job.id;
        errors.delete(job.id);
        while (runnable(job) && !owner.stop) {
          if (job.nextRunAtMs !== null && job.nextRunAtMs > Date.now()) {
            await new Promise(resolve => setTimeout(resolve, Math.min(job.nextRunAtMs! - Date.now(), 250)));
            job = await client.jobs.get(job.id);
          } else job = await client.jobs.advance(job.id, { signal: owner.controller.signal });
        }
        if (owner.stop && runnable(job)) await client.jobs.pause(job.id);
      } catch (error) {
        if (owner.id) errors.set(owner.id, errorFrom(error).message);
      } finally {
        try { await client.close(); } finally { if (active === owner) active = undefined; release(); }
      }
    })();
    void owner.done.catch(() => undefined);
    return started;
  }

  function start(id: string): Promise<Job> {
    const item = pending.get(id);
    if (!item) throw new HttpError(409, 'PRECONDITION_CHANGED', '预览已失效；请先检查任务中心，再重新预览。');
    if (item.started) return item.started;
    if (item.view.expiresAtMs <= Date.now()) throw new HttpError(409, 'PRECONDITION_CHANGED', '预览已过期，请重新预览。');
    if (item.view.blockers.length) throw new HttpError(409, 'CONFLICT', '请先处理预览中的阻碍项。');
    item.started = launch(item.client, async (signal) => {
      if (item.exportInput) return item.client.jobs.createExport(item.exportInput, { signal });
      const result = await item.client.actions.execute(item.actionId!, { signal });
      if (result.type !== 'job') throw new HttpError(500, 'INTERNAL', '任务未返回执行记录。');
      return result.job;
    });
    return item.started;
  }

  async function discard(id: string) {
    const item = pending.get(id);
    if (item && !item.started) { pending.delete(id); await item.client.close(); }
    return { id };
  }

  async function detail(id: string) {
    const { job, profile } = await options.job(id);
    const client = clientFor(profile.scope);
    try {
      const events = [];
      let after = -1;
      for (;;) {
        const page = await client.jobs.events(id, after);
        events.push(...page);
        if (page.length < 256) break;
        after = page.at(-1)!.sequence;
      }
      const itemTitles: Record<string, string> = {};
      for (const item of job.items) {
        const stored = await runtime.state.get(`web:resource:${item.key}`);
        const resource = stored && ResourceSchema.safeParse(stored.value);
        if (resource && resource.success && sameScope(resource.data.ref.course.scope, profile.scope)) itemTitles[item.key] = resource.data.title;
      }
      return JobDetailSchema.parse({ job, active: active?.id === id, error: errors.get(id) ?? null, events, itemTitles });
    } finally { await client.close(); }
  }

  async function control(id: string, raw: unknown): Promise<Job> {
    const { action } = JobControlInputSchema.parse(raw);
    const owner = active?.id === id ? active : undefined;
    if (owner) {
      if (action === 'resume') throw new HttpError(409, 'CONFLICT', '任务正在本机执行，请刷新任务状态。');
      // Let the SDK settle the interrupted slice before changing its persisted state.
      owner.stop = true;
      owner.controller.abort();
      await owner.done;
    }
    const { job, profile } = await options.job(id);
    if (job.status === 'uncertain' || (job.status === 'running' && job.kind === 'study')) throw new HttpError(409, 'UNCERTAIN', '上次执行结果尚未确认，请先核对。');
    const client = clientFor(profile.scope);
    if (action === 'resume') {
      if (!['export', 'study', 'live'].includes(job.kind) || !['queued', 'running', 'waiting', 'paused', 'needs-input'].includes(job.status) || (job.status === 'needs-input' && job.kind === 'export')) {
        await client.close();
        throw new HttpError(409, 'CONFLICT', '当前任务状态不能恢复。');
      }
      try {
        return await launch(client, async (signal) => {
          if (job.kind === 'live' && job.status === 'queued') await client.jobs.pause(id);
          if (job.status === 'running') return client.jobs.resume(id, { recoverInterrupted: true, signal });
          return client.jobs.resume(id, { signal });
        });
      } catch (error) { await client.close(); throw error; }
    }
    const release = options.lock();
    try {
      if (action === 'pause' && job.status === 'paused' || action === 'cancel' && job.status === 'canceled') return job;
      if (action === 'pause' && !runnable(job) || action === 'cancel' && ['failed', 'partial', 'succeeded'].includes(job.status)) throw new HttpError(409, 'CONFLICT', '当前任务状态不能执行该操作。');
      return action === 'pause' ? await client.jobs.pause(id) : await client.jobs.cancel(id);
    } finally { try { await client.close(); } finally { release(); } }
  }

  async function reconcile(id: string) {
    const release = options.lock();
    let client: Client | undefined;
    try {
      const { job, profile } = await options.job(id);
      if (!['uncertain', 'running'].includes(job.status)) throw new HttpError(409, 'CONFLICT', '该任务无需核对。');
      const meta = z.object({ pendingOperationId: z.string().nullable() }).parse((await runtime.state.get(`job-meta:${id}`))?.value);
      if (!meta.pendingOperationId) throw new HttpError(409, 'UNCERTAIN', '没有可核对的写入记录，无法证明上次结果；请保留该任务记录。');
      client = clientFor(profile.scope);
      const receipt = await client.actions.reconcile(meta.pendingOperationId);
      return { job: await client.jobs.get(id), state: receipt.state, message: receipt.state === 'confirmed' ? '已确认上次结果，可以恢复任务。' : '平台尚不能确认上次结果，任务保留原状态。' };
    } finally { try { await client?.close(); } finally { release(); } }
  }

  async function download(id: string, artifactId: string, response: ServerResponse) {
    const { job } = await options.job(id);
    const artifact = job.items.flatMap(item => item.artifacts).find(item => item.id === artifactId && sameScope(item.scope, job.scope));
    if (!artifact) throw new HttpError(404, 'NOT_FOUND', '任务中没有该文件。');
    const hash = createHash('sha256');
    let bytes = 0;
    for await (const chunk of await runtime.artifacts.open(artifact.id)) { bytes += chunk.length; hash.update(chunk); }
    if (bytes !== artifact.bytes || hash.digest('hex') !== artifact.sha256) throw new HttpError(409, 'INTEGRITY', '文件不完整，请检查任务记录。');
    response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(artifact.filename).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16)}`)}` });
    await pipeline(Readable.from(await runtime.artifacts.open(artifact.id)), response);
  }

  async function close() {
    closed = true;
    if (active) { active.stop = true; active.controller.abort(); await active.done; }
    await Promise.all([...pending.values()].filter(item => !item.started).map(item => item.client.close()));
    pending.clear();
  }

  return { preview, start, discard, lessons, detail, control, reconcile, download, close };
}
