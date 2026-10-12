import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { probeMediaDuration } from '../src/runtime/node/media-probe.js';

const roots: string[] = [];

function temp(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `learning-${name}-`));
  roots.push(directory);
  return directory;
}

function ffprobeFixture(directory: string, script: string): string {
  const executable = join(directory, 'ffprobe');
  writeFileSync(executable, `#!${process.execPath}\n${script}\n`, { mode: 0o755 });
  chmodSync(executable, 0o755);
  return directory;
}

function respondingFfprobe(directory: string): string {
  return ffprobeFixture(directory, [
    "const fs = require('node:fs');",
    'if (process.env.FFPROBE_ARGV_PATH) fs.writeFileSync(process.env.FFPROBE_ARGV_PATH, JSON.stringify(process.argv.slice(2)));',
    "process.stderr.write(process.env.FFPROBE_STDERR || '');",
    "process.stdout.write(process.env.FFPROBE_STDOUT || '');",
    'process.exitCode = Number(process.env.FFPROBE_EXIT || 0);',
  ].join('\n'));
}

function hangingFfprobe(directory: string): string {
  return ffprobeFixture(directory, [
    "const fs = require('node:fs');",
    'fs.writeFileSync(process.env.FFPROBE_PID_PATH, String(process.pid));',
    'setInterval(() => {}, 1000);',
  ].join('\n'));
}

async function withPath(path: string, run: () => Promise<unknown>): Promise<void> {
  const previous = process.env.PATH;
  process.env.PATH = path;
  try { await run(); } finally { process.env.PATH = previous; }
}

async function pidFile(path: string): Promise<number> {
  for (let attempt = 0; attempt < 100 && !existsSync(path); attempt++) await delay(10);
  const pid = Number(readFileSync(path, 'utf8'));
  expect(Number.isInteger(pid)).toBe(true);
  return pid;
}

async function expectProcessExited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
      return;
    }
    await delay(10);
  }
  throw new Error(`ffprobe process ${pid} did not exit`);
}

afterEach(() => {
  for (const key of ['FFPROBE_ARGV_PATH', 'FFPROBE_STDOUT', 'FFPROBE_STDERR', 'FFPROBE_EXIT', 'FFPROBE_PID_PATH']) delete process.env[key];
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Node media duration probe', () => {
  it('runs a real ffprobe child with bounded remote-media options and parses duration', async () => {
    const directory = temp('media-probe-success');
    const argvPath = join(directory, 'argv.json');
    process.env.FFPROBE_ARGV_PATH = argvPath;
    process.env.FFPROBE_STDOUT = '{"format":{"duration":"123.480"}}';
    let result: number | null | undefined;
    await withPath(respondingFfprobe(directory), async () => {
      result = await probeMediaDuration('https://media.example.test/video.mp4?token=secret-token');
    });
    expect(result).toBe(123.48);
    expect(JSON.parse(readFileSync(argvPath, 'utf8'))).toEqual([
      '-v', 'error',
      '-protocol_whitelist', 'http,https,tcp,tls',
      '-format_whitelist', 'mov',
      '-max_redirects', '0',
      '-show_entries', 'format=duration',
      '-of', 'json',
      'https://media.example.test/video.mp4?token=secret-token',
    ]);
  });

  it('returns null for invalid output, ffprobe failure, missing tool, and unsafe input', async () => {
    const directory = temp('media-probe-invalid');
    const emptyPath = temp('media-probe-empty');
    const outputs = ['', '{}', '{"format":{"duration":"0"}}', '{"format":{"duration":"-1"}}', '{"format":{"duration":"NaN"}}', '{"format":{"duration":"1e309"}}', 'not-json'];
    await withPath(respondingFfprobe(directory), async () => {
      for (const output of outputs) {
        process.env.FFPROBE_STDOUT = output;
        await expect(probeMediaDuration('https://media.example.test/video.mp4')).resolves.toBeNull();
      }
      process.env.FFPROBE_EXIT = '1';
      process.env.FFPROBE_STDERR = 'fixture ffprobe failed';
      await expect(probeMediaDuration('https://media.example.test/video.mp4?token=secret-token')).resolves.toBeNull();
      await expect(probeMediaDuration('file:///etc/hosts')).resolves.toBeNull();
      await expect(probeMediaDuration('ftp://media.example.test/video.mp4')).resolves.toBeNull();
      await expect(probeMediaDuration('not-a-url')).resolves.toBeNull();
    });
    await withPath(emptyPath, async () => {
      await expect(probeMediaDuration('https://media.example.test/video.mp4')).resolves.toBeNull();
    });
  });

  it('propagates abort, kills the child, and keeps the URL and child stderr out of the error', async () => {
    const directory = temp('media-probe-cancel');
    const pidPath = join(directory, 'ffprobe.pid');
    process.env.FFPROBE_PID_PATH = pidPath;
    process.env.FFPROBE_STDERR = 'fixture ffprobe stderr';
    const controller = new AbortController();
    const secretUrl = 'https://media.example.test/video.mp4?token=secret-token';
    const pending = withPath(hangingFfprobe(directory), async () => probeMediaDuration(secretUrl, { signal: controller.signal }));
    const pid = await pidFile(pidPath);
    controller.abort();
    try {
      await pending;
      throw new Error('probe unexpectedly succeeded');
    } catch (error) {
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(String(error)).not.toContain(secretUrl);
      expect(String(error)).not.toContain('fixture ffprobe stderr');
    }
    await expectProcessExited(pid);
  });

  it('returns null at a deadline and kills the child', async () => {
    const directory = temp('media-probe-deadline');
    const pidPath = join(directory, 'ffprobe.pid');
    process.env.FFPROBE_PID_PATH = pidPath;
    let pid = 0;
    let result: number | null | undefined;
    await withPath(hangingFfprobe(directory), async () => {
      const probe = probeMediaDuration('https://media.example.test/video.mp4', { deadlineAtMs: Date.now() + 1_000 });
      pid = await pidFile(pidPath);
      result = await probe;
    });
    expect(result).toBeNull();
    await expectProcessExited(pid);
  });
});
