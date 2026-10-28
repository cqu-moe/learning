import { z } from 'zod';
import {
  CourseSchema,
  JobSchema,
  JobEventSchema,
  LessonSchema,
  OutlineSchema,
  ScopeSchema,
  WarningSchema,
} from '@learning/sdk/public';

export const PlatformSchema = z.enum(['ykt', 'xuetang', 'zhs']);
export const ProfileSchema = z.object({
  name: z.string().min(1).max(128),
  scope: ScopeSchema,
  hasSession: z.boolean(),
});
export const DashboardSchema = z.object({
  profiles: z.array(ProfileSchema),
  courses: z.array(CourseSchema),
  jobs: z.array(JobSchema),
  updatedAtMs: z.number().int().nonnegative(),
  defaultProfileId: z.string().nullable(),
  writer: z.object({ state: z.enum(['idle', 'active', 'stale', 'unknown']), pid: z.number().int().positive().nullable() }),
});
export const ProfileControlInputSchema = z.strictObject({ action: z.enum(['default', 'probe', 'disconnect', 'remove']) });
export const UnlockInputSchema = z.strictObject({ pid: z.number().int().positive() });
export const CoursePageSchema = z.object({
  items: z.array(CourseSchema),
  nextCursor: z.string().nullable(),
  completeness: z.enum(['complete', 'more', 'unknown']),
  warnings: z.array(WarningSchema),
});
export const OutlineResultSchema = z.object({
  value: OutlineSchema,
  warnings: z.array(WarningSchema),
});
export const CreateProfileInputSchema = z.strictObject({
  name: z.string().min(1).max(128),
  platform: PlatformSchema,
});
export const StartLoginInputSchema = z.strictObject({});
export const JobControlInputSchema = z.strictObject({
  action: z.enum(['pause', 'cancel', 'resume']),
});

const resourceSelection = { courseKey: z.string().min(1), resourceKeys: z.array(z.string().min(1)).min(1).max(500) };
export const TaskInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('study'), ...resourceSelection, speed: z.number().min(1).max(5), targetPercent: z.number().min(1).max(100), maxMinutes: z.number().int().min(1).max(1440) }),
  z.strictObject({ kind: z.literal('media'), ...resourceSelection, quality: z.enum(['best', 'hd', 'sd']), subtitles: z.boolean() }),
  z.strictObject({ kind: z.literal('assessments'), ...resourceSelection, format: z.enum(['json', 'markdown', 'yaml']) }),
  z.strictObject({ kind: z.literal('slides'), courseKey: z.string().min(1), lessonIds: z.array(z.string().min(1)).min(1).max(500), format: z.enum(['images', 'pdf']) }),
  z.strictObject({ kind: z.literal('live'), courseKey: z.string().min(1), lessonId: z.string().min(1), maxMinutes: z.number().int().min(1).max(1440) }),
]);
export type TaskInput = z.infer<typeof TaskInputSchema>;
export const TaskPreviewSchema = z.object({
  id: z.string(), kind: z.enum(['study', 'media', 'assessments', 'slides', 'live']),
  courseTitle: z.string(), profileName: z.string(), items: z.array(z.string()),
  settings: z.array(z.string()), warnings: z.array(z.string()), blockers: z.array(z.string()),
  expiresAtMs: z.number(),
});
export type TaskPreview = z.infer<typeof TaskPreviewSchema>;
export const LessonPageSchema = z.object({ items: z.array(LessonSchema), nextCursor: z.string().nullable(), completeness: z.enum(['complete', 'more', 'unknown']), warnings: z.array(WarningSchema) });
export const JobDetailSchema = z.object({ job: JobSchema, active: z.boolean(), error: z.string().nullable(), events: z.array(JobEventSchema), itemTitles: z.record(z.string(), z.string()).default({}) });
export type JobDetail = z.infer<typeof JobDetailSchema>;
export const ReconcileResultSchema = z.object({ job: JobSchema, state: z.enum(['confirmed', 'uncertain', 'rejected']), message: z.string() });
export const LoginQrSchema = z.strictObject({
  imageDataUrl: z.string().nullable(),
  url: z.string().nullable(),
  expiresAtMs: z.number().int().nonnegative(),
});
export const LoginStateSchema = z.strictObject({
  id: z.string().min(1),
  status: z.enum(['waiting', 'scanned', 'exchanging', 'authenticated', 'failed', 'canceled']),
  qr: LoginQrSchema.nullable(),
  message: z.string().nullable(),
});
export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string().min(1),
    message: z.string().min(1),
  }),
});

export type Platform = z.infer<typeof PlatformSchema>;
export type Profile = z.infer<typeof ProfileSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type CoursePage = z.infer<typeof CoursePageSchema>;
export type OutlineResult = z.infer<typeof OutlineResultSchema>;
export type CreateProfileInput = z.infer<typeof CreateProfileInputSchema>;
export type StartLoginInput = z.infer<typeof StartLoginInputSchema>;
export type JobControlInput = z.infer<typeof JobControlInputSchema>;
export type LoginQr = z.infer<typeof LoginQrSchema>;
export type LoginState = z.infer<typeof LoginStateSchema>;
export type ApiError = z.infer<typeof ApiErrorSchema>;
