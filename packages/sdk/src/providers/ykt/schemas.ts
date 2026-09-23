import { z } from 'zod';
import { LearningError } from '../../types/errors.js';

export const YKT_BASE = 'https://www.yuketang.cn';

export function moocEnvelopeChecked(payload: unknown, endpoint: string): void {
  if (typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === false) {
    const msg = String((payload as { msg?: unknown }).msg ?? '');
    throw new LearningError({
      code: 'PROTOCOL',
      message: `${endpoint}: success=false ${msg}`.trim(),
      retryAfterMs: null,
      operationId: null,
    });
  }
}

export const PreInfoWire = z.object({
  code: z.number(),
  msg: z.string().optional(),
  data: z.object({ qrContent: z.string().min(1), token: z.string().min(1) }),
});

export const AppLoginWire = z.object({
  code: z.number(),
  data: z.object({ UserID: z.union([z.number(), z.string()]), Auth: z.string().min(1) }).optional(),
});

export const UserinfoWire = z.object({
  errcode: z.number(),
  data: z.object({ id: z.union([z.number(), z.string()]).optional(), name: z.string().optional() }).optional(),
});

export const CourseListWire = z.object({
  errcode: z.number(),
  data: z.object({
    list: z.array(
      z.object({
        classroom_id: z.number().int().positive(),
        term: z.number().int().optional(),
        course: z.object({
          university_id: z.number().int().optional(),
          name: z.string().optional(),
          teachers: z.array(z.object({ name: z.string().optional() })).optional(),
        }),
      }),
    ),
  }),
});

export const ClassroomWire = z.object({
  data: z.object({
    course_sign: z.string().min(1),
    free_sku_id: z.number().int().positive(),
    course_name: z.string().optional(),
    uv_id: z.number().int(),
  }),
});

export const HasKgWire = z.object({
  success: z.boolean().optional(),
  msg: z.string().optional(),
  data: z.object({ has: z.boolean(), kg_id: z.number().int().optional() }),
});

export const RawNode = z.object({
  id: z.number().int().positive().optional(),
  leafinfo_id: z.number().int().optional(),
  name: z.string().optional(),
  leaf_type: z.number().int().nullable().optional(),
  chapter_id: z.number().int().optional(),
  order: z.number().int().optional(),
  leaf_list: z.array(z.unknown()).optional(),
  children: z.array(z.unknown()).optional(),
});
export type RawNode = z.infer<typeof RawNode>;

export const StandardChapterWire = z.object({
  success: z.boolean().optional(),
  msg: z.string().optional(),
  data: z.object({
    course_chapter: z.array(
      z.object({
        id: z.number().int().optional(),
        name: z.string().optional(),
        section_leaf_list: z.array(z.unknown()).optional(),
      }),
    ),
  }),
});

export const KgChapterWire = z.object({
  success: z.boolean().optional(),
  msg: z.string().optional(),
  data: z.object({
    course_chapter: z.object({
      id: z.number().int().optional(),
      name: z.string().optional(),
      leaf_list: z.array(z.unknown()).optional(),
      children: z.array(z.unknown()).optional(),
    }),
  }),
});
