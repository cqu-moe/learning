import type { Command } from 'commander';
import { createLearningClient, exportDraftYaml, LearningError, ResourceRefSchema } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { resourceCacheKey } from './catalog.js';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';
import { lstat, readFile, writeFile } from 'node:fs/promises';

export function registerExamCommands(program: Command): void {
  const exam = program.command('exam').description('exam draft operations');
  const draftCommand = exam.command('draft <resource>')
    .description('create an editable YAML draft from a permitted exam paper')
    .requiredOption('-o, --output <file>', 'new output file');
  draftCommand.action(async (key: string) => {
    const output = draftCommand.opts<{ output: string }>().output;
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      const stored = await runtime.state.get(resourceCacheKey(key));
      if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown exam resource; run outline first', retryAfterMs: null, operationId: null });
      const resource = ResourceRefSchema.parse(stored.value);
      if (resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'exam resource belongs to another profile', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const refs = (await client.assessments.resolve(resource)).filter((ref) => ref.kind === 'exam');
        if (refs.length !== 1) throw new LearningError({ code: 'UNSUPPORTED', message: 'expected one exam for this resource', retryAfterMs: null, operationId: null });
        const draft = await client.assessments.draft(refs[0]!);
        try { await writeFile(output, exportDraftYaml(draft), { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LearningError({ code: 'CONFLICT', message: 'output file exists; choose a new path', retryAfterMs: null, operationId: null });
          throw error;
        }
        printResult(program, { path: output, draftId: draft.id, questions: draft.entries.length }, `${output}: ${draft.entries.length} questions`);
      } finally { await client.close(); }
    });
  });
  const save = exam.command('save <draft>')
    .description('cache verified choice/judgement answers without final submission')
    .option('--yes', 'confirm saving answers')
    .option('--dry-run', 'preview without saving');
  save.action(async (path: string) => {
    const options = save.opts<{ yes?: boolean; dryRun?: boolean }>();
    if (!options.yes && !options.dryRun) { process.stderr.write('learning: exam save requires --yes or --dry-run\n'); process.exitCode = 2; return; }
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam draft must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const draft = (await client.assessments.importDraft(await readFile(path, 'utf8'), 'learning')).value;
        if (draft.ref.kind !== 'exam') throw new LearningError({ code: 'INVALID_INPUT', message: 'draft is not an exam', retryAfterMs: null, operationId: null });
        const preview = await client.actions.prepare({ kind: 'exam.save', draft });
        if (options.dryRun) { printResult(program, preview, `exam ${draft.ref.assessmentId} save previewed; no final submission`); return; }
        const receipt = await client.actions.execute(preview.id);
        printResult(program, receipt, `exam answers saved: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
      } finally { await client.close(); }
    });
  });
  const start = exam.command('start <resource>')
    .description('explicitly start an unstarted exam; this may begin a timer')
    .option('--yes', 'confirm beginning a possible countdown')
    .option('--dry-run', 'show the preview without starting');
  start.action(async (key: string) => {
    const options = start.opts<{ yes?: boolean; dryRun?: boolean }>();
    if (!options.yes && !options.dryRun) { process.stderr.write('learning: exam start requires --yes (may begin a timer)\n'); process.exitCode = 2; return; }
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
      const stored = await runtime.state.get(resourceCacheKey(key));
      if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown exam resource; run outline first', retryAfterMs: null, operationId: null });
      const resource = ResourceRefSchema.parse(stored.value);
      if (resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'exam resource belongs to another profile', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const refs = (await client.assessments.resolve(resource)).filter((ref) => ref.kind === 'exam');
        if (refs.length !== 1) throw new LearningError({ code: 'UNSUPPORTED', message: 'expected one exam for this resource', retryAfterMs: null, operationId: null });
        const preview = await client.actions.prepare({ kind: 'exam.start', ref: refs[0]! });
        if (options.dryRun) { printResult(program, preview, `exam ${refs[0]!.assessmentId} start previewed; timer may begin`); return; }
        const receipt = await client.actions.execute(preview.id);
        printResult(program, receipt, `exam start: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
      } finally { await client.close(); }
    });
  });
  exam.command('export <resource>')
    .description('export a permitted exam or result to the local data directory')
    .action(async (key: string) => {
      await withCliRuntime(program, true, async (runtime, dataDir) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const stored = await runtime.state.get(resourceCacheKey(key));
        if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown resource key; run outline first', retryAfterMs: null, operationId: null });
        const resource = ResourceRefSchema.parse(stored.value);
        if (resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'resource belongs to another profile', retryAfterMs: null, operationId: null });
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const refs = (await client.assessments.resolve(resource)).filter((ref) => ref.kind === 'exam');
          if (refs.length === 0) throw new LearningError({ code: 'UNSUPPORTED', message: 'resource has no exam to export', retryAfterMs: null, operationId: null });
          const created = await client.jobs.createExport({ type: 'assessments', refs, format: 'json' });
          const finished = await runJobForeground(client, runtime, created.id);
          const files = await publishJobArtifacts(runtime, finished, dataDir);
          if (finished.status === 'partial') process.exitCode = 4;
          else if (finished.status === 'uncertain') process.exitCode = 5;
          else if (finished.status !== 'succeeded') process.exitCode = 3;
          printResult(program, { job: finished, files }, `${finished.status}: ${files.join(', ')}`);
        } finally { await client.close(); }
      });
    });
  const submit = exam.command('submit <draft>')
    .description('finalize an exam draft (requires --yes --final)')
    .option('--yes', 'explicit confirmation')
    .option('--final', 'final submission (not just a save)')
    .option('--dry-run', 'show the final-submission blockers without sending');
  submit.action(async (path: string) => {
      const options = submit.opts<{ yes?: boolean; final?: boolean; dryRun?: boolean }>();
      if ((!options.yes || !options.final) && !options.dryRun) {
        process.stderr.write('learning: exam submit requires --yes --final\n');
        process.exitCode = 2;
        return;
      }
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        if (profile === null) return;
        const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam draft must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const draft = (await client.assessments.importDraft(await readFile(path, 'utf8'), 'learning')).value;
          if (draft.ref.kind !== 'exam') throw new LearningError({ code: 'INVALID_INPUT', message: 'draft is not an exam', retryAfterMs: null, operationId: null });
          const preview = await client.actions.prepare({ kind: 'exam.finalize', draft });
          if (preview.blockers.length > 0) {
            process.exitCode = 3;
            process.stderr.write(`learning: ${preview.blockers.join('; ')}\n`);
            printResult(program, preview, `final submission blocked: ${preview.blockers.join('; ')}`);
            return;
          }
          if (options.dryRun) { printResult(program, preview, 'final submission previewed'); return; }
          const receipt = await client.actions.execute(preview.id);
          printResult(program, receipt, `final submission: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
        } finally { await client.close(); }
      });
    });
}
