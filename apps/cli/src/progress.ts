import cliProgress from 'cli-progress';
import type { MultiBar, SingleBar } from 'cli-progress';
import cliTruncate from 'cli-truncate';
import stringWidth from 'string-width';
import { styleText } from 'node:util';
import { Writable } from 'node:stream';

export type ProgressRow =
  | { text: string; tone?: 'bold' | 'dim' }
  | { label: string; fraction: number | null; detail: string; tone: 'green' | 'cyan' };

export function createProgressDisplay(output: Writable & { isTTY?: boolean; columns?: number; rows?: number }, render: () => ProgressRow[], color: boolean) {
  let rows: ProgressRow[] = [];
  let slots: SingleBar[] = [];
  let bars: MultiBar | null = null;
  let closed = false;
  let frame = '';
  const terminal = Object.defineProperties(new Writable({ write(chunk, _encoding, done) { frame += String(chunk); done(); } }), {
    isTTY: { get: () => output.isTTY },
    columns: { get: () => output.columns },
  });
  // Drop whole stale frames under backpressure so cursor movements cannot be split.
  const flush = (restore = false) => {
    const pending = frame;
    frame = '';
    if (pending && !output.destroyed && !output.writableEnded && (restore || !output.writableNeedDrain)) output.write(pending);
  };
  const readRows = () => render().slice(0, Math.max(1, (output.rows ?? 24) - 1));
  const paint = (text: string, tone: ProgressRow['tone']) => color && tone ? styleText(tone, text, { validateStream: false }) : text;
  const refresh = () => {
    rows = readRows();
    slots.forEach((slot, index) => {
      const row = rows[index];
      slot.update(row && 'fraction' in row ? row.fraction ?? 0 : 0);
    });
  };
  const draw = () => {
    if (closed || output.destroyed || output.writableNeedDrain) return;
    rows = readRows();
    if (slots.length !== rows.length) {
      bars?.stop();
      const next = new cliProgress.MultiBar({ stream: terminal, fps: 10, barsize: 36, hideCursor: true, linewrap: false, clearOnComplete: true, gracefulExit: false, forceRedraw: true }, cliProgress.Presets.shades_classic);
      bars = next;
      // MultiBar owns one terminal row per entry, including the course and playback labels.
      slots = rows.map((_, index) => next.create(1, 0, {}, {
        format(options, params) {
          const row = rows[index];
          if (!row) return '';
          const width = Math.max(1, (output.columns ?? 80) - 1);
          if ('text' in row) return cliTruncate(paint(` ${row.text}`, row.tone), width);
          const detailsWidth = Math.max(...rows.map(line => 'detail' in line ? stringWidth(line.detail) : 0));
          const barsize = Math.max(1, Math.min(36, width - stringWidth(row.label) - detailsWidth - 5));
          const waiting = cliTruncate('等待进度', barsize);
          const bar = row.fraction === null ? waiting + ' '.repeat(barsize - stringWidth(waiting)) : cliProgress.Format.BarFormat(params.progress, { ...options, barsize });
          const detail = ' '.repeat(detailsWidth - stringWidth(row.detail)) + row.detail;
          return cliTruncate(` ${row.label}  ${paint(bar, row.tone)}  ${detail}`, width);
        },
      }));
      next.on('update-pre', refresh);
      next.on('update-post', () => flush());
      next.on('stop', () => flush(true));
    }
    bars?.update();
  };
  const clear = () => {
    if (closed) return;
    closed = true;
    output.off('resize', draw);
    output.off('drain', draw);
    output.off('close', clear);
    output.off('finish', clear);
    process.off('exit', clear);
    bars?.stop();
    terminal.destroy();
  };
  output.on('resize', draw);
  output.on('drain', draw);
  output.once('close', clear);
  output.once('finish', clear);
  process.once('exit', clear);
  draw();
  return { draw, clear };
}
