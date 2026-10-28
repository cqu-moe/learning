import { z } from 'zod';
import { LearningError } from '@learning/sdk';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function errorFrom(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof LearningError) {
    const data = error.data;
    const actionable: Record<string, [number, string]> = {
      UNSUPPORTED: [422, '平台暂不支持所选操作，请选择其他任务类型。'],
      INTERACTION_REQUIRED: [409, '需要人工处理，请先在平台检查资源、题目或验证，再重试。'],
      MISSING_RUNTIME: [503, '所需的本机处理能力尚未配置，请选择其他导出格式。'],
      CONTENT_UNREADABLE: [409, '内容尚未完整解析，暂时无法继续。'],
      INTEGRITY: [409, '本地文件或任务记录不完整，请保留记录后检查。'],
      BUDGET: [422, '任务超出处理限制，请缩小选择范围。'],
    };
    const known = actionable[data.code];
    if (known) return new HttpError(known[0], data.code, known[1]);
    const status = data.code === 'AUTH_REQUIRED' || data.code === 'AUTH_EXPIRED' ? 401
      : data.code === 'FORBIDDEN' ? 403
        : data.code === 'INVALID_INPUT' ? 422
          : data.code === 'CONFLICT' || data.code === 'UNCERTAIN' || data.code === 'PRECONDITION_CHANGED' ? 409
            : data.code === 'NETWORK' || data.code === 'TIMEOUT' || data.code === 'PROTOCOL' ? 502 : 500;
    const message = data.code === 'AUTH_REQUIRED' || data.code === 'AUTH_EXPIRED' ? '登录已失效，请重新登录。'
      : data.code === 'FORBIDDEN' ? '无权访问该资源。'
        : data.code === 'INVALID_INPUT' ? '请求参数无效。'
          : data.code === 'CONFLICT' ? '本地状态冲突，请重试。'
            : data.code === 'UNCERTAIN' ? '写入结果尚未确认，请先核对。'
              : data.code === 'PRECONDITION_CHANGED' ? '资源状态已变化，请刷新后重试。'
                : data.code === 'NETWORK' ? '暂时无法连接平台。'
                  : data.code === 'TIMEOUT' ? '平台请求超时。'
                    : data.code === 'PROTOCOL' ? '平台响应不符合预期。' : '本地服务内部错误。';
    return new HttpError(status, status === 500 ? 'INTERNAL' : data.code, message);
  }
  if (error instanceof z.ZodError) {
    const first = error.issues[0];
    const path = first?.path.join('.') ?? '';
    return new HttpError(422, 'INVALID_INPUT', path === '' ? '请求体无效。' : `请求字段无效：${path}`);
  }
  return new HttpError(500, 'INTERNAL', '本地服务内部错误。');
}
