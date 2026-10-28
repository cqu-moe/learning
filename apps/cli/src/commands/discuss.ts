import { requireConfirmation } from '../input.js';
import { getOutput } from '../output.js';
import type { Command } from 'commander';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createLearningClient, DiscussionDraftSchema, LearningError, ResourceRefSchema } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime, executeAction } from '../context.js';
import { resourceCacheKey } from './catalog.js';
import { trackWorkflowEvent } from '../telemetry.js';

export function registerDiscussCommands(program: Command): void {
  const discuss = program.command('discuss').description('生成讨论草稿或确认发帖');
  const draft = discuss.command('draft <resource>')
    .description('生成可编辑的 JSON 讨论草稿')
    .requiredOption('-o, --output <file>', '新输出文件路径')
    .option('--ai', '明确请求已配置的模型生成建议，可能产生费用');
  draft.action(async (key: string) => {
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
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LearningError({ code: 'CONFLICT', message: 'output file exists; choose a new path', retryAfterMs: null, operationId: null }, { cause: error });
          throw error;
        }
        trackWorkflowEvent(getOutput(program), { event: 'discussion_draft_created', properties: { used_ai_suggestion: options.ai === true } });
        printResult(program, { path: options.output, draft: result });
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
      catch (error) { throw new LearningError({ code: 'INVALID_INPUT', message: 'discussion draft is not JSON', retryAfterMs: null, operationId: null }, { cause: error }); }
      const discussion = DiscussionDraftSchema.safeParse(parsed);
      if (!discussion.success) throw new LearningError({ code: 'INVALID_INPUT', message: 'discussion draft schema is invalid', retryAfterMs: null, operationId: null }, { cause: discussion.error });
      if (discussion.data.ref.resource.course.scope.profileId !== profile.scope.profileId) throw new LearningError({ code: 'FORBIDDEN', message: 'discussion draft belongs to another profile', retryAfterMs: null, operationId: null });
      const client = createLearningClient({ scope: profile.scope, runtime });
      try {
        const preview = await client.actions.prepare({ kind: 'discussion.post', draft: discussion.data });
        const summary = { profile: profile.name, topicId: discussion.data.ref.topicId, text: discussion.data.text };
        getOutput(program).set({ ...preview, summary }, 'preview');
        if (options.dryRun) return;
        const receipt = await executeAction(getOutput(program), client, preview.id);
        trackWorkflowEvent(getOutput(program), { event: 'discussion_posted', properties: { result_type: receipt.type } });
        printResult(program, receipt);
      } finally { await client.close(); }
    });
  });
}
