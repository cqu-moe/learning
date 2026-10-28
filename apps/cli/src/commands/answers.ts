import type { Command } from 'commander';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createLearningClient, exportDraftYaml, LearningError } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime, unwrapResult } from '../context.js';

async function readSmallFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'draft and sources must be regular files under 4 MiB', retryAfterMs: null, operationId: null });
  }
  return readFile(path, 'utf8');
}

export function registerAnswersCommands(program: Command): void {
  const answers = program.command('answers').description('将草稿与反馈来源匹配');
  const match = answers.command('match <draft>')
    .description('查看匹配结果，可将精确答案写入新草稿')
    .requiredOption('--source <files...>', '一个或多个本地反馈 JSON/YAML 文件')
    .option('-o, --output <file>', '新草稿路径，不覆盖已有文件');
  match.action(async (path: string) => {
    const options = match.opts<{ source: string[]; output?: string }>();
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const draft = unwrapResult(program, await client.assessments.importDraft(await readSmallFile(path), 'learning'));
        const sources = [];
        for (const source of options.source) sources.push(await client.assessments.importFeedback(await readSmallFile(source), draft.ref));
        const matches = await client.assessments.match(draft, sources);
        let applied = 0;
        if (options.output !== undefined) {
          const byId = new Map(matches.map((item) => [item.questionId, item]));
          const next = { ...draft, id: `${draft.id}-matched`, entries: draft.entries.map((entry) => {
            const match = byId.get(entry.questionId);
            if (entry.answer.kind !== 'unset' || match?.state !== 'exact' || match.answer === null || match.sourceId === null) return entry;
            applied += 1;
            return { ...entry, answer: match.answer, evidence: { origin: 'platform-feedback' as const, answer: match.answer, sourceId: match.sourceId, alternatives: [] } };
          }) };
          try { await writeFile(options.output, exportDraftYaml(next), { flag: 'wx', mode: 0o600 }); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LearningError({ code: 'CONFLICT', message: 'output file exists; choose a new path', retryAfterMs: null, operationId: null }, { cause: error });
            throw error;
          }
        }
        printResult(program, { matches, applied, output: options.output ?? null });
      } finally { await client.close(); }
    });
  });
}
