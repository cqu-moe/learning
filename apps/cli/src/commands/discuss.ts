import { confirmAction, requireConfirmation, askDefaults } from '../prompts.js';
import { getOutput } from '../output.js';
import { isWizard } from '../wizard.js';
import type { Command } from 'commander';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createLearningClient, DiscussionDraftSchema, LearningError, ResourceRefSchema } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime, executeAction } from '../context.js';
import { resourceCacheKey } from './catalog.js';

export function registerDiscussCommands(program: Command): void {
  const discuss = program.command('discuss').description('生成讨论草稿或确认发帖');
  const draft = discuss.command('draft <resource>')
    .description('生成可编辑的 JSON 讨论草稿')
    .requiredOption('-o, --output <file>', '新输出文件路径')
    .option('--ai', '明确请求已配置的模型生成建议，可能产生费用');
  draft.action(async (key: string) => {
    await askDefaults(draft, [{ name: 'ai', message: '使用已配置的模型生成建议？可能产生费用。', confirm: true }], isWizard(program));
    const options = draft.opts<{ output: string; ai?: boolean }>();
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const stored = await runtime.state.get(resourceCacheKey(key));
      if (stored === null) throw new LearningError({ code: 'INVALID_INPUT', message: 'unknown discussion resource; run outline first', retryAfterMs: null, operationId: null });
      const resource = ResourceRefSchema.parse(stored.value);
      if (resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'discussion resource belongs to another profile', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const ref = await client.discussions.resolve(resource);
        const result = options.ai ? await client.discussions.propose(ref) : await client.discussions.draft(ref);
        try { await writeFile(options.output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LearningError({ code: 'CONFLICT', message: 'output file exists; choose a new path', retryAfterMs: null, operationId: null });
          throw error;
        }
        printResult(program, { path: options.output, draft: result }, `draft saved to ${options.output}`);
      } finally { await client.close(); }
    });
  });

  const post = discuss.command('post <file>')
    .description('预览并确认发布一条讨论回复')
    .option('--dry-run', '只预览，不发帖')
    .option('--yes', '确认发布讨论');
  post.action(async (path: string) => {
    const options = post.opts<{ dryRun?: boolean; yes?: boolean }>();
    requireConfirmation(program, options.yes, options.dryRun);
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new LearningError({ code: 'INVALID_INPUT', message: 'discussion draft must be a regular file under 4 MiB', retryAfterMs: null, operationId: null });
      let parsed: unknown;
      try { parsed = JSON.parse(await readFile(path, 'utf8')); }
      catch { throw new LearningError({ code: 'INVALID_INPUT', message: 'discussion draft is not JSON', retryAfterMs: null, operationId: null }); }
      const discussion = DiscussionDraftSchema.safeParse(parsed);
      if (!discussion.success) throw new LearningError({ code: 'INVALID_INPUT', message: 'discussion draft schema is invalid', retryAfterMs: null, operationId: null });
      if (discussion.data.ref.resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'discussion draft belongs to another profile', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const preview = await client.actions.prepare({ kind: 'discussion.post', draft: discussion.data });
        const summary = `账号：${profile.name}\n向主题 ${discussion.data.ref.topicId} 发布以下内容：\n${discussion.data.text}`;
        if (options.dryRun) { getOutput(program).set(preview, summary, 'preview'); return; }
        getOutput(program).set(preview, '', 'preview');
        await confirmAction(program, summary, options.yes);
        const receipt = await executeAction(getOutput(program), client, preview.id);
        printResult(program, receipt, `discussion post: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
      } finally { await client.close(); }
    });
  });
}
