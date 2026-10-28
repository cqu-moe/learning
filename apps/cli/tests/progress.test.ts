import { afterEach, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createOutput } from '../src/output.js';

afterEach(() => { process.exitCode = 0; });

const progress = {
  jobId: 'job-one',
  resourceKey: 'a'.repeat(64),
  status: 'waiting',
  completed: 2,
  total: 95,
  serverFraction: 0.2,
  estimatedSeconds: null,
  title: '1.1 心理与健康',
  durationSeconds: 100,
  serverSeconds: 20,
  sourceSequence: 3,
};

describe('machine progress', () => {
  it('emits the observed progress unchanged as a JSONL event', async () => {
    let text = '';
    const streams = {
      stdout: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }),
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    };
    const output = createOutput({ format: 'jsonl', debug: false }, streams);
    try {
      await output.progress(progress);
      await output.finish();
      const events = text.trim().split('\n').map(line => JSON.parse(line));
      expect(events.map(event => event.type)).toEqual(['start', 'progress', 'result']);
      expect(events[1]).toMatchObject({ command: 'learning', type: 'progress', data: progress });
      expect(events[1].data.total).toBe(95);
      expect(events[1].data.serverFraction).toBe(0.2);
      expect(text).not.toContain('\u001b');
    } finally { output.close(); }
  });

  it('keeps JSON output silent until the final envelope', async () => {
    let text = '';
    const streams = {
      stdout: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }),
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    };
    const output = createOutput({ format: 'json', debug: false }, streams);
    try {
      await output.progress(progress);
      expect(text).toBe('');
      output.set({ jobs: [] });
      await output.finish();
      expect(JSON.parse(text)).toMatchObject({ data: { jobs: [] }, warnings: [] });
      expect(text).not.toContain('\u001b');
    } finally { output.close(); }
  });

  it('reports unknown totals and fractions without inventing progress', async () => {
    let text = '';
    const streams = {
      stdout: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }),
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    };
    const output = createOutput({ format: 'jsonl', debug: false }, streams);
    try {
      await output.progress({ ...progress, total: null, serverFraction: null, durationSeconds: null, serverSeconds: null });
      await output.finish();
      const event = JSON.parse(text.trim().split('\n')[1]!);
      expect(event.data).toMatchObject({ total: null, serverFraction: null, durationSeconds: null, serverSeconds: null });
    } finally { output.close(); }
  });

  it('preserves already collected data when cancellation finishes the result', async () => {
    let text = '';
    const streams = {
      stdout: new Writable({ write(chunk, _encoding, callback) { text += String(chunk); callback(); } }),
      stderr: new Writable({ write(_chunk, _encoding, callback) { callback(); } }),
    };
    const output = createOutput({ format: 'json', debug: false }, streams);
    try {
      await output.progress(progress);
      output.set({ jobId: progress.jobId, completed: progress.completed });
      output.markCanceled();
      await output.finish();
      expect(JSON.parse(text)).toMatchObject({
        ok: false,
        status: 'canceled',
        exitCode: 3,
        data: { jobId: progress.jobId, completed: progress.completed },
        error: { code: 'CANCELED' },
      });
    } finally { output.close(); }
  });
});
