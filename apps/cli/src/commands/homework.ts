import { confirmAction, requireConfirmation } from '../prompts.js';
import { getOutput } from '../output.js';
import type { Command } from 'commander';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createLearningClient, exportDraftYaml, LearningError, ResourceRefSchema } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime, unwrapResult, executeAction } from '../context.js';
import { resourceCacheKey } from './catalog.js';

export function registerHomeworkCommands(program: Command): void {
  const homework = program.command('homework').description('生成或提交作业草稿');
  homework.command('draft <resource>')
    .description('为作业或内嵌题生成 YAML 草稿')
    .requiredOption('-o, --output <file>', '新 YAML 草稿路径')
    .action(async (key: string, options: { output: string }) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
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
    .description('预览并确认提交选中的作业答案')
    .option('--dry-run', '只预览，不发送答案')
    .option('--yes', '确认提交全部选中答案')
    .action(async (file: string, options: { dryRun?: boolean; yes?: boolean }) => {
      requireConfirmation(program, options.yes, options.dryRun);
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
          const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new LearningError({ code: 'INVALID_INPUT', message: 'draft must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
        const text = await readFile(file, 'utf8');
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const imported = await client.assessments.importDraft(text, 'learning');
          const draft = unwrapResult(program, imported);
          if (draft.ref.kind !== 'homework' && draft.ref.kind !== 'embedded') throw new LearningError({ code: 'INVALID_INPUT', message: 'draft is not homework or embedded exercise', retryAfterMs: null, operationId: null });
          const answered = draft.entries.filter((entry) => entry.answer.kind !== 'unset');
          if (answered.length === 0) throw new LearningError({ code: 'INVALID_INPUT', message: 'draft contains no answers to submit', retryAfterMs: null, operationId: null });
          const previews = [];
          const receipts: Awaited<ReturnType<typeof client.actions.execute>>[] = [];
          for (const entry of answered) previews.push(await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: [entry.questionId] }));
          const summary = `账号：${profile.name}\n将提交 ${answered.length} 道题：\n${answered.map(entry => `${entry.questionId}: ${JSON.stringify(entry.answer)}`).join('\n')}`;
          if (options.dryRun) { getOutput(program).set({ previews, receipts }, summary, 'preview'); return; }
          getOutput(program).set({ previews, receipts }, '', 'preview');
          await confirmAction(program, summary, options.yes);
          for (const preview of previews) receipts.push(await executeAction(getOutput(program), client, preview.id));
          printResult(program, { previews, receipts }, `已处理 ${receipts.length} 道题，请以服务端结果为准。`);
        } finally { await client.close(); }
      });
    });
}
