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
