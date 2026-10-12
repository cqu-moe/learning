import type { Writable } from 'node:stream';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
function widthOf(text: string): number {
  return [...graphemes.segment(text)].reduce((width, { segment }) => width + (/\p{Extended_Pictographic}|[\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{20000}-\u{3fffd}]/u.test(segment) ? 2 : 1), 0);
}
function fit(text: string, columns: number): string {
  if (widthOf(text) <= columns) return text;
  let fitted = '';
  let width = 0;
  for (const { segment } of graphemes.segment(text)) {
    width += widthOf(segment);
    if (width > columns - 1) break;
    fitted += segment;
  }
  return fitted + '…';
}

export function createProgressDisplay(output: Writable & { columns?: number; rows?: number }, render: (columns: number) => string[]) {
  let previous: string[] = [];
  const columns = () => Math.max(2, output.columns ?? 80);
  const erase = () => {
    if (!previous.length || output.destroyed) return;
    const rows = previous.reduce((count, line) => count + Math.max(1, Math.ceil(widthOf(line) / columns())), 0);
    output.write(`\r${rows > 1 ? `\u001b[${rows - 1}A` : ''}\u001b[0J`);
    previous = [];
  };
  const draw = () => {
    if (output.destroyed || output.writableNeedDrain) return;
    erase();
    previous = render(columns() - 1).slice(0, Math.max(1, (output.rows ?? 24) - 1)).map(line => fit(line, columns() - 1));
    output.write(previous.join('\n'));
  };
  output.write('\u001b[?25l');
  draw();
  const timer = setInterval(draw, 100);
  timer.unref();
  const clear = () => {
    clearInterval(timer);
    output.off('resize', draw);
    process.off('exit', clear);
    erase();
    if (!output.destroyed) output.write('\u001b[?25h');
  };
  output.on('resize', draw);
  process.once('exit', clear);
  return { draw, clear };
}
