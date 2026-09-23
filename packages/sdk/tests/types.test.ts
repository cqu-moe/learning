import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AnswerSchema,
  CourseRefSchema,
  ErrorDataSchema,
  OutlineNodeSchema,
  PageSchemaOf,
  ProgressSchema,
  ResourceRefSchema,
  ScopeSchema,
  WarningSchema,
  keyOfCourse,
  keyOfResource,
  LearningError,
} from '../src/public.js';
import { sha256Hex } from '../src/types/sha256.js';
import { MemoryStateStore } from './helpers/memory.js';

const scope = ScopeSchema.parse({ userId: 'local', profileId: 'p1', platform: 'ykt' });

const yktCourse = CourseRefSchema.parse({
  scope,
  key: 'placeholder',
  native: { kind: 'ykt', classroomId: '123' },
});

const zhsCourse = CourseRefSchema.parse({
  scope: ScopeSchema.parse({ userId: 'local', profileId: 'p1', platform: 'zhs' }),
  key: 'placeholder',
  native: { kind: 'zhs-share', recruitAndCourseId: 'rc1' },
});

function zhsResource(smallLessonId: string, videoId = 'v1') {
  return ResourceRefSchema.parse({
    course: zhsCourse,
    key: 'placeholder',
    native: { kind: 'zhs-share', chapterId: 'c1', lessonId: 'l1', smallLessonId, videoId },
  });
}

function yktResource(leafInfoId: string | null) {
  return ResourceRefSchema.parse({
    course: yktCourse,
    key: 'placeholder',
    native: { kind: 'ykt', leafId: 'leaf1', leafInfoId },
  });
}

function expectedKey(prefix: string, parts: unknown[]) {
  return createHash('sha256').update(JSON.stringify([prefix, ...parts])).digest('hex');
}

describe('pure sha256', () => {
  it('matches known vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('handles utf-8 multibyte input', () => {
    expect(sha256Hex('学习')).toBe(expectedKeyRaw('学习'));
  });
});

