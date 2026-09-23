import type { Command } from 'commander';
import { createLearningClient, LearningError } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';

export function registerSlideCommand(program: Command): void {
  const slide = program.command('slide <lesson-url>').description('export historical lesson slides locally')
    .option('--format <format>', 'pdf or images', 'pdf');
  slide.action(async (url: string) => {
    const format = slide.opts<{ format: string }>().format;
    if (format !== 'pdf' && format !== 'images') throw new LearningError({ code: 'INVALID_INPUT', message: 'slide format must be pdf or images', retryAfterMs: null, operationId: null });
    await withCliRuntime(program, true, async (runtime, dataDir) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const lesson = await client.resources.resolveLesson(url);
        const created = await client.jobs.createExport({ type: 'slides', lessons: [lesson], format, liveJobId: null });
        const finished = await runJobForeground(client, runtime, created.id);
        const files = await publishJobArtifacts(runtime, finished, dataDir);
        if (finished.status === 'partial') process.exitCode = 4;
        else if (finished.status === 'uncertain') process.exitCode = 5;
        else if (finished.status !== 'succeeded') process.exitCode = 3;
        printResult(program, { job: finished, files }, `${finished.status}: ${files.join(', ')}`);
      } finally { await client.close(); }
    });
  });
}
