import { z } from 'zod';
import {
  CourseSchema,
  JobSchema,
  LessonSchema,
  PreviewSchema,
  ResourceSchema,
} from '../../types/models.js';
import { ResourceRefSchema, ScopeSchema } from '../../types/refs.js';
import type { Scope } from '../../types/refs.js';
import type { Runtime } from '../types.js';

const PreferencesSchema = z.object({
  version: z.literal(1),
  defaultProfileId: z.string().nullable(),
  downloadDir: z.string().nullable(),
});

function sameScope(left: Scope, right: Scope): boolean {
  return left.userId === right.userId && left.profileId === right.profileId && left.platform === right.platform;
}

/** Remove profile-owned local state and blobs, but leave the profile record itself. */
export async function removeLocalProfileData(runtime: Runtime, scope: Scope): Promise<void> {
  const target = ScopeSchema.parse(scope);
  const deletions = new Map<string, number>();
  const artifactIds = new Set<string>();
  const queue = async (key: string): Promise<void> => {
    const record = await runtime.state.get(key);
    if (record !== null) deletions.set(key, record.revision);
  };
  const all = async (prefix: string) => {
    const rows: Array<{ key: string; record: { revision: number; value: unknown } }> = [];
    let cursor: string | null = null;
    do {
      const page = await runtime.state.list(prefix, cursor, 100);
      rows.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return rows;
  };

  for (const row of await all('job:')) {
    const job = JobSchema.parse(row.record.value);
    if (!sameScope(job.scope, target)) continue;
    deletions.set(row.key, row.record.revision);
    for (const suffix of ['job-meta:', 'job-input:', 'job-events:', 'cli:job-output:']) {
      await queue(`${suffix}${job.id}`);
    }
    for (const item of job.items) {
      for (const artifact of item.artifacts) {
        if (sameScope(artifact.scope, target)) artifactIds.add(artifact.id);
      }
    }
    for (const prefix of ['download:', 'hls:']) {
      const checkpointPrefix = `${prefix}${job.id}:`;
      for (const checkpoint of await all(checkpointPrefix)) {
        deletions.set(checkpoint.key, checkpoint.record.revision);
        artifactIds.add(`${job.id}:${checkpoint.key.slice(checkpointPrefix.length)}:media`);
      }
    }
  }

  for (const row of await all('cli:course:')) {
    const course = CourseSchema.parse(row.record.value);
    if (sameScope(course.ref.scope, target)) deletions.set(row.key, row.record.revision);
  }
  for (const row of await all('cli:resource:')) {
    const resource = ResourceRefSchema.parse(row.record.value);
    if (!sameScope(resource.course.scope, target)) continue;
    deletions.set(row.key, row.record.revision);
    for (const suffix of ['cli:resource-kind:', 'cli:resource-title:', 'cli:resource-path:']) {
      await queue(`${suffix}${resource.key}`);
    }
  }

  for (const row of await all('web:resource:')) {
    const resource = ResourceSchema.parse(row.record.value);
    if (sameScope(resource.ref.course.scope, target)) deletions.set(row.key, row.record.revision);
  }
  for (const row of await all('web:lesson:')) {
    const lesson = LessonSchema.parse(row.record.value);
    if (sameScope(lesson.ref.scope, target)) deletions.set(row.key, row.record.revision);
  }

  for (const row of await all('preview:')) {
    const operation = z.object({
      preview: PreviewSchema,
      operationId: z.string().min(1),
    }).parse(row.record.value);
    if (!sameScope(operation.preview.scope, target)) continue;
    deletions.set(row.key, row.record.revision);
    await queue(`operation:${operation.operationId}`);
  }

  const preferencesKey = 'cli:preferences';
  const preferencesRecord = await runtime.state.get(preferencesKey);
  let preferencesNext: z.infer<typeof PreferencesSchema> | undefined;
  if (preferencesRecord !== null) {
    const preferences = PreferencesSchema.parse(preferencesRecord.value);
    if (preferences.defaultProfileId === target.profileId) {
      preferencesNext = { ...preferences, defaultProfileId: null };
    }
  }

  const expected = [...deletions].map(([key, revision]) => ({ key, revision }));
  const changes: Array<{ key: string; value: null | z.infer<typeof PreferencesSchema> }> =
    [...deletions.keys()].map(key => ({ key, value: null }));
  if (preferencesNext !== undefined) {
    expected.push({ key: preferencesKey, revision: preferencesRecord!.revision });
    changes.push({ key: preferencesKey, value: preferencesNext });
  }
  if (expected.length > 0) {
    const ok = await runtime.state.commit({ expected, changes });
    if (!ok) throw new Error('profile records changed while removing them');
  }
  for (const id of artifactIds) await runtime.artifacts.remove(id);
}
