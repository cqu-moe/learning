import { LearningError } from '../../types/errors.js';
import type { Clock } from '../../runtime/types.js';
import type { SessionHttp } from '../../http/client.js';
import { AesCipher, HOME_KEY } from './crypto.js';

const ONLINESERVICE = 'https://onlineservice-api.zhihuishu.com';
const STUDY = 'https://studyservice-api.zhihuishu.com';

function checkCode(payload: { code?: unknown; message?: unknown; msg?: unknown }, url: string): void {
  const code = payload.code;
  if (code === undefined || code === null) return;
  const numeric = typeof code === 'number' ? code : Number(code);
  if (numeric === -12) {
    throw new LearningError({ code: 'INTERACTION_REQUIRED', message: 'zhs captcha triggered (code=-12); continue in the official web app', retryAfterMs: null, operationId: null });
  }
  if (numeric !== 0 && numeric !== 200) {
    throw new LearningError({ code: 'PROTOCOL', message: `${url} code=${numeric}`, retryAfterMs: null, operationId: null });
  }
}

export async function homeQuery(
  http: SessionHttp,
  clock: Clock,
  path: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const date = clock.nowMs();
  const secretStr = await new AesCipher(HOME_KEY).encrypt(JSON.stringify(data));
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${ONLINESERVICE}/gateway${path}?secretStr=${encodeURIComponent(secretStr)}&date=${date}`,
  });
  const payload = (await response.json()) as Record<string, unknown>;
  checkCode(payload, path);
  return payload;
}

export async function zhidaoQuery(
  http: SessionHttp,
  clock: Clock,
  path: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dateFormate = Math.trunc(clock.nowMs() / 1000) * 1000;
  const secretStr = await new AesCipher(HOME_KEY).encrypt(JSON.stringify({ ...data, dateFormate }));
  const response = await http.request({
    kind: 'read',
    method: 'POST',
    url: `${STUDY}/gateway${path}?dateFormate=${dateFormate}`,
    body: `secretStr=${encodeURIComponent(secretStr)}&dateFormate=${dateFormate}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: STUDY, referer: `${STUDY}/` },
  });
  const payload = (await response.json()) as Record<string, unknown>;
  checkCode(payload, path);
  return payload;
}
