import { z } from 'zod';
import type { SqliteStateStore } from '@learning/sdk/node';
import { CliError } from './output.js';
export const PreferencesSchema = z.object({ version: z.literal(1), defaultProfileId: z.string().nullable(), downloadDir: z.string().nullable() });
export type Preferences = z.infer<typeof PreferencesSchema>;
const empty: Preferences = { version: 1, defaultProfileId: null, downloadDir: null };
export async function readPreferences(state: SqliteStateStore): Promise<Preferences> {
  const record = await state.get('cli:preferences');
  return record === null ? { ...empty } : PreferencesSchema.parse(record.value);
}
export async function savePreferences(state: SqliteStateStore, patch: Partial<Pick<Preferences, 'defaultProfileId' | 'downloadDir'>>): Promise<Preferences> {
  const key = 'cli:preferences';
  const old = await state.get(key);
  const next = PreferencesSchema.parse({ ...(old === null ? empty : PreferencesSchema.parse(old.value)), ...patch });
  if (!await state.commit({ expected: [{ key, revision: old?.revision ?? null }], changes: [{ key, value: next }] })) throw new CliError('CONFLICT', '偏好已被另一个操作修改，请重试。', 3);
  return next;
}

export async function getJobOutputRoot(state: SqliteStateStore, jobId: string): Promise<string | null> {
  const record = await state.get(`cli:job-output:${jobId}`);
  return record === null ? null : z.string().min(1).parse(record.value);
}
export async function setJobOutputRoot(state: SqliteStateStore, jobId: string, path: string): Promise<void> {
  const key = `cli:job-output:${jobId}`;
  const old = await state.get(key);
  if (old !== null) { if (old.value !== path) throw new CliError('CONFLICT', '此任务已有不同的导出目录。', 3); return; }
  if (!await state.commit({ expected: [{ key, revision: null }], changes: [{ key, value: path }] })) throw new CliError('CONFLICT', '任务导出目录已被修改。', 3);
}
