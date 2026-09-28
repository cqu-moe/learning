import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it, afterAll } from 'vitest';
const home = mkdtempSync(resolve(tmpdir(), 'learning-preferences-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
function run(args: string[]) {
 const result = spawnSync(process.execPath, [resolve(import.meta.dirname, '../dist/index.js'), '--home', home, ...args, '--json'], { encoding: 'utf8' });
 return { code: result.status, result: JSON.parse(result.stdout) };
}
describe('explicit local preferences', () => {
 it('persists, reads, and clears a default by stable profile ID', () => {
  expect(run(['init']).code).toBe(0);
  const profile = run(['profile','add','alpha','--platform','ykt']).result.data;
  expect(run(['config','set','default-profile','alpha']).code).toBe(0);
  expect(run(['config','show']).result.data.defaultProfileId).toBe(profile.scope.profileId);
  expect(run(['config','set','download-dir',home]).code).toBe(0);
  expect(run(['config','show']).result.data.downloadDir).toBe(home);
  expect(run(['profile','list','--profile','missing']).code).toBe(0);
  expect(run(['config','show']).result.data.defaultProfileId).toBe(profile.scope.profileId);
  expect(run(['profile','remove','alpha','--yes']).code).toBe(0);
  expect(run(['config','show']).result.data.defaultProfileId).toBe(null);
  expect(run(['config','unset','download-dir']).code).toBe(0);
  expect(run(['config','show']).result.data.downloadDir).toBe(null);
 });
 it('rejects unknown preferences and unknown account names', () => {
  expect(run(['config','set','speed','5']).code).toBe(2);
  expect(run(['config','set','default-profile','missing']).code).toBe(2);
 });
});

it('does not fall back from a missing saved profile, but honors an explicit profile', async () => {
 const { SqliteStateStore } = await import('@learning/sdk/node');
 const { savePreferences } = await import('../src/preferences.js');
 expect(run(['profile','add','beta','--platform','ykt']).code).toBe(0);
 const state = new SqliteStateStore(resolve(home, 'state.db'));
 await savePreferences(state, { defaultProfileId: 'missing-id' });
 state.close();
 expect(run(['whoami']).code).toBe(2);
 expect(run(['whoami','--profile','beta']).code).toBe(0);
 expect(run(['config','show']).result.data.defaultProfileId).toBe('missing-id');
});

it('freezes the export destination for a job across preference changes', async () => {
 const { SqliteStateStore } = await import('@learning/sdk/node');
 const { setJobOutputRoot, getJobOutputRoot, savePreferences } = await import('../src/preferences.js');
 const state = new SqliteStateStore(resolve(home,'state.db'));
 try {
  await setJobOutputRoot(state,'job-one',home);
  await savePreferences(state,{ downloadDir: resolve(home,'elsewhere') });
  expect(await getJobOutputRoot(state,'job-one')).toBe(home);
  await expect(setJobOutputRoot(state,'job-one',resolve(home,'elsewhere'))).rejects.toMatchObject({ code: 'CONFLICT' });
 } finally { state.close(); }
});

it('uses a saved job owner rather than an unrelated default profile', async () => {
 const { SqliteStateStore } = await import('@learning/sdk/node');
 const state = new SqliteStateStore(resolve(home,'state.db'));
 try {
  const profile = await state.get('cli:profile:beta');
  const scope = (profile!.value as { scope: { userId: string; profileId: string; platform: 'ykt' } }).scope;
  const job = { id:'owned-job', scope, kind:'export', status:'paused', createdAtMs:1, updatedAtMs:1, nextRunAtMs:null, completed:0, total:0, items:[], warnings:[] };
  await state.commit({expected:[{key:'job:owned-job',revision:null},{key:'job-meta:owned-job',revision:null}],changes:[{key:'job:owned-job',value:job},{key:'job-meta:owned-job',value:{inputDigest:'x',generation:1,cursor:null,pendingOperationId:null,running:false}}]});
 } finally {state.close();}
 const canceled = run(['jobs','cancel','owned-job','--yes']);
 expect(canceled.code).toBe(0);
 expect(canceled.result.data.status).toBe('canceled');
 expect(run(['config','show']).result.data.defaultProfileId).toBe('missing-id');
});
