import { z } from "zod";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

const ErrorEnvelope = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new ApiError(
      "无法连接本机服务。确认 Learning 仍在运行后重试。",
      503,
      "NETWORK",
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ErrorEnvelope.safeParse(body);
    throw new ApiError(
      parsed.success ? parsed.data.error.message : "请求未完成，请重试。",
      response.status,
      parsed.success ? parsed.data.error.code : "UNKNOWN",
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(
      "收到的数据格式不匹配，请更新 Learning 后重试。",
      502,
      "INVALID_RESPONSE",
    );
  return parsed.data;
}

export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : "操作未完成，请重试。";
}
