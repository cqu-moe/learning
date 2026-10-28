import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Command } from 'commander';
import {
  CourseSchema,
  createLearningClient,
  draftAssessment,
  exportDraftYaml,
  exportHomeworkDraftYaml,
  LearningError,
  ResourceRefSchema,
} from '@learning/sdk';
import type {
  Answer,
  AnswerDraft,
  Assessment,
  AssessmentRef,
  OutlineNode,
  Resource,
} from '@learning/sdk';
import { publishJobArtifacts, runJobForeground } from '../foreground.js';
import { getOutput, CliError } from '../output.js';
import { readPreferences, setJobOutputRoot } from '../preferences.js';
import { requireConfirmation } from '../input.js';
import { executeAction, printResult, selectProfile, unwrapResult, withCliRuntime } from '../context.js';
import type { CliRuntime } from '../context.js';
import type { LocalProfile } from '../profiles.js';
import { cacheResources, courseCacheKey, resourceCacheKey, resourceKindCacheKey, resourceTitleCacheKey } from './catalog.js';
import { trackWorkflowEvent } from '../telemetry.js';

const MAX_DRAFT_BYTES = 4 * 1024 * 1024;
const MAX_DRAFT_FILES = 100;
const MAX_SCAN_DEPTH = 16;
const ISOLATED_PREPARE_CODES = new Set(['CONTENT_UNREADABLE', 'PRECONDITION_CHANGED', 'UNSUPPORTED']);

type HomeworkPlanItem = { key: string; title: string; path: string };
type DraftFile = { path: string; text: string; directory: boolean };
type SkippedItem = { file: string; questionId: string | null; code: string; message: string };
type ReadablePreview = {
  file: string;
  homework: string | null;
  answerJson: string;
  question: {
    id: string;
    kind: string;
    body: string;
    options: Array<{ key: string; body: string }>;
    answer: string;
    myAnswer: string | null;
    feedback: string | null;
  };
  previewId: string;
};

function invalid(message: string): never {
  throw new LearningError({ code: 'INVALID_INPUT', message, retryAfterMs: null, operationId: null });
}

function sameProfile(left: { profileId: string; userId: string; platform: string }, right: { profileId: string; userId: string; platform: string }): boolean {
  return left.profileId === right.profileId && left.userId === right.userId && left.platform === right.platform;
}

function flattenOutline(nodes: OutlineNode[]): Resource[] {
  return nodes.flatMap(node => [...node.resources, ...flattenOutline(node.children)]);
}

function planItem(resource: Resource): HomeworkPlanItem {
  return { key: resource.ref.key, title: resource.title, path: [...resource.path, resource.title].join(' / ') };
}

function isolatable(error: unknown): error is LearningError {
  return error instanceof LearningError && ISOLATED_PREPARE_CODES.has(error.data.code);
}

function isSimplifiedDraft(text: string): boolean {
  return /^format:\s*['"]?learning-homework\/v1['"]?\s*$/m.test(text);
}

function answerText(answer: Answer): string {
  if (answer.kind === 'choice') return answer.keys.join(', ');
  if (answer.kind === 'judgement') return answer.value ? '正确' : '错误';
  if (answer.kind === 'fill-blank') return answer.blanks.map(blank => blank.text).join(' | ');
  if (answer.kind === 'short-answer') return answer.text;
  return '未作答';
}

function legacyPreview(file: string, draft: AnswerDraft, questionId: string, previewId: string): ReadablePreview {
  const entry = draft.entries.find(item => item.questionId === questionId);
  if (entry === undefined) invalid(`question ${questionId} is missing from homework preview`);
  return {
    file,
    homework: null,
    answerJson: JSON.stringify(entry.answer),
    question: {
      id: questionId,
      kind: entry.answer.kind,
      body: '',
      options: [],
      answer: answerText(entry.answer),
      myAnswer: null,
      feedback: null,
    },
    previewId,
  };
}

function readablePreview(file: string, draft: AnswerDraft, assessment: Assessment, questionId: string, previewId: string): ReadablePreview {
  const question = assessment.questions.find(item => item.id === questionId);
  const entry = draft.entries.find(item => item.questionId === questionId);
  if (question === undefined || entry === undefined) invalid(`question ${questionId} is missing from homework preview`);
  return {
    file,
    homework: assessment.title,
    answerJson: JSON.stringify(entry.answer),
    question: {
      id: question.id,
      kind: question.kind,
      body: question.body.markdown.trim() || question.body.plainText.trim() || '[空]',
      options: question.options.map(option => ({ key: option.key, body: option.body.markdown.trim() || option.body.plainText.trim() || '[空]' })),
      answer: answerText(entry.answer),
      myAnswer: question.myAnswer === null ? null : answerText(question.myAnswer),
      feedback: question.feedback === null ? null : answerText(question.feedback.answer),
    },
    previewId,
  };
}

async function validDraftFile(path: string, directory = false): Promise<DraftFile> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DRAFT_BYTES) {
    invalid('draft must be a regular non-symlink file under 4 MiB');
  }
  return { path, text: await readFile(path, 'utf8'), directory };
}

