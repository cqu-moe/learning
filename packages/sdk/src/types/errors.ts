import { z } from 'zod';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().refine(Number.isFinite, 'JSON numbers must be finite'),
    z.string(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);

export const ErrorCodeSchema = z.enum([
  'INVALID_INPUT',
  'AUTH_REQUIRED',
  'AUTH_EXPIRED',
  'FORBIDDEN',
  'INTERACTION_REQUIRED',
  'NETWORK',
  'TIMEOUT',
  'RATE_LIMITED',
  'PROTOCOL',
  'UNSUPPORTED',
  'MISSING_RUNTIME',
  'CONFLICT',
  'PREVIEW_EXPIRED',
  'PRECONDITION_CHANGED',
  'UNCERTAIN',
  'CANCELED',
  'BUDGET',
  'INTEGRITY',
  'CONTENT_UNREADABLE',
  'STORAGE',
  'VERSION',
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

const nonNegativeInt = z.number().refine(Number.isFinite).refine(Number.isSafeInteger).nonnegative();
const nonNegativeIntNullable = nonNegativeInt.nullable();
const stringNullable = z.string().nullable();

export const ErrorDataSchema = z.object({
  code: ErrorCodeSchema,
  message: z.string().min(1),
  retryAfterMs: nonNegativeIntNullable,
  operationId: stringNullable,
});
export type ErrorData = z.infer<typeof ErrorDataSchema>;

/** SDK error carrying a safe ErrorData payload (S08). */
export class LearningError extends Error {
  readonly data: ErrorData;

  constructor(data: ErrorData) {
    super(data.message);
    this.name = 'LearningError';
    this.data = data;
  }
}

export const WarningSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  resourceKey: stringNullable,
});
export type Warning = z.infer<typeof WarningSchema>;

export function ResultSchemaOf<T extends z.ZodType>(item: T) {
  return z.object({ value: item, warnings: z.array(WarningSchema) });
}

export const PageInputSchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z
    .number()
    .refine(Number.isFinite)
    .refine(Number.isSafeInteger)
    .positive()
    .max(200)
    .optional(),
});
export type PageInput = z.infer<typeof PageInputSchema>;

export type Completeness = 'complete' | 'more' | 'unknown';

export function PageSchemaOf<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: stringNullable,
    completeness: z.enum(['complete', 'more', 'unknown']),
    warnings: z.array(WarningSchema),
  });
}

/** Parse through a DTO schema or throw LearningError(INVALID_INPUT) with a safe message. */
export function parseDto<T extends z.ZodType>(schema: T, value: unknown, label: string): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first ? first.path.join('.') : '';
    const detail = first ? String(first.message) : 'validation failed';
    throw new LearningError({
      code: 'INVALID_INPUT',
      message: `${label} invalid${path ? ` at ${path}` : ''}: ${detail}`,
      retryAfterMs: null,
      operationId: null,
    });
  }
  return result.data;
}
