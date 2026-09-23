import type { Command } from 'commander';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { printResult } from '../context.js';

export function registerDoctorCommand(program: Command): void {
  program.command('doctor').description('report local runtime readiness without installing anything').action(() => {
    const home = resolve(program.opts<{ home?: string }>().home ?? process.env.LEARNING_HOME ?? resolve(process.env.HOME ?? '.', '.learning'));
    const browserPath = process.env.LEARNING_BROWSER_PATH;
    const fontPath = process.env.LEARNING_REFERENCE_FONT;
    const status = {
      node: process.version,
      home,
      initialized: existsSync(resolve(home, 'master.key')) && existsSync(resolve(home, 'state.db')),
      writerLock: existsSync(resolve(home, 'learning.lock')),
      pdf: 'available',
      font: fontPath && existsSync(fontPath) ? 'unavailable (reference corpus supplied; Canvas decoder is not implemented)' : 'unavailable (reference corpus and Canvas decoder are not configured)',
      browser: browserPath && existsSync(browserPath) ? 'configured but legacy slide browser handler is unavailable' : 'not configured (legacy slide handler unavailable)',
      model: 'not configured (optional model adapter unavailable)',
    };
    printResult(program, status, [
      `node: ${status.node}`,
      `home: ${status.home}`,
      `initialized: ${status.initialized}`,
      `writer lock: ${status.writerLock}`,
      `pdf: ${status.pdf}`,
      `font: ${status.font}`,
      `browser: ${status.browser}`,
      `model: ${status.model}`,
    ].join('\n'));
  });
}
