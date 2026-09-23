import type { Command } from 'commander';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createLearningClient, exportDraftYaml, LearningError, ResourceRefSchema } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { resourceCacheKey } from './catalog.js';

export function registerHomeworkCommands(program: Command): void {
  const homework = program.command('homework').description('read or apply homework drafts');
  homework.command('draft <resource>')
    .description('create an editable YAML draft for a cached homework resource')
    .requiredOption('-o, --output <file>', 'new local YAML file')
    .action(async (key: string, options: { output: string }) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const stored = await runtime.state.get(resourceCacheKey(key));
        if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown resource key; run outline first', retryAfterMs: null, operationId: null });
        const resource = ResourceRefSchema.parse(stored.value);
        if (resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'resource belongs to another profile', retryAfterMs: null, operationId: null });
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const refs = (await client.assessments.resolve(resource)).filter((ref) => ref.kind === 'homework' || ref.kind === 'embedded');
          if (refs.length !== 1) throw new LearningError({ code: 'UNSUPPORTED', message: 'expected one homework or embedded assessment for this resource', retryAfterMs: null, operationId: null });
          const draft = await client.assessments.draft(refs[0]!);
          try { await writeFile(options.output, exportDraftYaml(draft), { flag: 'wx', mode: 0o600 }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LearningError({ code: 'CONFLICT', message: 'output file exists; choose a new path', retryAfterMs: null, operationId: null });
            throw error;
          }
          printResult(program, { path: options.output, draftId: draft.id, questions: draft.entries.length }, `${options.output}: ${draft.entries.length} questions`);
        } finally { await client.close(); }
      });
    });

  homework.command('apply <file>')
    .description('preview and explicitly submit selected homework answers one at a time')
    .option('--dry-run', 'preview only; never send an answer')
    .option('--yes', 'confirm sending every selected answer')
    .action(async (file: string, options: { dryRun?: boolean; yes?: boolean }) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new LearningError({ code: 'INVALID_INPUT', message: 'draft must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
        const text = await readFile(file, 'utf8');
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const imported = await client.assessments.importDraft(text, 'learning');
          const draft = imported.value;
          if (draft.ref.kind !== 'homework' && draft.ref.kind !== 'embedded') throw new LearningError({ code: 'INVALID_INPUT', message: 'draft is not homework or embedded exercise', retryAfterMs: null, operationId: null });
          const answered = draft.entries.filter((entry) => entry.answer.kind !== 'unset');
          if (answered.length === 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'draft contains no answers to submit', retryAfterMs: null, operationId: null });
          const previews = [];
          const receipts = [];
          for (const entry of answered) {
            const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: [entry.questionId] });
            previews.push(preview);
            if (!options.dryRun && options.yes) receipts.push(await client.actions.execute(preview.id));
          }
          if (!options.dryRun && !options.yes) {
            process.exitCode = 3;
            process.stderr.write('learning: preview only; rerun with --yes to submit\n');
          }
          printResult(program, { previews, receipts }, options.dryRun || !options.yes
            ? `${previews.length} homework answers previewed`
            : `${receipts.length} homework answers acknowledged`);
        } finally { await client.close(); }
      });
    });
}