async function scanAnswerFiles(root: string, path = root, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) invalid(`homework draft directory exceeds depth ${MAX_SCAN_DEPTH}`);
  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN'));
  const files: string[] = [];
  for (const entry of entries) {
    const child = resolve(path, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) files.push(...await scanAnswerFiles(root, child, depth + 1));
    else if (entry.isFile() && entry.name === 'answers.yaml') files.push(child);
  }
  if (files.length > MAX_DRAFT_FILES) invalid(`homework draft directory exceeds ${MAX_DRAFT_FILES} answer files`);
  return files;
}

async function selectDraftFiles(input: string, all: boolean | undefined): Promise<DraftFile[]> {
  const value = input;
  const stat = await lstat(value);
  if (stat.isSymbolicLink()) invalid('draft path must not be a symbolic link');
  if (stat.isFile()) return [await validDraftFile(value)];
  if (!stat.isDirectory()) invalid('draft path must be a regular file or directory');

  const root = resolve(value);
  const files = await scanAnswerFiles(root);
  if (files.length === 0) throw new CliError('INVALID_INPUT', `目录中没有 answers.yaml：${root}`, 2, ['file']);
  if (all !== true) throw new CliError('INVALID_INPUT', '目录批量作业需要 --all。', 2, ['all']);
  return Promise.all(files.map(async file => {
    const draft = await validDraftFile(file, true);
    const contained = relative(root, draft.path);
    if (contained === '' || contained.startsWith('..') || isAbsolute(contained)) invalid('selected draft escaped the requested directory');
    return draft;
  }));
}

