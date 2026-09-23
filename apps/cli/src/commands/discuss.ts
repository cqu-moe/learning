import type { Command } from 'commander';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createLearningClient, DiscussionDraftSchema, LearningError, ResourceRefSchema } from '@learning/sdk';
import { printResult, selectProfile, withCliRuntime } from '../context.js';
import { resourceCacheKey } from './catalog.js';

export function registerDiscussCommands(program: Command): void {
  const discuss = program.command('discuss').description('prepare or post discussion replies');
  const draft = discuss.command('draft <resource>')
    .description('create a new editable JSON discussion draft')
    .requiredOption('-o, --output <file>', 'new output file')
    .option('--ai', 'request a model suggestion when configured');
  draft.action(async (key: string) => {
    const options = draft.opts<{ output: string; ai?: boolean }>();
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
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
    .description('preview and explicitly post one discussion reply')
    .option('--dry-run', 'preview only; do not post')
    .option('--yes', 'confirm posting');
  post.action(async (path: string) => {
    const options = post.opts<{ dryRun?: boolean; yes?: boolean }>();
    await withCliRuntime(program, true, async (runtime) => {
      const profile = await selectProfile(program, runtime);
      if (profile === null) return;
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
        if (options.dryRun || !options.yes) {
          if (!options.dryRun) { process.stderr.write('learning: preview only; rerun with --yes to post\n'); process.exitCode = 3; }
          printResult(program, preview, `discussion post previewed for topic ${discussion.data.ref.topicId}`);
          return;
        }
        const receipt = await client.actions.execute(preview.id);
        printResult(program, receipt, `discussion post: ${receipt.type === 'receipt' ? receipt.receipt.state : 'job'}`);
      } finally { await client.close(); }
    });
  });
}
