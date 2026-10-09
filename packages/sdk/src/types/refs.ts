import { z } from 'zod';
import { parseDto } from './errors.js';
import type { LearningError } from './errors.js';
import { sha256Hex } from './sha256.js';

export const PlatformSchema = z.enum(['ykt', 'xuetang', 'zhs', 'chaoxing']);
export type Platform = z.infer<typeof PlatformSchema>;

export const SystemSchema = z.enum(['ykt-standard', 'ykt-kg', 'xuetang', 'zhs-share', 'zhs-hike', 'chaoxing-mooc']);
export type System = z.infer<typeof SystemSchema>;

const SAFE_INTEGER_MAX = 9007199254740991n;

/**
 * Native platform identifier. Unknown/missing must be null at the model level,
 * never "0" or "" — except the documented zhs smallLessonId="0" exception.
 * Numeric-looking ids must stay within the safe integer range.
 */
export function safeId(options: { allowZero?: boolean } = {}) {
  return z
    .string()
    .min(1, 'id must be non-empty')
    .refine((v) => v === v.trim(), 'id must not have surrounding whitespace')
    .refine((v) => options.allowZero === true || v !== '0', 'id 0 is a masked unknown')
    .refine((v) => v !== 'NaN' && v !== 'Infinity' && v !== '-Infinity', 'id is not a number token')
    .refine((v) => {
      if (!/^-?\d+$/.test(v)) return true;
      const asBigInt = BigInt(v);
      return asBigInt >= -SAFE_INTEGER_MAX && asBigInt <= SAFE_INTEGER_MAX;
    }, 'numeric id exceeds the safe integer range');
}

/** Opaque platform token: stable as a string, but not necessarily a safe JS number. */
const opaqueId = z
  .string()
  .min(1)
  .refine((v) => v === v.trim(), 'opaque id must not have surrounding whitespace')
  .refine(
    (v) => !Array.from(v).some((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    }),
    'opaque id contains a control character',
  );

export const ScopeSchema = z.object({
  userId: z.string().min(1),
  profileId: z.string().min(1),
  platform: PlatformSchema,
});
export type Scope = z.infer<typeof ScopeSchema>;

export const CourseLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ykt'), classroomId: safeId() }),
  z.object({
    kind: z.literal('xuetang'),
    classroomId: safeId(),
    courseSign: safeId(),
    skuId: safeId(),
  }),
  z.object({ kind: z.literal('zhs-share'), recruitAndCourseId: safeId() }),
  z.object({ kind: z.literal('zhs-hike'), courseId: safeId() }),
  z.object({
    kind: z.literal('chaoxing'),
    courseId: safeId(),
    clazzId: safeId(),
    cpi: safeId(),
  }),
]);
export type CourseLocator = z.infer<typeof CourseLocatorSchema>;

export const CourseRefSchema = z.object({
  scope: ScopeSchema,
  key: z.string().min(1),
  native: CourseLocatorSchema,
});
export type CourseRef = z.infer<typeof CourseRefSchema>;

export const ResourceLocatorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ykt'), leafId: safeId(), leafInfoId: safeId().nullable() }),
  z.object({ kind: z.literal('xuetang'), leafId: safeId(), leafInfoId: safeId().nullable() }),
  z.object({
    kind: z.literal('zhs-share'),
    chapterId: safeId(),
    lessonId: safeId(),
    smallLessonId: safeId({ allowZero: true }),
    videoId: safeId(),
  }),
  z.object({ kind: z.literal('zhs-hike'), fileId: safeId() }),
  z.object({
    kind: z.literal('chaoxing'),
    knowledgeId: safeId(),
    cardIndex: z.number().refine(Number.isSafeInteger).nonnegative(),
    objectId: opaqueId,
    jobid: safeId(),
    mid: opaqueId,
  }),
]);
export type ResourceLocator = z.infer<typeof ResourceLocatorSchema>;

export const ResourceRefSchema = z.object({
  course: CourseRefSchema,
  key: z.string().min(1),
  native: ResourceLocatorSchema,
});
export type ResourceRef = z.infer<typeof ResourceRefSchema>;

export const LessonRefSchema = z.object({
  scope: ScopeSchema,
  course: CourseRefSchema.nullable(),
  lessonId: z.string().min(1),
});
export type LessonRef = z.infer<typeof LessonRefSchema>;

export const AssessmentRefSchema = z.object({
  resource: ResourceRefSchema,
  kind: z.enum(['homework', 'exam', 'embedded']),
  assessmentId: z.string().min(1),
});
export type AssessmentRef = z.infer<typeof AssessmentRefSchema>;

export const ThreadRefSchema = z.object({
  resource: ResourceRefSchema,
  topicId: z.string().min(1),
});
export type ThreadRef = z.infer<typeof ThreadRefSchema>;

function courseTuple(native: CourseLocator): string[] {
  switch (native.kind) {
    case 'ykt':
      return ['ykt', native.classroomId];
    case 'xuetang':
      return ['xuetang', native.classroomId, native.courseSign, native.skuId];
    case 'zhs-share':
      return ['zhs-share', native.recruitAndCourseId];
    case 'zhs-hike':
      return ['zhs-hike', native.courseId];
    case 'chaoxing':
      return ['chaoxing', native.courseId, native.clazzId, native.cpi];
  }
}

function resourceTuple(native: ResourceLocator): (string | null)[] {
  switch (native.kind) {
    case 'ykt':
      return ['ykt', native.leafId, native.leafInfoId];
    case 'xuetang':
      return ['xuetang', native.leafId, native.leafInfoId];
    case 'zhs-share':
      return [
        'zhs-share',
        native.chapterId,
        native.lessonId,
        native.smallLessonId,
        native.videoId,
      ];
    case 'zhs-hike':
      return ['zhs-hike', native.fileId];
    case 'chaoxing':
      return ['chaoxing', native.knowledgeId, String(native.cardIndex), native.objectId, native.jobid, native.mid];
  }
}

/** Stable course key: SHA256(JSON.stringify(["learning.course.v1", userId, profileId, platform, ...tuple])). */
export function keyOfCourse(ref: CourseRef): string {
  const parsed = parseDto(CourseRefSchema, ref, 'CourseRef');
  return sha256Hex(
    JSON.stringify([
      'learning.course.v1',
      parsed.scope.userId,
      parsed.scope.profileId,
      parsed.scope.platform,
      ...courseTuple(parsed.native),
    ]),
  );
}

/** Stable resource key: course key is included, so the same video in two places stays two resources. */
export function keyOfResource(ref: ResourceRef): string {
  const parsed = parseDto(ResourceRefSchema, ref, 'ResourceRef');
  const courseKey = keyOfCourse(parsed.course);
  return sha256Hex(
    JSON.stringify([
      'learning.resource.v1',
      parsed.course.scope.userId,
      parsed.course.scope.profileId,
      parsed.course.scope.platform,
      courseKey,
      ...resourceTuple(parsed.native),
    ]),
  );
}

// Re-exported for callers that need the error type alongside key computation.
export type { LearningError };
