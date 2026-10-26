import { confirmAction, requireConfirmation } from '../prompts.js';
import { readPreferences, setJobOutputRoot } from '../preferences.js';
import { resolve } from 'node:path';
import { CliError, getOutput } from '../output.js';
import type { Command } from 'commander';
import { createLearningClient, exportDraftYaml, LearningError, ResourceRefSchema } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime, unwrapResult, executeAction } from '../context.js';
import { resourceCacheKey } from './catalog.js';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { trackWorkflowEvent } from '../telemetry.js';

export function registerExamCommands(program: Command): void {
  const exam = program.command('exam').description('试卷分步操作');
  const draftCommand = exam.command('draft <resource>')
    .description('为可读取的试卷生成 YAML 草稿')
    .requiredOption('-o, --output <file>', '新输出文件路径');
  draftCommand.action(async (key: string) => {
    const output = draftCommand.opts<{ output: string }>().output;
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
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
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LearningError({ code: 'CONFLICT', message: 'output file exists; choose a new path', retryAfterMs: null, operationId: null }, { cause: error });
          throw error;
        }
        trackWorkflowEvent(getOutput(program), { event: 'exam_draft_created', properties: { question_count: draft.entries.length } });
        printResult(program, { path: output, draftId: draft.id, questions: draft.entries.length }, `${output}: ${draft.entries.length} questions`);
      } finally { await client.close(); }
    });
  });
  const save = exam.command('save <draft>')
    .description('保存已验证题型的答案，不交卷')
    .option('--yes', '确认保存答案')
    .option('--dry-run', '只预览，不保存');
  save.action(async (path: string) => {
    const options = save.opts<{ yes?: boolean; dryRun?: boolean }>();
    requireConfirmation(program, options.yes, options.dryRun);
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam draft must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const draft = unwrapResult(program, await client.assessments.importDraft(await readFile(path, 'utf8'), 'learning'));
        if (draft.ref.kind !== 'exam') throw new LearningError({ code: 'INVALID_INPUT', message: 'draft is not an exam', retryAfterMs: null, operationId: null });
        const preview = await client.actions.prepare({ kind: 'exam.save', draft });
        if (options.dryRun) { printResult(program, preview, `exam ${draft.ref.assessmentId} save previewed; no final submission`); return; }
        await confirmAction(program, `账号：${profile.name}，保存试卷 ${draft.ref.assessmentId} 的答案，不交卷。`, options.yes);
        const receipt = await executeAction(getOutput(program), client, preview.id);
        trackWorkflowEvent(getOutput(program), { event: 'exam_answers_saved', properties: { result_type: receipt.type } });
        printResult(program, receipt, `exam answers saved: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
      } finally { await client.close(); }
    });
  });
  const start = exam.command('start <resource>')
    .description('确认后开卷，可能开始计时')
    .option('--yes', '确认可能开始计时')
    .option('--dry-run', '只预览，不开卷');
  start.action(async (key: string) => {
    const options = start.opts<{ yes?: boolean; dryRun?: boolean }>();
    requireConfirmation(program, options.yes, options.dryRun);
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
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
        await confirmAction(program, `账号：${profile.name}，打开试卷 ${refs[0]!.assessmentId}，可能开始计时。`, options.yes);
        const receipt = await executeAction(getOutput(program), client, preview.id);
        trackWorkflowEvent(getOutput(program), { event: 'exam_started', properties: { result_type: receipt.type } });
        printResult(program, receipt, `exam start: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
      } finally { await client.close(); }
    });
  });
  exam.command('export <resource>')
    .description('导出可读取的试卷或结果')
    .option('--output-dir <dir>', '导出目标根目录')
    .action(async (key: string, options: { outputDir?: string }) => {
      await withCliRuntime(program, true, async (runtime, dataDir) => {
        const profile = await selectProfile(program, runtime);
          const stored = await runtime.state.get(resourceCacheKey(key));
        if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown resource key; run outline first', retryAfterMs: null, operationId: null });
        const resource = ResourceRefSchema.parse(stored.value);
        if (resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'resource belongs to another profile', retryAfterMs: null, operationId: null });
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const refs = (await client.assessments.resolve(resource)).filter((ref) => ref.kind === 'exam');
          if (refs.length === 0) throw new LearningError({ code: 'UNSUPPORTED', message: 'resource has no exam to export', retryAfterMs: null, operationId: null });
          const created = await client.jobs.createExport({ type: 'assessments', refs, format: 'json' });
          await setJobOutputRoot(runtime.state, created.id, resolve(options.outputDir ?? (await readPreferences(runtime.state)).downloadDir ?? resolve(dataDir, 'exports')));
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
    .description('最终交卷，非交互需要 --yes --final')
    .option('--yes', '确认当前操作')
    .option('--final', '明确执行最终交卷')
    .option('--dry-run', '查看交卷预览及阻塞原因，不发送');
  submit.action(async (path: string) => {
      const options = submit.opts<{ yes?: boolean; final?: boolean; dryRun?: boolean }>();
      if ((!options.yes || !options.final) && !options.dryRun && !getOutput(program).mode.interactive) {
        throw new CliError('INVALID_INPUT', 'exam submit requires --yes --final', 2);
      }
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
          const info = await lstat(path);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new LearningError({ code: 'INVALID_INPUT', message: 'exam draft must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const draft = unwrapResult(program, await client.assessments.importDraft(await readFile(path, 'utf8'), 'learning'));
          if (draft.ref.kind !== 'exam') throw new LearningError({ code: 'INVALID_INPUT', message: 'draft is not an exam', retryAfterMs: null, operationId: null });
          const preview = await client.actions.prepare({ kind: 'exam.finalize', draft });
          if (preview.blockers.length > 0) {
            process.exitCode = 3;
            await getOutput(program).warning('BLOCKED', preview.blockers.join('; '));
            printResult(program, preview, `final submission blocked: ${preview.blockers.join('; ')}`);
            return;
          }
          if (options.dryRun) { printResult(program, preview, 'final submission previewed'); return; }
          await confirmAction(program, `账号：${profile.name}，最终提交试卷 ${draft.ref.assessmentId}，提交后不能视为普通保存。`, options.yes);
          if (!options.final) await confirmAction(program, '再次确认：最终交卷，结束本次考试？此确认等价于 --final。', false);
          const receipt = await executeAction(getOutput(program), client, preview.id);
          trackWorkflowEvent(getOutput(program), { event: 'exam_submitted', properties: { result_type: receipt.type } });
          printResult(program, receipt, `final submission: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
        } finally { await client.close(); }
      });
    });
}
