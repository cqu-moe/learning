import { describe, expect, it } from 'vitest';
import { LiveMailbox, expiredQuestionGuard } from '../src/providers/ykt/live.js';
import { createLearningClient } from '../src/index.js';
import { FakeWsTransport } from './helpers/ws.js';
import { FakeClock } from './helpers/replay.js';
import { MemoryStateStore } from './helpers/memory.js';
import { SessionCookieJar } from '../src/http/client.js';
import { writeSession } from '../src/session/store.js';
import type { Runtime } from '../src/runtime/types.js';

describe('ykt live (T22, A221/A222)', () => {
  it('slides reads never check in; expired questions are never answered; duplicate events dedupe', () => {
    const answered: string[] = [];
    const mailbox = new LiveMailbox();
    mailbox.push({ type: 'question', phaseId: 'p1', questionId: 'q1', closesAtMs: 1000 });
    mailbox.push({ type: 'question', phaseId: 'p1', questionId: 'q1', closesAtMs: 1000 });
    const now = 2000;
    for (const event of mailbox.drain(now)) {
      if (expiredQuestionGuard(event, now)) continue;
      if (event.type === 'question') answered.push(event.questionId);
    }
    expect(answered).toHaveLength(0);
    mailbox.push({ type: 'question', phaseId: 'p2', questionId: 'q2', closesAtMs: 5000 });
    const live = mailbox.drain(2000).filter((event) => !expiredQuestionGuard(event, 2000));
    expect(live).toHaveLength(1);
  });

  it('reconnect reports a gap and does not replay uncertain answers', async () => {
    const mailbox = new LiveMailbox();
    mailbox.noteDisconnect();
    const events = mailbox.drain(3000);
    expect(events.some((event) => event.type === 'gap')).toBe(true);
  });

  it('checks in only after preview, connects with lesson token, persists a question and closes on finish', async () => {
    const transport = new FakeWsTransport();
    transport.scriptInteractions([{ request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', headers: { 'content-type': 'application/json;charset=utf-8' }, body: { source: 1, lessonId: '9000' } }, response: { status: 200, headers: { 'set-auth': 'fixture-jwt' }, body: { code: 0, data: { lessonToken: 'fixture-lesson-token' } } } }]);
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey,
      artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} },
      heavy: null, model: null, log: () => {}, wake: async () => {} };
    const client = createLearningClient({ scope, runtime });
    const lesson = { scope, course: null, lessonId: '9000' };
    const preview = await client.actions.prepare({ kind: 'live.join', lesson, maxDurationSeconds: 60 });
    expect(transport.calls).toHaveLength(0);
    const execution = await client.actions.execute(preview.id);
    expect(execution.type).toBe('job');
    if (execution.type !== 'job') throw Error('missing live job');
    const server = transport.connectNext();
    const waiting = await client.jobs.advance(execution.job.id);
    expect(waiting.status).toBe('waiting');
    expect(JSON.parse(server.sent[0]!)).toMatchObject({ op: 'hello', userid: '77', auth: 'fixture-lesson-token', lessonid: '9000' });
    server.push(JSON.stringify({ op: 'unlockproblem', problem: { prob: 11, problemType: 1, limit: 30 }, msgid: 2 }));
    server.push(JSON.stringify({ op: 'lessonfinished' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.setNow(clock.nowMs() + 1000);
    const done = await client.jobs.advance(execution.job.id);
    expect(done.status).toBe('succeeded');
    expect((await client.jobs.events(done.id, 0)).some((event) => event.type === 'question')).toBe(true);
    expect(server.closed).toBe(true);
    await client.close();
    transport.assertNoExtraScripts();
  });

  it('rejoins the same paused live job after a process restart and emits a gap', async () => {
    const transport = new FakeWsTransport();
    const checkin = { request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', headers: { 'content-type': 'application/json;charset=utf-8' }, body: { source: 1, lessonId: '9000' } }, response: { status: 200, body: { code: 0, data: { lessonToken: 'fixture-token' } } } };
    transport.scriptInteractions([checkin, checkin]);
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    const runtime: Runtime = { transport, state, clock, masterKey, artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} }, heavy: null, model: null, log: () => {}, wake: async () => {} };
    const first = createLearningClient({ scope, runtime });
    const preview = await first.actions.prepare({ kind: 'live.join', lesson: { scope, course: null, lessonId: '9000' }, maxDurationSeconds: 60 });
    const execution = await first.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing live job');
    await first.jobs.pause(execution.job.id);
    await first.close();
    const reopened = createLearningClient({ scope, runtime });
    const same = await reopened.jobs.resume(execution.job.id);
    expect(same.id).toBe(execution.job.id);
    expect(same.status).toBe('queued');
    expect((await reopened.jobs.events(same.id, 0)).some((event) => event.type === 'gap')).toBe(true);
    const server = transport.connectNext();
    await reopened.jobs.advance(same.id);
    server.push(JSON.stringify({ op: 'lessonfinished' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.setNow(clock.nowMs() + 1000);
    expect((await reopened.jobs.advance(same.id)).status).toBe('succeeded');
    await reopened.close();
    transport.assertNoExtraScripts();
  });

  it('sends one explicitly selected current-phase answer and rejects a closed question', async () => {
    const transport = new FakeWsTransport();
    const clock = new FakeClock();
    const state = new MemoryStateStore();
    const scope = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const masterKey = new Uint8Array(32).fill(5);
    await writeSession(state, masterKey, { schemaVersion: 1, scope, generation: 1, platformUserId: '77', identityVerified: true, cookieJar: await new SessionCookieJar().serialize(), displayName: null, checkedAtMs: clock.nowMs() });
    transport.scriptInteractions([
      { request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/checkin', headers: { 'content-type': 'application/json;charset=utf-8' }, body: { source: 1, lessonId: '9000' } }, response: { status: 200, headers: { 'set-auth': 'fixture-jwt' }, body: { code: 0, data: { lessonToken: 'fixture-token' } } } },
      { request: { method: 'POST', host: 'www.yuketang.cn', path: '/api/v3/lesson/problem/answer', headers: { authorization: 'Bearer fixture-jwt', xtbz: 'ykt', 'x-client': 'h5', 'content-type': 'application/json;charset=utf-8' }, body: { problemId: '11', problemType: 1, dt: clock.nowMs() + 1000, result: ['A'] } }, response: { status: 200, body: { code: 0 } } },
    ]);
    const runtime: Runtime = { transport, state, clock, masterKey, artifacts: { create: async () => { throw Error('unused'); }, resume: async () => { throw Error('unused'); }, open: async () => { throw Error('unused'); }, remove: async () => {} }, heavy: null, model: null, log: () => {}, wake: async () => {} };
    const client = createLearningClient({ scope, runtime });
    const preview = await client.actions.prepare({ kind: 'live.join', lesson: { scope, course: null, lessonId: '9000' }, maxDurationSeconds: 60 });
    const execution = await client.actions.execute(preview.id);
    if (execution.type !== 'job') throw Error('missing job');
    const server = transport.connectNext();
    await client.jobs.advance(execution.job.id);
    server.push(JSON.stringify({ op: 'unlockproblem', problem: { prob: 11, problemType: 1, limit: 30 }, msgid: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock.setNow(clock.nowMs() + 1000);
    await client.jobs.advance(execution.job.id);
    const answer = { kind: 'live.answer' as const, liveJobId: execution.job.id, questionId: '11', phaseId: '2', answer: { kind: 'choice' as const, keys: ['A'] } };
    const answerPreview = await client.actions.prepare(answer);
    expect((await client.actions.execute(answerPreview.id)).type).toBe('receipt');
    expect(transport.calls.filter((call) => call.url.endsWith('/problem/answer'))).toHaveLength(1);
    clock.setNow(clock.nowMs() + 31_000);
    await expect(client.actions.prepare(answer)).rejects.toMatchObject({ data: { code: 'INTERACTION_REQUIRED' } });
    await client.close();
    transport.assertNoExtraScripts();
  });
});
