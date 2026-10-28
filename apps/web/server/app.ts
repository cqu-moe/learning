import http from 'node:http';
import { HttpError, errorFrom } from './errors.ts';
import { createTaskService } from './tasks.ts';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LearningError, createLearningClient } from '@learning/sdk';
import {
  NodeArtifactStore,
  NodeFetchTransport,
  SqliteStateStore,
  loadOrCreateMasterKey,
  probeMediaDuration,
  readLocalSession,
  removeLocalProfileData,
} from '@learning/sdk/node';
import type { Runtime } from '@learning/sdk/node';
import type { AuthEvent, Course, Job, OutlineNode } from '@learning/sdk/public';
import {
  CourseSchema,
  OutlineSchema,
  ResourceKindSchema,
  ResourceSchema,
  ResourceRefSchema,
  ScopeSchema,
  WarningSchema,
} from '@learning/sdk/public';
import {
  CreateProfileInputSchema,
  DashboardSchema,
  LoginStateSchema,
  ProfileSchema,
  StartLoginInputSchema,
  ProfileControlInputSchema,
  UnlockInputSchema,
} from '../shared/contracts.ts';
import type { LoginQr, Profile } from '../shared/contracts.ts';

const LocalProfileRecordSchema = z.strictObject({
  name: z.string().min(1).max(128),
  scope: ScopeSchema,
});
type LocalProfileRecord = z.infer<typeof LocalProfileRecordSchema>;

export interface WebServerOptions {
  dataDir: string;
  port?: number;
  transport?: Transport;
  staticDir?: string;
  maxBodyBytes?: number;
  allowedOrigins?: string[];
}

type Transport = Runtime['transport'];


interface ActiveLogin {
  flow: {
    events: AsyncIterable<AuthEvent>;
    result: Promise<unknown>;
    cancel(): Promise<void>;
  };
  client: { close(): Promise<void> };
  release(): void;
  done: Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2',
};

function profileKey(name: string): string {
  return `cli:profile:${encodeURIComponent(name)}`;
}

function courseKey(key: string): string {
  return `cli:course:${key}`;
}

const PreferencesSchema = z.object({ version: z.literal(1), defaultProfileId: z.string().nullable(), downloadDir: z.string().nullable() });

function validProfileName(name: string): boolean {
  return name.trim() === name && [...name].every(char => {
    const code = char.charCodeAt(0);
    return code > 31 && code !== 127;
  });
}


function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function writerStatus(dataDir: string): z.infer<typeof DashboardSchema>['writer'] {
  try {
    const pid = Number(readFileSync(resolve(dataDir, 'learning.lock'), 'utf8').trim().split('\n')[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0) return { state: 'unknown', pid: null };
    return { state: pidAlive(pid) ? 'active' : 'stale', pid };
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'idle' : 'unknown', pid: null };
  }
}

function acquireLock(dataDir: string): { ok: true; release: () => void } | { ok: false; reason: string } {
  const path = resolve(dataDir, 'learning.lock');
  const token = `${process.pid}\n${randomUUID()}`;
  try {
    writeFileSync(path, token, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const rawPid = (() => {
      try { return Number(readFileSync(path, 'utf8').trim().split('\n')[0]); } catch { return null; }
    })();
    const pid = rawPid !== null && Number.isSafeInteger(rawPid) && rawPid > 0 ? rawPid : null;
    if (pid === null) return { ok: false, reason: '写入锁不可读，请先人工确认。' };
    return {
      ok: false,
      reason: pidAlive(pid)
        ? `另一个写入进程持有锁（PID ${pid}）。`
        : `发现疑似过期写入锁（PID ${pid}），请先人工确认再处理。`,
    };
  }
  const release = () => {
    try { if (readFileSync(path, 'utf8') === token) unlinkSync(path); } catch { /* Best effort. */ }
  };
  process.once('exit', release);
  return { ok: true, release: () => { process.off('exit', release); release(); } };
}

function decodeSegment(segment: string): string {
  const value = decodeURIComponent(segment);
  if (value === '' || value.includes('/') || value.includes('\\')) throw new HttpError(404, 'NOT_FOUND', 'API 路由不存在。');
  return value;
}


function baseRuntime(options: {
  state: SqliteStateStore;
  artifacts: NodeArtifactStore;
  masterKey: Uint8Array;
  transport: Transport;
}): Runtime {
  return {
    transport: options.transport,
    state: options.state,
    artifacts: options.artifacts,
    masterKey: options.masterKey,
    clock: {
      nowMs: () => Date.now(),
      sleep: (ms: number, signal: AbortSignal) => new Promise<void>((resolveSleep, rejectSleep) => {
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolveSleep(); }, ms);
        const onAbort = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); rejectSleep(new DOMException('Aborted', 'AbortError')); };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }),
    },
    heavy: null,
    ...(options.transport instanceof NodeFetchTransport ? { probeMediaDuration } : {}),
    model: null,
    log: () => {},
    wake: async () => {},
  };
}

