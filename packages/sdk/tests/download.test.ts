import { describe, expect, it } from 'vitest';
import { decideRangeResume, safeFilename, validateManifestScope } from '../src/services/exports.js';

describe('download resume decisions (T23, A231/A232)', () => {
  it('206 with a matching range appends; 200 restarts; 416 without evidence restarts', () => {
    expect(decideRangeResume({ status: 206, contentRangeStart: 1024, expectedOffset: 1024, validatorMatches: true })).toBe('append');
    expect(decideRangeResume({ status: 200, contentRangeStart: 1024, expectedOffset: 1024, validatorMatches: true })).toBe('restart');
    expect(decideRangeResume({ status: 416, contentRangeStart: 0, expectedOffset: 1024, validatorMatches: false })).toBe('restart');
    expect(decideRangeResume({ status: 206, contentRangeStart: 512, expectedOffset: 1024, validatorMatches: true })).toBe('restart');
    expect(decideRangeResume({ status: 206, contentRangeStart: 1024, expectedOffset: 1024, validatorMatches: false })).toBe('restart');
  });

  it('filenames block traversal, reserved names, and unicode case collisions', () => {
    expect(safeFilename('第1章/视频')).toBe('第1章_视频');
    expect(safeFilename('../../etc/passwd')).toBe('______etc_passwd');
    expect(safeFilename('CON')).toBe('CON_');
    expect(safeFilename('Ａ')).not.toBe(safeFilename('Ａ'.normalize('NFKD')));
  });

  it('manifest publication requires matching scope and path checks', () => {
    const scope0 = { userId: 'local', profileId: 'p1', platform: 'ykt' as const };
    const manifest = { scope: scope0, path: 'downloads/第1章_视频.mp4', sha256: 'a'.repeat(64) };
    expect(validateManifestScope(manifest, scope0, 'downloads/第1章_视频.mp4')).toBe(true);
    expect(validateManifestScope(manifest, { ...scope0, profileId: 'p2' }, 'downloads/第1章_视频.mp4')).toBe(false);
    expect(validateManifestScope(manifest, scope0, 'downloads/other.mp4')).toBe(false);
  });
});
