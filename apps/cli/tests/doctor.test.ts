import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const cliEntry = resolve(import.meta.dirname, '../dist/index.js');
const tempRoots: string[] = [];

function runDoctor(options: { json?: boolean; path?: string } = {}) {
  const home = mkdtempSync(resolve(tmpdir(), 'learning-doctor-'));
  tempRoots.push(home);
  return spawnSync(process.execPath, [cliEntry, 'doctor', ...(options.json ? ['--json'] : []), '--home', home], {
    cwd: home,
    env: { ...process.env, PATH: options.path ?? '', LEARNING_HOME: home },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 4000,
  });
}

function ffprobePath(script: string): string {
  const directory = mkdtempSync(resolve(tmpdir(), 'learning-ffprobe-'));
  tempRoots.push(directory);
  writeFileSync(resolve(directory, 'ffprobe'), `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  return directory;
}

afterAll(() => {
  for (const directory of tempRoots) rmSync(directory, { recursive: true, force: true });
});

describe('doctor optional dependencies', () => {
  it('reports an available ffprobe and the actual runtime', () => {
    const result = runDoctor({ json: true, path: ffprobePath('console.log("ffprobe version 8.2.1"); console.log("Copyright (c) fixture");') });
    expect(result.status).toBe(0);
    const status = JSON.parse(result.stdout).data;
    expect(status.ffprobe).toEqual({ available: true, version: '8.2.1' });
    expect(status.runtime).toBe('Node');
    expect(status.node).toBe(process.version);
  });

  it('keeps doctor healthy when ffprobe is missing and explains the limited impact', () => {
    const result = runDoctor();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ffprobe：未安装（仅影响缺失视频时长兜底）');
  });

  it('treats invalid ffprobe output as unavailable', () => {
    const result = runDoctor({ json: true, path: ffprobePath("process.stdout.write('not ffprobe');") });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.ffprobe).toEqual({ available: false, version: null });
  });

  it('treats a failing ffprobe as unavailable', () => {
    const result = runDoctor({ json: true, path: ffprobePath("process.stdout.write('ffprobe version 8.2.1'); process.exitCode = 7;") });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.ffprobe).toEqual({ available: false, version: null });
  });

  it('bounds a hanging ffprobe call', () => {
    const startedAt = Date.now();
    const result = runDoctor({ json: true, path: ffprobePath("setTimeout(() => process.stdout.write('ffprobe version 8.2.1'), 1900);") });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).data.ffprobe).toEqual({ available: false, version: null });
    expect(Date.now() - startedAt).toBeLessThan(4000);
  });
});
