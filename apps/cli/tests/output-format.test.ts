import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { createOutput, formatClock } from '../src/output.js';

describe('study progress line', () => {
  it('shows title, watched/total clock and server fraction', async () => {
    const written: string[] = [];
    const sink = () => new Writable({ write(chunk, _encoding, callback) { written.push(String(chunk)); callback(); } });
    const output = createOutput({ format: 'plain', interactive: false, quiet: false, color: false, debug: false }, { stdout: sink(), stderr: sink() });
    await output.progress({ jobId: 'job-1', resourceKey: 'res-key', status: 'running', completed: 2, total: 95, serverFraction: 0.103, estimatedSeconds: null, title: '1.1 心理与健康', durationSeconds: 630, serverSeconds: 65, sourceSequence: 3 });
    expect(written.join('')).toContain('1.1 心理与健康 · 1:05/10:30 · 服务端 10.3%');
    expect(formatClock(3725)).toBe('1:02:05');
    output.close();
  });
});
