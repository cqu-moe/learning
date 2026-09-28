import { format } from 'node:util';
import { setImmediate } from 'node:timers/promises';

// Install before loading application modules: SQLite can warn during import.
export function captureWarnings() {
  const pending: Array<{ code: string; message: string }> = [];
  let sink: ((code: string, message: string) => void) | undefined;
  const record = (code: string, message: string) => { if (sink) sink(code, message); else pending.push({ code, message }); };
  const onWarning = (warning: Error & { code?: string }) => record(warning.code ?? warning.name, warning.message);
  const originalWarn = console.warn;
  const warn = (...args: unknown[]) => record('CONSOLE_WARNING', format(...args.map(value => value instanceof Error ? value.message : value)));
  const defaultPrinter = process.listeners('warning').find(listener => listener.name === 'onWarning');
  if (defaultPrinter) process.off('warning', defaultPrinter);
  process.on('warning', onWarning);
  console.warn = warn;
  return {
    attach(receiver: (code: string, message: string) => void) { sink = receiver; for (const item of pending.splice(0)) receiver(item.code, item.message); },
    async drain() { await setImmediate(); },
    close() {
      process.off('warning', onWarning);
      if (defaultPrinter) process.on('warning', defaultPrinter);
      if (console.warn === warn) console.warn = originalWarn;
    },
  };
}