async function ordinaryHomeworkResources(program: Command, runtime: CliRuntime, profile: LocalProfile, input: string | undefined, all: boolean | undefined): Promise<{ items: HomeworkPlanItem[]; resources: Resource[] }> {
  const client = createLearningClient({ scope: profile.scope, runtime });
  try {
    const cachedResource = input === undefined ? null : await runtime.state.get(resourceCacheKey(input));
    if (cachedResource !== null) {
      if (input === undefined) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
      const resource = ResourceRefSchema.parse(cachedResource.value);
      if (!sameProfile(resource.course.scope, profile.scope)) throw new CliError('FORBIDDEN', '资源属于另一个账号。', 3);
      const kind = (await runtime.state.get(resourceKindCacheKey(input)))?.value;
      const title = (await runtime.state.get(resourceTitleCacheKey(input)))?.value;
      if (kind !== 'homework') invalid('homework download requires an ordinary homework resource');
      const label = typeof title === 'string' && title !== '' ? title : input;
      return { items: [{ key: input, title: label, path: label }], resources: [{ ref: resource, title: label, kind: 'homework', path: [label], order: 0, durationSeconds: null, locked: null }] };
    }

    if (input === undefined) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
    if (all !== true) throw new CliError('INVALID_INPUT', '课程批量下载需要 --all。', 2, ['all']);
    let course;
    if (/^https?:\/\//i.test(input)) course = await client.catalog.resolveCourse(input);
    else {
      const storedCourse = await runtime.state.get(courseCacheKey(input));
      if (storedCourse === null) invalid('unknown course or resource key; run courses and outline first');
      course = CourseSchema.parse(storedCourse.value).ref;
    }
    if (!sameProfile(course.scope, profile.scope)) throw new CliError('FORBIDDEN', '课程属于另一个账号。', 3);
    const outline = unwrapResult(program, await client.catalog.outline(course));
    await cacheResources(runtime, outline.roots);
    const ordinary = flattenOutline(outline.roots).filter(resource => resource.kind === 'homework' && resource.locked !== true);
    if (ordinary.length === 0) throw new CliError('UNSUPPORTED', '此课程没有可下载的普通作业。', 3);
    return { items: ordinary.map(planItem), resources: ordinary };
  } finally {
    await client.close();
  }
}

async function resolveOrdinaryRefs(client: ReturnType<typeof createLearningClient>, resources: Resource[]): Promise<AssessmentRef[]> {
  const refs: AssessmentRef[] = [];
  for (const resource of resources) {
    const resolved = (await client.assessments.resolve(resource.ref)).filter(ref => ref.kind === 'homework');
    if (resolved.length !== 1) invalid(`expected one ordinary homework for resource ${resource.ref.key}`);
    refs.push(resolved[0]!);
  }
  return refs;
}

export function registerHomeworkCommands(program: Command): void {
  const homework = program.command('homework').description('下载、填写和提交普通作业');

  homework.command('download <course-or-resource>')
    .description('下载雨课堂普通作业的 Markdown 题面、本地图片和可编辑答案草稿')
    .option('--all', '下载课程内全部普通作业')
    .option('--output-dir <dir>', '导出目标根目录')
    .option('--dry-run', '只列出下载计划，不读取作业内容')
    .action(async (input: string | undefined, options: { all?: boolean; outputDir?: string; dryRun?: boolean }) => {
      if (input === undefined) throw new CliError('INVALID_INPUT', '缺少课程或资源。', 2, ['course-or-resource']);
      await withCliRuntime(program, true, async (runtime, homeDir) => {
        const profile = await selectProfile(program, runtime);
        if (profile.scope.platform !== 'ykt') throw new CliError('UNSUPPORTED', '当前作业下载流程仅支持雨课堂普通作业。', 3);
        const selection = await ordinaryHomeworkResources(program, runtime, profile, input, options.all);
        if (selection.items.length === 0) invalid('no ordinary homework selected');
        if (options.dryRun) {
          const data = { resources: selection.items, count: selection.items.length };
          getOutput(program).set(data, 'preview');
          return;
        }
        const client = createLearningClient({ scope: profile.scope, runtime });
        let files: string[];
        try {
          const refs = await resolveOrdinaryRefs(client, selection.resources);
          if (refs.length === 0) invalid('no ordinary homework resolved');
          const created = await client.jobs.createExport({ type: 'assessments', refs, format: 'homework' });
          const outputRoot = resolve(options.outputDir ?? (await readPreferences(runtime.state)).downloadDir ?? resolve(homeDir, 'exports'));
          await setJobOutputRoot(runtime.state, created.id, outputRoot);
          const job = await runJobForeground(client, runtime, created.id);
          files = await publishJobArtifacts(runtime, job, homeDir);
          if (job.status === 'partial') process.exitCode = 4;
          else if (job.status === 'uncertain') process.exitCode = 5;
          else if (job.status !== 'succeeded') process.exitCode = 3;
          trackWorkflowEvent(getOutput(program), { event: 'download_completed', properties: { job_statuses: [job.status], exported_file_count: files.length, homework_count: refs.length } });
          printResult(program, { job, files });
        } finally {
          await client.close();
        }
      });
    });

  homework.command('draft <resource>')
    .description('为作业生成 YAML 草稿；雨课堂普通作业使用简化答案格式')
    .requiredOption('-o, --output <file>', '新 YAML 草稿路径')
    .action(async (key: string, options: { output: string }) => {
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        const stored = await runtime.state.get(resourceCacheKey(key));
        if (stored === null) invalid('unknown resource key; run outline first');
        const resource = ResourceRefSchema.parse(stored.value);
        if (!sameProfile(resource.course.scope, profile.scope)) throw new CliError('FORBIDDEN', '资源属于另一个账号。', 3);
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const refs = (await client.assessments.resolve(resource)).filter(ref => ref.kind === 'homework' || ref.kind === 'embedded');
          if (refs.length !== 1) invalid('expected one homework or embedded assessment for this resource');
          const ref = refs[0]!;
          let text: string;
          let questions: number;
          if (profile.scope.platform === 'ykt' && ref.kind === 'homework') {
            const assessment = await client.assessments.get(ref);
            const draft = draftAssessment(assessment);
            text = exportHomeworkDraftYaml(draft, assessment);
            questions = assessment.questions.length;
          } else {
            const draft = await client.assessments.draft(ref);
            text = exportDraftYaml(draft);
            questions = draft.entries.length;
          }
          try {
            await writeFile(options.output, text, { flag: 'wx', mode: 0o600 });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new LearningError({ code: 'CONFLICT', message: 'output file exists; choose a new path', retryAfterMs: null, operationId: null }, { cause: error });
            throw error;
          }
          trackWorkflowEvent(getOutput(program), { event: 'homework_draft_created', properties: { question_count: questions } });
          printResult(program, { path: options.output, draftId: `draft-${ref.assessmentId}`, questions });
        } finally {
          await client.close();
        }
      });
    });

  homework.command('apply <file>')
    .description('预览或提交作业答案；目录按 answers.yaml 批量处理')
    .option('--all', '处理目录中的全部答案文件')
    .option('--dry-run', '只预览，不发送答案')
    .option('--yes', '确认提交全部选中答案')
    .action(async (file: string, options: { all?: boolean; dryRun?: boolean; yes?: boolean }) => {
      requireConfirmation(program, options.yes, options.dryRun);
      await withCliRuntime(program, true, async (runtime) => {
        const profile = await selectProfile(program, runtime);
        const files = await selectDraftFiles(file, options.all);
        const client = createLearningClient({ scope: profile.scope, runtime });
        try {
          const previews: ReadablePreview[] = [];
          const skipped: SkippedItem[] = [];
          const isolatedPreviews = new Set<string>();
          for (const draftFile of files) {
            const isolateFile = draftFile.directory || isSimplifiedDraft(draftFile.text);
            let draft: AnswerDraft;
            try {
              draft = unwrapResult(program, await client.assessments.importDraft(draftFile.text, 'learning'));
            } catch (error) {
              if (isolateFile && isolatable(error)) {
                skipped.push({ file: draftFile.path, questionId: null, code: error.data.code, message: error.data.message });
                getOutput(program).recordWarning(error.data.code, `${draftFile.path}: ${error.data.message}`);
                continue;
              }
              throw error;
            }
            const ordinaryYkt = draft.ref.kind === 'homework' && draft.ref.resource.course.scope.platform === 'ykt' && draft.ref.resource.native.kind === 'ykt' && draft.ref.resource.course.native.kind === 'ykt';
            if (draft.ref.kind !== 'homework' && draft.ref.kind !== 'embedded') invalid('draft is not homework or embedded exercise');
            if (draftFile.directory && !ordinaryYkt) invalid(`directory batch mode supports ordinary Yuketang homework only: ${draftFile.path}`);
            const answered = draft.entries.filter(entry => entry.answer.kind !== 'unset');
            if (answered.length === 0) {
              if (!draftFile.directory) throw new LearningError({ code: 'INVALID_INPUT', message: 'draft contains no answers to submit', retryAfterMs: null, operationId: null });
              const message = 'draft contains no answers to submit';
              skipped.push({ file: draftFile.path, questionId: null, code: 'INVALID_INPUT', message });
              getOutput(program).recordWarning('EMPTY_DRAFT', `${draftFile.path}: ${message}`);
              continue;
            }
            let assessment: Assessment | null = null;
            if (ordinaryYkt) {
              try {
                assessment = await client.assessments.get(draft.ref);
              } catch (error) {
                if (isolateFile && isolatable(error)) {
                  for (const entry of answered) skipped.push({ file: draftFile.path, questionId: entry.questionId, code: error.data.code, message: error.data.message });
                  getOutput(program).recordWarning(error.data.code, `${draftFile.path}: ${error.data.message}`);
                  continue;
                }
                throw error;
              }
            }
            for (const entry of answered) {
              try {
                const preview = await client.actions.prepare({ kind: 'homework.apply', draft, questionIds: [entry.questionId] });
                previews.push(assessment === null
                  ? legacyPreview(draftFile.path, draft, entry.questionId, preview.id)
                  : readablePreview(draftFile.path, draft, assessment, entry.questionId, preview.id));
                if (isolateFile) isolatedPreviews.add(preview.id);
              } catch (error) {
                if (isolateFile && isolatable(error)) {
                  skipped.push({ file: draftFile.path, questionId: entry.questionId, code: error.data.code, message: error.data.message });
                  getOutput(program).recordWarning(error.data.code, `${draftFile.path} ${entry.questionId}: ${error.data.message}`);
                  continue;
                }
                throw error;
              }
            }
          }
          if (previews.length === 0) {
            throw new LearningError({ code: 'INVALID_INPUT', message: skipped.length ? 'no submittable answers remain after validation' : 'draft contains no answers to submit', retryAfterMs: null, operationId: null });
          }
          const receipts: Awaited<ReturnType<typeof client.actions.execute>>[] = [];
          const result = { files: files.map(file => file.path), previews, skipped, receipts };
          getOutput(program).set(result, 'preview');
          if (options.dryRun) {
            return;
          }
          for (const preview of previews) {
            try {
              const execution = await executeAction(getOutput(program), client, preview.previewId);
              receipts.push(execution);
              if (execution.type === 'receipt' && execution.receipt.state === 'uncertain') {
                throw new LearningError({ code: 'UNCERTAIN', message: 'homework submission outcome is uncertain; use reconcile', retryAfterMs: null, operationId: execution.receipt.operationId });
              }
            } catch (error) {
              if (isolatable(error) && isolatedPreviews.has(preview.previewId)) {
                skipped.push({ file: preview.file, questionId: preview.question.id, code: error.data.code, message: error.data.message });
                getOutput(program).recordWarning(error.data.code, `${preview.file} ${preview.question.id}: ${error.data.message}`);
                continue;
              }
              throw error;
            }
          }
          trackWorkflowEvent(getOutput(program), { event: 'homework_answers_submitted', properties: { answer_count: receipts.length, skipped_count: skipped.length } });
          if (skipped.length > 0) process.exitCode = 4;
          printResult(program, result);
        } finally {
          await client.close();
        }
      });
    });
}
