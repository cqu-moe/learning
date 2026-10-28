import { resolve } from 'node:path';
import { z } from 'zod';
import { readPreferences, setJobOutputRoot } from '../preferences.js';
import { Option, type Command } from 'commander';
import { createLearningClient } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';

export function registerSlideCommand(program: Command): void {
  const slide = program.command('slide <lesson-url>').description('导出已有课件')
    .option('--output-dir <dir>', '导出目标根目录')
    .addOption(new Option('--format <format>', '课件格式：pdf 或 images').default('pdf').choices(['pdf', 'images']));
  slide.action(async (value: string) => {
    const { url, format } = z.object({ url: z.url(), format: z.enum(['pdf', 'images']) }).parse({ url: value, format: slide.opts<{ format: string }>().format });
    await withCliRuntime(program, true, async (runtime, dataDir) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const lesson = await client.resources.resolveLesson(url);
        const created = await client.jobs.createExport({ type: 'slides', lessons: [lesson], format, liveJobId: null });
        const outputRoot = resolve(slide.opts<{ outputDir?: string }>().outputDir ?? (await readPreferences(runtime.state)).downloadDir ?? resolve(dataDir, 'exports'));
        if (slide.opts().outputDir === undefined) slide.setOptionValueWithSource('outputDir', outputRoot, 'inferred');
        await setJobOutputRoot(runtime.state, created.id, outputRoot);
        const finished = await runJobForeground(client, runtime, created.id);
        const files = await publishJobArtifacts(runtime, finished, dataDir);
        if (finished.status === 'partial') process.exitCode = 4;
        else if (finished.status === 'uncertain') process.exitCode = 5;
        else if (finished.status !== 'succeeded') process.exitCode = 3;
        printResult(program, { job: finished, files });
      } finally { await client.close(); }
    });
  });
}