export function createWebServer(options: WebServerOptions): http.Server {
  const allowedOrigins = (options.allowedOrigins ?? []).map(origin => {
    let url: URL;
    try { url = new URL(origin); } catch { throw new HttpError(500, 'INVALID_INPUT', '允许的 Origin 配置无效。'); }
    if (url.protocol !== 'http:' || url.username !== '' || url.password !== '' ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.port === '') {
      throw new HttpError(500, 'INVALID_INPUT', '允许的 Origin 只能是本机回环地址。');
    }
    return url.toString().replace(/\/$/, '');
  });
  const dataDir = resolve(options.dataDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const statePath = resolve(dataDir, 'state.db');
  const keyPath = resolve(dataDir, 'master.key');
  if (existsSync(statePath) && !existsSync(keyPath)) {
    throw new HttpError(409, 'STORAGE', '已有本地数据库但缺少密钥；拒绝重新生成密钥。');
  }
  const { masterKey, state } = (() => {
    const lock = !existsSync(statePath) ? acquireLock(dataDir) : null;
    if (lock && !lock.ok) throw new HttpError(409, 'CONFLICT', lock.reason);
    try {
      return { masterKey: loadOrCreateMasterKey(dataDir), state: new SqliteStateStore(statePath) };
    } finally { lock?.release(); }
  })();
  const artifacts = new NodeArtifactStore(resolve(dataDir, 'artifacts'));
  const transport = options.transport ?? new NodeFetchTransport();
  const staticDir = options.staticDir === undefined ? resolve(import.meta.dirname, '..', 'dist') : resolve(options.staticDir);
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const loginStates = new Map<string, z.infer<typeof LoginStateSchema>>();
  const activeLogins = new Map<string, ActiveLogin>();
  const cancelRequested = new Set<string>();
  let lockChain: Promise<unknown> = Promise.resolve();

  const withLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const run = lockChain.then(async () => {
      const lock = acquireLock(dataDir);
      if (!lock.ok) throw new HttpError(409, 'CONFLICT', lock.reason);
      try { return await operation(); } finally { lock.release(); }
    });
    lockChain = run.catch(() => undefined);
    return run as Promise<T>;
  };

  const runtimeFor = (): Runtime => baseRuntime({ state, artifacts, masterKey, transport });

  async function listProfileRecords(): Promise<LocalProfileRecord[]> {
    const records: LocalProfileRecord[] = [];
    let cursor: string | null = null;
    do {
      const page = await state.list('cli:profile:', cursor, 100);
      for (const item of page.items) {
        const record = LocalProfileRecordSchema.parse(item.record.value);
        if (record.scope.userId !== 'local') throw new HttpError(500, 'STORAGE', '本地账号记录无效。');
        records.push(record);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return records.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function profileById(profileId: string): Promise<LocalProfileRecord> {
    const found = (await listProfileRecords()).find(profile => profile.scope.profileId === profileId);
    if (found === undefined) throw new HttpError(404, 'NOT_FOUND', '账号不存在。');
    return found;
  }

  async function profileView(record: LocalProfileRecord): Promise<Profile> {
    return ProfileSchema.parse({
      name: record.name,
      scope: record.scope,
      hasSession: await readLocalSession(state, masterKey, record.scope) !== null,
    });
  }

  async function cacheCourses(courses: Course[]): Promise<void> {
    for (const course of courses) {
      const key = courseKey(course.ref.key);
      const old = await state.get(key);
      const ok = await state.commit({
        expected: [{ key, revision: old?.revision ?? null }],
        changes: [{ key, value: CourseSchema.parse(course) }],
      });
      if (!ok) throw new HttpError(409, 'CONFLICT', '课程缓存已变化，请重试。');
    }
  }

  async function cacheResources(nodes: OutlineNode[]): Promise<void> {
    for (const node of nodes) {
      for (const resource of node.resources) {
        const key = resource.ref.key;
        const rows = [
          { key: `cli:resource:${key}`, value: ResourceRefSchema.parse(resource.ref) },
          { key: `cli:resource-kind:${key}`, value: ResourceKindSchema.parse(resource.kind) },
          { key: `cli:resource-title:${key}`, value: resource.title },
          { key: `cli:resource-path:${key}`, value: resource.path },
          { key: `web:resource:${key}`, value: ResourceSchema.parse(resource) },
        ];
        const ok = await state.commit({
          expected: await Promise.all(rows.map(async row => ({ key: row.key, revision: (await state.get(row.key))?.revision ?? null }))),
          changes: rows,
        });
        if (!ok) throw new HttpError(409, 'CONFLICT', '资源缓存已变化，请重试。');
      }
      await cacheResources(node.children);
    }
  }

  async function cachedCourses(): Promise<Course[]> {
    const profileScopes = new Set((await listProfileRecords()).map(profile => JSON.stringify(profile.scope)));
    const courses: Course[] = [];
    let cursor: string | null = null;
    do {
      const page = await state.list('cli:course:', cursor, 200);
      for (const item of page.items) {
        const course = CourseSchema.parse(item.record.value);
        if (profileScopes.has(JSON.stringify(course.ref.scope))) courses.push(course);
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return courses;
  }

  async function sdkJobs(): Promise<Job[]> {
    const jobs: Job[] = [];
    for (const profile of await listProfileRecords()) {
      const client = createLearningClient({ scope: profile.scope, runtime: runtimeFor() });
      try {
        let cursor: string | undefined;
        do {
          const page = await client.jobs.list(cursor === undefined ? undefined : { cursor });
          jobs.push(...page.items);
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
      } catch (error) {
        if (error instanceof z.ZodError) throw new HttpError(500, 'STORAGE', '本地任务缓存无效。');
        throw error;
      } finally { await client.close(); }
    }
    return jobs;
  }

  async function dashboard(): Promise<z.infer<typeof DashboardSchema>> {
    const profiles = await Promise.all((await listProfileRecords()).map(profileView));
    const saved = await state.get('cli:preferences');
    return DashboardSchema.parse({
      profiles,
      courses: await cachedCourses(),
      jobs: await sdkJobs(),
      updatedAtMs: Date.now(),
      defaultProfileId: saved === null ? null : PreferencesSchema.parse(saved.value).defaultProfileId,
      writer: writerStatus(dataDir),
    });
  }

  async function createProfile(input: unknown): Promise<Profile> {
    const body = CreateProfileInputSchema.parse(input);
    if (!validProfileName(body.name)) throw new HttpError(422, 'INVALID_INPUT', '账号名称无效。');
    return withLock(async () => {
      const key = profileKey(body.name);
      const old = await state.get(key);
      if (old !== null) {
        LocalProfileRecordSchema.parse(old.value);
        throw new HttpError(409, 'CONFLICT', '账号名称已存在。');
      }
      const record: LocalProfileRecord = { name: body.name, scope: { userId: 'local', profileId: randomUUID(), platform: body.platform } };
      const ok = await state.commit({ expected: [{ key, revision: null }], changes: [{ key, value: record }] });
      if (!ok) throw new HttpError(409, 'CONFLICT', '账号名称已存在。');
      return profileView(record);
    });
  }

  async function controlProfile(id: string, input: unknown) {
    const { action } = ProfileControlInputSchema.parse(input);
    return withLock(async () => {
      const profile = await profileById(id);
      if (action === 'default') {
        const key = 'cli:preferences';
        const old = await state.get(key);
        const preferences = old === null ? { version: 1, defaultProfileId: null, downloadDir: null } : PreferencesSchema.parse(old.value);
        if (!await state.commit({ expected: [{ key, revision: old?.revision ?? null }], changes: [{ key, value: { ...preferences, defaultProfileId: id } }] })) throw new HttpError(409, 'CONFLICT', '默认账号已变化，请重试。');
        return { id, message: '已设为默认账号。' };
      }
      const runtime = runtimeFor();
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        if (action === 'probe') {
          const result = await client.auth.probe();
          return { id, state: result.state, message: result.state === 'valid' ? '登录有效。' : result.state === 'expired' ? '登录已失效，请重新扫码。' : '暂时无法确认登录状态，请稍后重试。' };
        }
        await client.auth.disconnect();
        if (action === 'disconnect') return { id, message: '已退出本地登录，账号与任务记录保留。' };
        await removeLocalProfileData(runtime, profile.scope);
        const key = profileKey(profile.name);
        const record = await state.get(key);
        if (!record || !await state.commit({ expected: [{ key, revision: record.revision }], changes: [{ key, value: null }] })) throw new HttpError(409, 'CONFLICT', '账号已变化，请刷新。');
        return { id, message: '已移除账号及其本地缓存和任务。' };
      } finally { await client.close(); }
    });
  }

  function unlock(input: unknown) {
    const { pid } = UnlockInputSchema.parse(input);
    const path = resolve(dataDir, 'learning.lock');
    const current = writerStatus(dataDir);
    if (current.state === 'idle') return { unlocked: false, message: '当前没有写入锁。' };
    if (current.state !== 'stale' || current.pid !== pid) throw new HttpError(409, 'CONFLICT', '写入进程仍在运行或锁已变化，请刷新后重试。');
    const original = readFileSync(path, 'utf8');
    if (Number(original.trim().split('\n')[0]) !== pid || pidAlive(pid) || readFileSync(path, 'utf8') !== original) throw new HttpError(409, 'CONFLICT', '无法确认写入进程已退出，保留现有锁。');
    unlinkSync(path);
    return { unlocked: true, message: '已清理失效锁，可以恢复任务。' };
  }

  async function coursePage(profileId: string, search: URLSearchParams): Promise<unknown> {
    const keys = [...search.keys()];
    if (keys.length > 1 || keys[0] !== undefined && keys[0] !== 'cursor') throw new HttpError(422, 'INVALID_INPUT', '存在未知查询字段。');
    const cursor = search.get('cursor');
    if (cursor === '') throw new HttpError(422, 'INVALID_INPUT', 'cursor 不能为空。');
    return withLock(async () => {
      const profile = await profileById(profileId);
      const client = createLearningClient({ scope: profile.scope, runtime: runtimeFor() });
      try {
        const page = await client.catalog.courses(cursor === null ? undefined : { cursor });
        await cacheCourses(page.items);
        return { items: page.items, nextCursor: page.nextCursor, completeness: page.completeness, warnings: WarningSchema.array().parse(page.warnings) };
      } finally { await client.close(); }
    });
  }

  async function outline(key: string): Promise<unknown> {
    return withLock(async () => {
      const stored = await state.get(courseKey(key));
      if (stored === null) throw new HttpError(404, 'NOT_FOUND', '本地缓存中没有该课程。');
      const course = CourseSchema.parse(stored.value);
      const profile = (await listProfileRecords()).find(item =>
        item.scope.userId === course.ref.scope.userId &&
        item.scope.profileId === course.ref.scope.profileId &&
        item.scope.platform === course.ref.scope.platform);
      if (profile === undefined) throw new HttpError(404, 'NOT_FOUND', '本地缓存中没有属于当前账号的课程。');
      const client = createLearningClient({ scope: profile.scope, runtime: runtimeFor() });
      try {
        const result = await client.catalog.outline(course.ref);
        await cacheResources(result.value.roots);
        return { value: OutlineSchema.parse(result.value), warnings: WarningSchema.array().parse(result.warnings) };
      } finally { await client.close(); }
    });
  }

  async function jobForProfile(jobId: string): Promise<{ job: Job; profile: LocalProfileRecord }> {
    for (const profile of await listProfileRecords()) {
      const client = createLearningClient({ scope: profile.scope, runtime: runtimeFor() });
      try {
        const job = await client.jobs.get(jobId);
        return { job, profile };
      } catch (error) {
        if (!(error instanceof LearningError && ['INVALID_INPUT', 'FORBIDDEN'].includes(error.data.code))) throw error;
      } finally { await client.close(); }
    }
    throw new HttpError(404, 'NOT_FOUND', '没有属于已配置账号的任务。');
  }

  const tasks = createTaskService({
    runtime: runtimeFor(),
    dataDir,
    profile: profileById,
    job: jobForProfile,
    lock: () => {
      const lock = acquireLock(dataDir);
      if (!lock.ok) throw new HttpError(409, 'CONFLICT', lock.reason);
      return lock.release;
    },
  });

  async function qrFor(event: Extract<AuthEvent, { type: 'qr' }>): Promise<LoginQr> {
    const common = { expiresAtMs: event.expiresAtMs };
    if (event.qr.type === 'png' || event.qr.type === 'jpeg') {
      let bytes: string;
      try { bytes = atob(event.qr.base64); } catch { throw new HttpError(502, 'PROTOCOL', '登录二维码图片无效。'); }
      if (bytes.length === 0 || bytes.length > 1024 * 1024) throw new HttpError(502, 'PROTOCOL', '登录二维码图片超出大小限制。');
      return { ...common, imageDataUrl: `data:image/${event.qr.type};base64,${event.qr.base64}`, url: null };
    }
    let url: URL;
    try { url = new URL(event.qr.value); } catch { throw new HttpError(502, 'PROTOCOL', '登录二维码链接无效。'); }
    if (url.protocol !== 'https:' || !(url.hostname === 'weixin.qq.com' || url.hostname.endsWith('.weixin.qq.com'))) {
      throw new HttpError(502, 'PROTOCOL', '登录二维码来源不受信任。');
    }
    try {
      const qrcode = await import('qrcode') as { toDataURL(value: string): Promise<string> };
      return { ...common, imageDataUrl: await qrcode.toDataURL(event.qr.value), url: null };
    } catch { throw new HttpError(500, 'INTERNAL', '登录二维码生成失败。'); }
  }

  async function startLogin(profileId: string): Promise<{ id: string }> {
    const profile = await profileById(profileId);
    const id = randomUUID();
    loginStates.set(id, { id, status: 'waiting', qr: null, message: null });
    const run = lockChain.then(async () => {
      let release: (() => void) | undefined;
      const client = createLearningClient({ scope: profile.scope, runtime: runtimeFor() });
      const releaseOnce = () => {
        if (release === undefined) return;
        const callback = release;
        release = undefined;
        callback();
      };
      const update = (patch: (current: z.infer<typeof LoginStateSchema>) => z.infer<typeof LoginStateSchema>) => {
        const current = loginStates.get(id);
        if (current !== undefined) loginStates.set(id, LoginStateSchema.parse(patch(current)));
      };
      try {
        if (cancelRequested.delete(id)) {
          update(() => ({ id, status: 'canceled', qr: null, message: null }));
          await client.close();
          return;
        }
        const lock = acquireLock(dataDir);
        if (!lock.ok) {
          loginStates.set(id, { id, status: 'failed', qr: null, message: lock.reason });
          await client.close();
          throw new HttpError(409, 'CONFLICT', lock.reason);
        }
        release = lock.release;
        const current = await profileById(profileId);
        if (current.scope.userId !== profile.scope.userId || current.scope.profileId !== profile.scope.profileId || current.scope.platform !== profile.scope.platform) {
          throw new HttpError(409, 'PRECONDITION_CHANGED', '账号已变化，请重新登录。');
        }
        const flow = await client.auth.begin({ method: 'qr' });
        const resultGuard = flow.result.then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        if (cancelRequested.has(id)) await flow.cancel();
        const active: ActiveLogin = { flow, client, release: releaseOnce, done: Promise.resolve() };
        activeLogins.set(id, active);
        active.done = (async () => {
          let authenticated = false;
        try {
            for await (const event of flow.events) {
              if (event.type === 'qr') {
                const qr = await qrFor(event);
                update(() => ({ id, status: 'waiting', qr, message: null }));
              }
              else if (event.type === 'waiting') update(current => ({ ...current, status: 'waiting' }));
              else if (event.type === 'scanned') update(current => ({ ...current, status: 'scanned', message: null }));
              else if (event.type === 'exchanging') update(current => ({ ...current, status: 'exchanging', message: null }));
              else if (event.type === 'authenticated') {
                authenticated = true;
                update(() => ({ id, status: 'authenticated', qr: null, message: null }));
              }
              else if (event.type === 'failed') {
                const safe = errorFrom(new LearningError(event.error));
                update(() => ({ id, status: 'failed', qr: null, message: safe.status === 500 ? '登录失败。' : safe.message }));
              }
              else update(() => ({ id, status: 'canceled', qr: null, message: null }));
            }
            const result = await resultGuard;
            if (result.ok === false && !authenticated && !cancelRequested.has(id)) {
              const safe = errorFrom(result.error);
              update(() => ({ id, status: 'failed', qr: null, message: safe.status === 500 ? '登录失败。' : safe.message }));
            }
          } catch (error) {
            await flow.cancel().catch(() => undefined);
            const safe = errorFrom(error);
            update(() => ({ id, status: 'failed', qr: null, message: safe.status === 500 ? '登录失败。' : safe.message }));
          } finally {
            activeLogins.delete(id);
            cancelRequested.delete(id);
            await client.close();
            releaseOnce();
          }
        })();
        void active.done.catch(() => undefined);
      } catch (error) {
        const safe = errorFrom(error);
        update(current => current.status === 'waiting'
          ? { id, status: 'failed', qr: null, message: safe.status === 500 ? '登录失败。' : safe.message }
          : current);
          await client.close();
        releaseOnce();
        }
    });
    const handled = run.catch(error => {
      const safe = errorFrom(error);
      const current = loginStates.get(id);
      if (current !== undefined && current.status === 'waiting') {
        loginStates.set(id, { id, status: 'failed', qr: null, message: safe.status === 500 ? '登录失败。' : safe.message });
      }
    });
    lockChain = handled;
    void handled;
    return { id };
  }

  function loginState(id: string): z.infer<typeof LoginStateSchema> {
    const state = loginStates.get(id);
    if (state === undefined) throw new HttpError(404, 'NOT_FOUND', 'login not found');
    return LoginStateSchema.parse(state);
  }

  async function cancelLogin(id: string): Promise<{ id: string }> {
    const current = loginState(id);
    if (['authenticated', 'failed', 'canceled'].includes(current.status)) return { id };
    cancelRequested.add(id);
    const active = activeLogins.get(id);
    if (active === undefined) {
      return { id };
    }
    await active.flow.cancel();
    await active.done.catch(() => undefined);
    const final = loginStates.get(id);
    if (final !== undefined && final.status !== 'authenticated') loginStates.set(id, { ...final, status: 'canceled', qr: null, message: null });
    return { id };
  }

  function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
    const body = JSON.stringify(value);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  }

  function sendError(response: http.ServerResponse, error: unknown): void {
    const safe = errorFrom(error);
    sendJson(response, safe.status, { error: { code: safe.code, message: safe.message } });
  }

  function readBody(request: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolveBody, rejectBody) => {
      const declared = Number(request.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBodyBytes) {
        rejectBody(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大。'));
        request.resume();
        return;
      }
      let size = 0;
      const parts: Buffer[] = [];
      request.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > maxBodyBytes) {
          rejectBody(new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体过大。'));
          request.destroy();
          return;
        }
        parts.push(chunk);
      });
      request.on('end', () => {
        try {
          if (parts.length === 0) {
            resolveBody(request.method === 'DELETE' ? {} : undefined);
            return;
          }
          resolveBody(JSON.parse(Buffer.concat(parts).toString('utf8')));
        } catch { rejectBody(new HttpError(422, 'INVALID_INPUT', '请求体必须是 JSON。')); }
      });
      request.on('error', rejectBody);
    });
  }

  function securityOk(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const localPort = response.socket?.localPort ?? options.port;
    const allowedHosts = new Set([`127.0.0.1:${localPort}`, `localhost:${localPort}`, `[::1]:${localPort}`]);
    if (typeof request.headers.host !== 'string' || !allowedHosts.has(request.headers.host.toLowerCase())) {
      sendError(response, new HttpError(403, 'FORBIDDEN', 'Host 不是本机来源。'));
      return false;
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      sendError(response, new HttpError(403, 'FORBIDDEN', '拒绝跨站请求。'));
      return false;
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const allowed = new Set([...allowedHosts].map(host => `http://${host}`));
      for (const extra of allowedOrigins) allowed.add(extra);
      if (!allowed.has(origin)) {
        sendError(response, new HttpError(403, 'FORBIDDEN', 'Origin 不在允许范围。'));
        return false;
      }
    }
    return true;
  }

  function serveStatic(pathname: string, response: http.ServerResponse): void {
    if (staticDir === undefined) {
      sendError(response, new HttpError(404, 'NOT_FOUND', 'API 路由不存在。'));
      return;
    }
    let relative: string;
    try { relative = decodeURIComponent(pathname); } catch {
      sendError(response, new HttpError(404, 'NOT_FOUND', '文件不存在。'));
      return;
    }
    if (relative.includes('\0') || relative.includes('\\')) {
      sendError(response, new HttpError(404, 'NOT_FOUND', '文件不存在。'));
      return;
    }
    const root = realpathSync(staticDir);
    const target = resolve(root, `.${relative}`);
    if (target !== root && !target.startsWith(`${root}/`)) {
      sendError(response, new HttpError(404, 'NOT_FOUND', '文件不存在。'));
      return;
    }
    let path: string | null = null;
    try {
      const realTarget = realpathSync(target);
      if (realTarget !== root && !realTarget.startsWith(`${root}/`)) throw new Error('outside root');
      const stat = statSync(target);
      if (stat.isDirectory()) path = resolve(root, 'index.html');
      else path = target;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        sendError(response, new HttpError(404, 'NOT_FOUND', '文件不存在。'));
        return;
      }
    }
    if (path === null) path = resolve(root, 'index.html');
    try {
      const realPath = realpathSync(path);
      if (realPath !== root && !realPath.startsWith(`${root}/`)) throw new Error('outside root');
      if (!statSync(path).isFile()) throw new Error('not a file');
    } catch {
      sendError(response, new HttpError(404, 'NOT_FOUND', '文件不存在。'));
      return;
    }
    const body = readFileSync(path);
    response.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.byteLength,
      'x-content-type-options': 'nosniff',
    });
    response.end(body);
  }

  const server = http.createServer((request, response) => {
    response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    void (async () => {
      if (!securityOk(request, response)) return;
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'DELETE') {
        sendError(response, new HttpError(404, 'NOT_FOUND', 'API 路由不存在。'));
        return;
      }
      if (request.method !== 'GET') {
        const contentType = String(request.headers['content-type'] ?? '');
        const media = contentType.split(';', 1)[0]?.trim() ?? '';
        if (media !== 'application/json') {
          sendError(response, new HttpError(422, 'INVALID_INPUT', '写入请求必须使用 application/json。'));
          return;
        }
      } else if ((request.headers['content-length'] ?? '0') !== '0') {
        sendError(response, new HttpError(422, 'INVALID_INPUT', 'GET 请求不能携带请求体。'));
        return;
      }

      const path = url.pathname;
      const respond = (value: unknown) => sendJson(response, 200, value);
      if (request.method === 'GET' && path === '/api/dashboard') return respond(await dashboard());
      if (request.method === 'POST' && path === '/api/system/unlock') return respond(unlock(await readBody(request)));
      if (request.method === 'POST' && path === '/api/tasks/preview') {
        const createdPreview: { id?: string } = {};
        let aborted = false;
        const discardAborted = () => {
          if (response.writableFinished) return;
          aborted = true;
          if (createdPreview.id) void tasks.discard(createdPreview.id).catch(() => undefined);
        };
        response.once('close', discardAborted);
        response.once('finish', () => response.off('close', discardAborted));
        const preview = await tasks.preview(await readBody(request));
        createdPreview.id = preview.id;
        if (aborted) { await tasks.discard(preview.id); return; }
        return respond(preview);
      }
      if (request.method === 'POST' && path === '/api/profiles') return respond(await createProfile(await readBody(request)));
      let match: RegExpMatchArray | null;
      if ((match = path.match(/^\/api\/profiles\/([^/]+)\/control$/)) && request.method === 'POST') return respond(await controlProfile(decodeSegment(match[1]!), await readBody(request)));
      if ((match = path.match(/^\/api\/tasks\/([^/]+)\/start$/)) && request.method === 'POST') {
        StartLoginInputSchema.parse(await readBody(request));
        return respond(await tasks.start(decodeSegment(match[1]!)));
      }
      if ((match = path.match(/^\/api\/tasks\/([^/]+)$/)) && request.method === 'DELETE') {
        StartLoginInputSchema.parse(await readBody(request));
        return respond(await tasks.discard(decodeSegment(match[1]!)));
      }
      if ((match = path.match(/^\/api\/courses\/([^/]+)\/lessons$/)) && request.method === 'GET') return respond(await tasks.lessons(decodeSegment(match[1]!), url.searchParams));
      if ((match = path.match(/^\/api\/jobs\/([^/]+)\/details$/)) && request.method === 'GET') return respond(await tasks.detail(decodeSegment(match[1]!)));
      if ((match = path.match(/^\/api\/jobs\/([^/]+)\/artifacts\/([^/]+)$/)) && request.method === 'GET') return tasks.download(decodeSegment(match[1]!), decodeSegment(match[2]!), response);
      if ((match = path.match(/^\/api\/jobs\/([^/]+)\/reconcile$/)) && request.method === 'POST') {
        StartLoginInputSchema.parse(await readBody(request));
        return respond(await tasks.reconcile(decodeSegment(match[1]!)));
      }
      if ((match = path.match(/^\/api\/profiles\/([^/]+)\/courses$/)) !== null && request.method === 'GET') return respond(await coursePage(decodeSegment(match[1]!), url.searchParams));
      if ((match = path.match(/^\/api\/courses\/([^/]+)\/outline$/)) !== null && request.method === 'GET') return respond(await outline(decodeSegment(match[1]!)));
      if ((match = path.match(/^\/api\/profiles\/([^/]+)\/login$/)) !== null && request.method === 'POST') {
        const createdLogin: { id?: string } = {};
        let responseAborted = false;
        const cleanupAbortedLogin = () => {
          if (response.writableFinished) return;
          responseAborted = true;
          if (createdLogin.id !== undefined) void cancelLogin(createdLogin.id).catch(() => undefined);
        };
        response.once('close', cleanupAbortedLogin);
        response.once('finish', () => response.off('close', cleanupAbortedLogin));
        StartLoginInputSchema.parse(await readBody(request));
        if (responseAborted) return;
        const login = await startLogin(decodeSegment(match[1]!));
        createdLogin.id = login.id;
        if (responseAborted) {
          await cancelLogin(login.id);
          return;
        }
        return respond(login);
      }
      if ((match = path.match(/^\/api\/logins\/([^/]+)$/)) !== null && request.method === 'GET') return respond(loginState(decodeSegment(match[1]!)));
      if ((match = path.match(/^\/api\/logins\/([^/]+)$/)) !== null && request.method === 'DELETE') {
        StartLoginInputSchema.parse(await readBody(request));
        return respond(await cancelLogin(decodeSegment(match[1]!)));
      }
      if ((match = path.match(/^\/api\/jobs\/([^/]+)$/)) !== null && request.method === 'GET') return respond((await jobForProfile(decodeSegment(match[1]!))).job);
      if ((match = path.match(/^\/api\/jobs\/([^/]+)\/control$/)) !== null && request.method === 'POST') return respond(await tasks.control(decodeSegment(match[1]!), await readBody(request)));
      if (path === '/api' || path.startsWith('/api/')) {
        sendError(response, new HttpError(404, 'NOT_FOUND', 'API 路由不存在。'));
        return;
      }
      if (request.method === 'GET' && decodeURIComponent(request.url ?? '').includes('..')) {
        sendError(response, new HttpError(404, 'NOT_FOUND', '文件不存在。'));
        return;
      }
      if (request.method === 'GET') return serveStatic(path, response);
      sendError(response, new HttpError(404, 'NOT_FOUND', 'API 路由不存在。'));
    })().catch(error => {
      if (!response.headersSent) sendError(response, error);
      else response.destroy();
    });
  });

  const nativeClose = server.close.bind(server);
  let closing = false;
  let stateClosed = false;
  let closeDone: Promise<void> | undefined;
  const closeStateOnce = () => {
    if (stateClosed) return;
    stateClosed = true;
    state.close();
  };
  server.close = ((callback?: (error?: Error) => void) => {
    if (closing) {
      void closeDone?.then(() => callback?.());
      return server;
    }
    if (!server.listening) {
      closeStateOnce();
      callback?.();
      return server;
    }
    closing = true;
    const tasksClosed = tasks.close().then(() => undefined, (error: unknown) => error instanceof Error ? error : new Error('Task shutdown failed'));
    closeDone = new Promise<void>(resolveClose => {
      server.closeIdleConnections();
      nativeClose(error => {
        void lockChain.catch(() => undefined).then(() => Promise.all(
          [...activeLogins.values()].map(async login => {
            await login.flow.cancel().catch(() => undefined);
            await login.done.catch(() => undefined);
          }),
        )).catch(() => undefined).then(async () => {
          const taskError = await tasksClosed;
          closeStateOnce();
          callback?.(error ?? taskError);
          resolveClose();
        });
      });
    });
    return server;
  }) as typeof server.close;
  return server;
}

export function resolveDefaultDataDir(): string {
  return resolve(process.env.LEARNING_HOME ?? resolve(homedir(), '.learning'));
}