function expectedKeyRaw(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

describe('stable keys (S02)', () => {
  it('computes the documented course key array', () => {
    expect(keyOfCourse(yktCourse)).toBe(
      expectedKey('learning.course.v1', ['local', 'p1', 'ykt', 'ykt', '123']),
    );
  });

  it('computes the documented resource key array including course key', () => {
    const courseKey = keyOfCourse(yktCourse);
    const ref = yktResource(null);
    expect(keyOfResource(ref)).toBe(
      expectedKey('learning.resource.v1', ['local', 'p1', 'ykt', courseKey, 'ykt', 'leaf1', null]),
    );
  });

  it('same videoId with different smallLessonId yields different keys (A021)', () => {
    const x = keyOfResource(zhsResource('1'));
    const y = keyOfResource(zhsResource('2'));
    expect(x).not.toBe(y);
  });

  it('different userId or profileId never collide (A021)', () => {
    const otherUser = keyOfResource(
      ResourceRefSchema.parse({
        course: CourseRefSchema.parse({
          scope: ScopeSchema.parse({ userId: 'other', profileId: 'p1', platform: 'zhs' }),
          key: 'placeholder',
          native: { kind: 'zhs-share', recruitAndCourseId: 'rc1' },
        }),
        key: 'placeholder',
        native: { kind: 'zhs-share', chapterId: 'c1', lessonId: 'l1', smallLessonId: '1', videoId: 'v1' },
      }),
    );
    const otherProfile = keyOfResource(
      ResourceRefSchema.parse({
        course: CourseRefSchema.parse({
          scope: ScopeSchema.parse({ userId: 'local', profileId: 'p2', platform: 'zhs' }),
          key: 'placeholder',
          native: { kind: 'zhs-share', recruitAndCourseId: 'rc1' },
        }),
        key: 'placeholder',
        native: { kind: 'zhs-share', chapterId: 'c1', lessonId: 'l1', smallLessonId: '1', videoId: 'v1' },
      }),
    );
    const base = keyOfResource(zhsResource('1'));
    expect(otherUser).not.toBe(base);
    expect(otherProfile).not.toBe(base);
  });

  it('null leafInfoId stays explicit null; empty string is rejected', () => {
    const withNull = keyOfResource(yktResource(null));
    const withValue = keyOfResource(yktResource('info1'));
    expect(withNull).not.toBe(withValue);
    expect(() => yktResource('')).toThrow();
  });
});

describe('id validation (A022)', () => {
  it('rejects zero-like and unknown ids', () => {
    expect(() =>
      CourseRefSchema.parse({ scope, key: 'k', native: { kind: 'ykt', classroomId: '0' } }),
    ).toThrow();
    expect(() =>
      CourseRefSchema.parse({ scope, key: 'k', native: { kind: 'ykt', classroomId: '' } }),
    ).toThrow();
    expect(() =>
      CourseRefSchema.parse({ scope, key: 'k', native: { kind: 'ykt', classroomId: ' 123' } }),
    ).toThrow();
    expect(() =>
      CourseRefSchema.parse({ scope, key: 'k', native: { kind: 'ykt', classroomId: 'NaN' } }),
    ).toThrow();
    expect(() =>
      CourseRefSchema.parse({ scope, key: 'k', native: { kind: 'ykt', classroomId: 'Infinity' } }),
    ).toThrow();
  });

  it('allows zhs smallLessonId "0" as the documented exception', () => {
    expect(() => zhsResource('0')).not.toThrow();
    expect(keyOfResource(zhsResource('0'))).toBe(keyOfResource(zhsResource('0')));
  });

  it('rejects numeric ids beyond the safe integer range', () => {
    expect(() =>
      CourseRefSchema.parse({
        scope,
        key: 'k',
        native: { kind: 'ykt', classroomId: '9007199254740993' },
      }),
    ).toThrow();
    expect(() =>
      CourseRefSchema.parse({
        scope,
        key: 'k',
        native: { kind: 'ykt', classroomId: '9007199254740991' },
      }),
    ).not.toThrow();
  });

  it('rejects NaN/Infinity and unsafe integers in numeric fields', () => {
    const base = {
      resource: yktResource(null),
    } as const;
    expect(() =>
      ProgressSchema.parse({ ...base, serverFraction: Number.NaN, observedAtMs: 1 }),
    ).toThrow();
    expect(() =>
      ProgressSchema.parse({ ...base, serverFraction: Number.POSITIVE_INFINITY, observedAtMs: 1 }),
    ).toThrow();
    expect(() =>
      ProgressSchema.parse({
        ...base,
        serverFraction: 0.5,
        observedAtMs: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toThrow();
    expect(() =>
      ProgressSchema.parse({ ...base, serverFraction: 0.5, observedAtMs: 1.5 }),
    ).toThrow();
    expect(() =>
      ProgressSchema.parse({ ...base, serverFraction: 0.5, observedAtMs: 1, durationSeconds: -1 }),
    ).toThrow();
  });

  it('rejects unknown platform', () => {
    expect(() => ScopeSchema.parse({ userId: 'local', profileId: 'p1', platform: 'foo' })).toThrow();
  });
});

describe('page and outline contracts', () => {
  it('keeps completeness unknown without coercing to complete (A022)', () => {
    const Page = PageSchemaOf(WarningSchema);
    const page = Page.parse({
      items: [],
      nextCursor: null,
      completeness: 'unknown',
      warnings: [],
    });
    expect(page.completeness).toBe('unknown');
    expect(() =>
      Page.parse({ items: [], nextCursor: null, completeness: 'maybe', warnings: [] }),
    ).toThrow();
  });

  it('outline nodes may have children and resources at once', () => {
    const node = OutlineNodeSchema.parse({
      id: 'n1',
      title: 'chapter',
      children: [{ id: 'n2', title: 'section', children: [], resources: [] }],
      resources: [
        {
          ref: yktResource(null),
          title: 'video',
          kind: 'video',
          path: ['chapter'],
          order: 1,
          durationSeconds: 100,
          locked: false,
        },
      ],
    });
    expect(node.children).toHaveLength(1);
    expect(node.resources).toHaveLength(1);
  });

  it('answer variants parse, including unset', () => {
    expect(AnswerSchema.parse({ kind: 'unset' }).kind).toBe('unset');
    expect(AnswerSchema.parse({ kind: 'judgement', value: true }).kind).toBe('judgement');
    expect(
      AnswerSchema.parse({ kind: 'fill-blank', blanks: [{ id: 'b1', text: 'x' }] }).kind,
    ).toBe('fill-blank');
  });

  it('error data parses and LearningError carries the payload', () => {
    const data = ErrorDataSchema.parse({
      code: 'INVALID_INPUT',
      message: 'bad',
      retryAfterMs: null,
      operationId: null,
    });
    const error = new LearningError(data);
    expect(error.data.code).toBe('INVALID_INPUT');
    expect(error.message).toBe('bad');
  });
});

describe('keyOf* input validation throws LearningError', () => {
  it('wraps schema failures as INVALID_INPUT', () => {
    const bad = { ...yktCourse, native: { kind: 'ykt', classroomId: '0' } } as typeof yktCourse;
    expect(() => keyOfCourse(bad)).toThrow(LearningError);
    try {
      keyOfCourse(bad);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(LearningError);
      expect((error as LearningError).data.code).toBe('INVALID_INPUT');
    }
  });
});

describe('MemoryStateStore', () => {
  it('creates on expected-null then rejects stale expected (T03 snippet)', async () => {
    const store = new MemoryStateStore();
    await store.commit({ expected: [{ key: 'a', revision: null }], changes: [{ key: 'a', value: 1 }] });
    expect(
      await store.commit({ expected: [{ key: 'a', revision: null }], changes: [{ key: 'a', value: 2 }] }),
    ).toBe(false);
    expect((await store.get('a'))?.value).toBe(1);
  });

  it('multi-key commits are atomic (A031 preview)', async () => {
    const store = new MemoryStateStore();
    await store.commit({ expected: [{ key: 'a', revision: null }], changes: [{ key: 'a', value: 1 }] });
    const ok = await store.commit({
      expected: [
        { key: 'a', revision: 1 },
        { key: 'b', revision: null },
      ],
      changes: [
        { key: 'a', value: 2 },
        { key: 'b', value: 3 },
      ],
    });
    expect(ok).toBe(true);
    const stale = await store.commit({
      expected: [
        { key: 'a', revision: 1 },
        { key: 'b', revision: 1 },
      ],
      changes: [
        { key: 'a', value: 9 },
        { key: 'b', value: 9 },
      ],
    });
    expect(stale).toBe(false);
    expect((await store.get('a'))?.value).toBe(2);
    expect((await store.get('b'))?.value).toBe(3);
  });

  it('delete via null value and list with prefix/cursor', async () => {
    const store = new MemoryStateStore();
    for (const key of ['job:1', 'job:2', 'job:3', 'profile:1']) {
      await store.commit({ expected: [{ key, revision: null }], changes: [{ key, value: key }] });
    }
    expect((await store.get('profile:1'))?.value).toBe('profile:1');
    const deleted = await store.commit({
      expected: [{ key: 'job:2', revision: 1 }],
      changes: [{ key: 'job:2', value: null }],
    });
    expect(deleted).toBe(true);
    expect(await store.get('job:2')).toBeNull();
    const page1 = await store.list('job:', null, 2);
    expect(page1.items.map((x) => x.key)).toEqual(['job:1', 'job:3']);
    expect(page1.nextCursor).toBeNull();
  });
});
