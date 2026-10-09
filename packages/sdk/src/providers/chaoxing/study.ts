import { parse } from 'parse5';
import { z } from 'zod';
import { md5Hex } from '../../crypto/md5.js';
import { LearningError } from '../../types/errors.js';
import type { Outline, OutlineNode, Progress, Receipt, Resource } from '../../types/models.js';
import type { ActionInput, ItemResult, Job } from '../../types/models.js';
import type { CourseRef, ResourceRef, Scope } from '../../types/refs.js';
import { keyOfCourse, keyOfResource } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import type { Clock } from '../../runtime/types.js';
import type { JobRunner } from '../../services/jobs.js';

const MAX_CARD_INDEX = 5;
const CHAOXING_BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CHAOXING_VIDEO_REFERER = 'https://mooc1.chaoxing.com/ananas/modules/video/index.html?v=2025-0725-1842';

export interface ChaoxingCourseIds {
  courseId: string;
  clazzId: string;
  cpi: string;
}

export function parseChaoxingCourseUrl(url: string): ChaoxingCourseIds {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw invalid('course must be an HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)*chaoxing\.com$/i.test(parsed.hostname) || parsed.pathname !== '/mooc2-ans/mycourse/stu') {
    throw invalid('course URL host/path is not Chaoxing mooc2');
  }
  const raw = {
    courseId: parsed.searchParams.get('courseid') ?? parsed.searchParams.get('courseId'),
    clazzId: parsed.searchParams.get('clazzid') ?? parsed.searchParams.get('clazzId'),
    cpi: parsed.searchParams.get('cpi'),
  };
  const ids = {
    courseId: raw.courseId ?? '',
    clazzId: raw.clazzId ?? '',
    cpi: raw.cpi ?? '',
  };
  if (!Object.values(ids).every((value) => /^[1-9]\d*$/.test(value) && Number(value) <= Number.MAX_SAFE_INTEGER)) {
    throw invalid('course URL needs valid courseId, clazzId, and cpi');
  }
  return ids;
}

export function chaoxingCourseRef(scope: Scope, url: string): CourseRef {
  const ids = parseChaoxingCourseUrl(url);
  const native = { kind: 'chaoxing' as const, ...ids };
  return { scope, key: keyOfCourse({ scope, key: 'pending', native }), native };
}

interface ElementNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: Array<ElementNode | { nodeName: string; value?: string }>;
}

function isElement(node: unknown): node is ElementNode {
  return typeof node === 'object' && node !== null && 'tagName' in node && 'attrs' in node;
}

function attr(node: ElementNode, name: string): string | null {
  return node.attrs?.find((item) => item.name === name)?.value ?? null;
}

function classes(node: ElementNode): string[] {
  return (attr(node, 'class') ?? '').split(/\s+/).filter(Boolean);
}

function descendants(node: ElementNode): ElementNode[] {
  return (node.childNodes ?? []).filter(isElement).flatMap((child) => [child, ...descendants(child)]);
}

function elementText(node: ElementNode): string {
  return (node.childNodes ?? [])
    .flatMap((child) => (isElement(child) ? [elementText(child)] : 'value' in child && typeof child.value === 'string' ? [child.value] : []))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface ChaoxingOutlineKnowledge {
  knowledgeId: string;
  title: string;
  jobCount: number;
}

export interface ChaoxingOutlineUnit {
  title: string;
  children: ChaoxingOutlineKnowledge[];
}

export function parseChaoxingOutlineHtml(html: string): ChaoxingOutlineUnit[] {
  const document = parse(html);
  const units = descendants(document as unknown as ElementNode).filter((node) => classes(node).includes('chapter_unit'));
  const result: ChaoxingOutlineUnit[] = [];
  for (const unit of units) {
    const unitFolder = descendants(unit).find((node) => classes(node).includes('catalog_title'));
    const unitTitle = unitFolder === undefined
      ? undefined
      : descendants(unitFolder).find((node) => classes(node).includes('clicktitle'));
    const title = unitTitle === undefined ? '' : elementText(unitTitle);
    const children: ChaoxingOutlineKnowledge[] = [];
    for (const item of descendants(unit)) {
      const id = attr(item, 'id') ?? '';
      if (item.tagName !== 'div' || !/^cur[1-9]\d*$/.test(id)) continue;
      const knowledgeId = id.slice(3);
      const titleLink = descendants(item).find((node) => node.tagName === 'a' && classes(node).includes('clicktitle'));
      const jobRaw = descendants(item).find((node) => classes(node).includes('knowledgeJobCount'));
      const jobCount = jobRaw === undefined ? 0 : Number(attr(jobRaw, 'value') ?? 0);
      if (!/^[1-9]\d*$/.test(knowledgeId) || !Number.isSafeInteger(jobCount) || jobCount < 0) {
        throw protocol('outline contains an invalid knowledge node');
      }
      const knowledgeTitle = titleLink === undefined ? '' : elementText(titleLink);
      if (knowledgeTitle === '') throw protocol('outline knowledge node has no title');
      children.push({ knowledgeId, title: knowledgeTitle, jobCount });
    }
    if (title === '') throw protocol('outline unit has no title');
    result.push({ title, children });
  }
  if (result.length === 0) throw protocol('outline has no chapter units');
  return result;
}

const DefaultsSchema = z.object({
  fid: z.string().min(1),
  userid: z.string().regex(/^[1-9]\d*$/),
  cpi: z.union([z.string().regex(/^[1-9]\d*$/), z.number().refine(Number.isSafeInteger).positive()]),
  reportUrl: z.string().url(),
  reportTimeInterval: z.number().refine(Number.isSafeInteger).positive(),
});

const VideoAttachmentSchema = z.object({
  type: z.literal('video'),
  otherInfo: z.string().min(1),
  mid: z.string().min(1),
  jobid: z.string().min(1),
  attDurationEnc: z.string().min(1),
  attDuration: z.number().refine(Number.isFinite).positive(),
  objectId: z.string().min(1),
  property: z.object({
    name: z.string().min(1),
    doublespeed: z.number().refine(Number.isFinite).positive().optional(),
  }).passthrough(),
  isPassed: z.boolean().optional().default(false),
}).passthrough();

const CardSchema = z.object({
  attachments: z.array(z.unknown()),
  defaults: DefaultsSchema,
  knowledgename: z.string(),
}).passthrough();

export interface ChaoxingVideoCard {
  otherInfo: string;
  mid: string;
  jobid: string;
  attDurationEnc: string;
  duration: number;
  objectId: string;
  title: string;
  isPassed: boolean;
}

export interface ChaoxingCardDefaults {
  fid: string;
  userid: string;
  cpi: string;
  reportUrl: string;
  reportTimeInterval: number;
}

export interface ChaoxingCard {
  title: string;
  videos: ChaoxingVideoCard[];
  defaults: ChaoxingCardDefaults | null;
}

function balancedJsonObject(text: string, from: number): unknown | null {
  const start = text.indexOf('{', from);
  if (start < 0) return null;
  let depth = 0;
  let quoted = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '\\') index += 1;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, index + 1)) as unknown;
        } catch {
          throw protocol('card mArg JSON is invalid');
        }
      }
    }
  }
  return null;
}

export function parseChaoxingCardsHtml(html: string): ChaoxingCard {
  const matches = [...html.matchAll(/mArg\s*=\s*/g)];
  const last = matches.at(-1);
  const raw = last === undefined ? null : balancedJsonObject(html, (last.index ?? 0) + last[0].length);
  if (raw === null) return { title: '', videos: [], defaults: null };
  const parsed = CardSchema.parse(raw);
  const videos: ChaoxingVideoCard[] = [];
  for (const attachment of parsed.attachments) {
    const video = VideoAttachmentSchema.safeParse(attachment);
    if (!video.success) {
      if ((attachment as { type?: unknown } | null)?.type === 'video') throw protocol('video attachment is incomplete');
      continue;
    }
    videos.push({
      otherInfo: video.data.otherInfo.split('&', 1)[0] ?? video.data.otherInfo,
      mid: video.data.mid,
      jobid: video.data.jobid,
      attDurationEnc: video.data.attDurationEnc,
      duration: video.data.attDuration,
      objectId: video.data.objectId,
      title: video.data.property.name,
      isPassed: video.data.isPassed,
    });
  }
  return {
    title: parsed.knowledgename,
    videos,
    defaults: {
      fid: parsed.defaults.fid,
      userid: parsed.defaults.userid,
      cpi: String(parsed.defaults.cpi),
      reportUrl: parsed.defaults.reportUrl,
      reportTimeInterval: parsed.defaults.reportTimeInterval,
    },
  };
}

export interface ChaoxingReportEncOptions {
  clazzId: string;
  userid: string;
  jobid: string;
  objectId: string;
  playingTime: number;
  duration: number;
}

export function chaoxingReportEnc(options: ChaoxingReportEncOptions): string {
  for (const value of [options.playingTime, options.duration]) {
    if (!Number.isFinite(value) || value < 0 || !Number.isSafeInteger(value)) throw invalid('Chaoxing progress time must be an integer');
  }
  return md5Hex(
    `[${options.clazzId}][${options.userid}][${options.jobid}][${options.objectId}]` +
    `[${options.playingTime * 1000}][d_yHJ!$pdA~5]` +
    `[${options.duration * 1000}][0_${options.duration}]`,
  );
}

export interface ChaoxingProgressUrlOptions extends ChaoxingReportEncOptions {
  cpi: string;
  dtoken: string;
  otherInfo: string;
  courseId: string;
  timestampMs: number;
  attDuration: number;
  attDurationEnc: string;
}

export function buildChaoxingProgressUrl(options: ChaoxingProgressUrlOptions): string {
  const enc = chaoxingReportEnc(options);
  const query = new URLSearchParams({
    clazzId: options.clazzId,
    playingTime: String(options.playingTime),
    duration: String(options.duration),
    clipTime: `0_${options.duration}`,
    objectId: options.objectId,
    otherInfo: options.otherInfo,
    courseId: options.courseId,
    jobid: options.jobid,
    userid: options.userid,
    isdrag: '3',
    view: 'pc',
    enc,
    rt: '0.9',
    dtype: 'Video',
    _t: String(options.timestampMs),
    attDuration: String(options.attDuration),
    attDurationEnc: options.attDurationEnc,
    courseEngineInfo: 'false',
  });
  return `https://mooc1.chaoxing.com/mooc-ans/multimedia/log/a/${options.cpi}/${encodeURIComponent(options.dtoken)}?${query.toString()}`;
}

function cardUrl(course: CourseRef, knowledgeId: string, index: number): string {
  if (course.native.kind !== 'chaoxing') throw invalid('course is not a Chaoxing course');
  const query = new URLSearchParams({
    clazzid: course.native.clazzId,
    courseid: course.native.courseId,
    knowledgeid: knowledgeId,
    num: String(index),
    ut: 's',
    cpi: course.native.cpi,
    v: '2025-0424-1038-3',
    mooc2: '1',
  });
  return `https://mooc1.chaoxing.com/mooc-ans/knowledge/cards?${query.toString()}`;
}

async function fetchCard(http: SessionHttp, course: CourseRef, knowledgeId: string, index: number): Promise<ChaoxingCard> {
  const response = await http.request({ kind: 'read', method: 'GET', url: cardUrl(course, knowledgeId, index) });
  const html = await response.text();
  if (response.status !== 200) throw protocol(`knowledge cards returned HTTP ${response.status}`);
  if (/passport2\.chaoxing\.com\/login/i.test(html)) throw authRequired();
  return parseChaoxingCardsHtml(html);
}

export async function chaoxingOutline(http: SessionHttp, ref: CourseRef): Promise<{ value: Outline; warnings: [] }> {
  if (ref.native.kind !== 'chaoxing') throw invalid('outline requires a Chaoxing course');
  const query = new URLSearchParams({
    courseid: ref.native.courseId,
    clazzid: ref.native.clazzId,
    cpi: ref.native.cpi,
    ut: 's',
  });
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/studentcourse?${query.toString()}`,
  });
  const html = await response.text();
  if (response.status !== 200) throw protocol(`studentcourse returned HTTP ${response.status}`);
  if (/passport2\.chaoxing\.com\/login/i.test(html)) throw authRequired();
  const units = parseChaoxingOutlineHtml(html);
  const roots: OutlineNode[] = [];
  let order = 0;
  let complete = true;
  for (const [unitIndex, unit] of units.entries()) {
    const children: OutlineNode[] = [];
    for (const knowledge of unit.children) {
      const resources: Resource[] = [];
      if (knowledge.jobCount > 0) {
        for (let index = 0; index <= MAX_CARD_INDEX; index += 1) {
          const card = await fetchCard(http, ref, knowledge.knowledgeId, index);
          if (card.defaults === null) break;
          for (const video of card.videos) {
            const native = {
              kind: 'chaoxing' as const,
              knowledgeId: knowledge.knowledgeId,
              cardIndex: index,
              objectId: video.objectId,
              jobid: video.jobid,
              mid: video.mid,
            };
            resources.push({
              ref: { course: ref, key: keyOfResource({ course: ref, key: 'pending', native }), native },
              title: video.title,
              kind: 'video',
              path: [unit.title, knowledge.title, card.title],
              order: order++,
              durationSeconds: video.duration,
              locked: null,
            });
          }
        }
      }
      if (resources.length !== knowledge.jobCount) complete = false;
      children.push({
        id: `chaoxing:${unitIndex}:${knowledge.knowledgeId}`,
        title: knowledge.title,
        children: [],
        resources,
      });
    }
    roots.push({ id: `chaoxing-unit:${unitIndex}`, title: unit.title, children, resources: [] });
  }
  return { value: { course: ref, roots, completeness: complete ? 'complete' : 'unknown' }, warnings: [] };
}

interface ObservedVideo {
  video: ChaoxingVideoCard;
  defaults: NonNullable<ChaoxingCard['defaults']>;
  progress: Progress;
}

async function readVideo(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<ObservedVideo> {
  if (resource.native.kind !== 'chaoxing' || resource.course.native.kind !== 'chaoxing') throw invalid('progress requires a Chaoxing video');
  const native = resource.native;
  const card = await fetchCard(http, resource.course, resource.native.knowledgeId, resource.native.cardIndex);
  const video = card.videos.find((item) => item.objectId === native.objectId && item.jobid === native.jobid && item.mid === native.mid);
  const defaults = card.defaults;
  if (video === undefined || defaults === null) throw protocol('requested video is missing from its card');
  if (defaults.cpi !== resource.course.native.cpi) throw protocol('card cpi does not match the course');
  const reportUrl = new URL(defaults.reportUrl);
  if (reportUrl.origin !== 'https://mooc1.chaoxing.com' || reportUrl.pathname !== `/mooc-ans/multimedia/log/a/${defaults.cpi}`) {
    throw protocol('card report URL is outside the allowlisted Chaoxing path');
  }
  return {
    video,
    defaults,
    progress: {
      resource,
      serverCompleted: video.isPassed,
      serverFraction: video.isPassed ? 1 : null,
      serverSeconds: null,
      durationSeconds: video.duration,
      observedAtMs: clock.nowMs(),
    },
  };
}

export async function chaoxingReadProgress(http: SessionHttp, clock: Clock, resource: ResourceRef): Promise<Progress> {
  return (await readVideo(http, clock, resource)).progress;
}

const StatusSchema = z.object({
  status: z.string().min(1),
  dtoken: z.string().min(1),
  duration: z.number().refine(Number.isFinite).positive(),
}).passthrough();

async function readStatus(http: SessionHttp, video: ObservedVideo, objectId: string): Promise<{ dtoken: string; duration: number }> {
  const query = new URLSearchParams({ k: video.defaults.fid, flag: 'normal' });
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `https://mooc1.chaoxing.com/ananas/status/${encodeURIComponent(objectId)}?${query.toString()}`,
    headers: {
      referer: CHAOXING_VIDEO_REFERER,
      'user-agent': CHAOXING_BROWSER_UA,
    },
  });
  if (response.status !== 200) throw protocol(`media status returned HTTP ${response.status}`);
  const parsed = StatusSchema.safeParse(await response.json());
  if (!parsed.success) throw protocol('media status is invalid');
  if (parsed.data.duration !== video.video.duration) throw protocol('media status duration differs from card duration');
  return parsed.data;
}

const ReportResponseSchema = z.object({
  isPassed: z.boolean(),
  videoTimeLimit: z.boolean(),
  hasJobLimit: z.boolean(),
}).passthrough();

interface StudyCursor {
  resourceKey: string;
  seconds: number;
  sequence: number;
  lastReportAtMs: number;
}

function parseCursor(raw: string | null): StudyCursor | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Partial<StudyCursor>;
    if (typeof value.resourceKey !== 'string' || typeof value.seconds !== 'number' || typeof value.sequence !== 'number' || typeof value.lastReportAtMs !== 'number' ||
      !Number.isFinite(value.seconds) || value.seconds < 0 || !Number.isSafeInteger(value.sequence) || value.sequence <= 0) return null;
    return value as StudyCursor;
  } catch {
    return null;
  }
}

export async function advanceChaoxingStudy(input: {
  job: Job;
  action: Extract<ActionInput, { kind: 'study' }>;
  runner: JobRunner;
  http: SessionHttp;
  clock: Clock;
}): Promise<Job> {
  const { job, action, runner, http, clock } = input;
  const next = action.resources.find((resource) => !job.items.some((item) => item.key === resource.key));
  if (next === undefined) return runner.advance(job.id, async () => ({ completed: true }));
  return runner.advance(job.id, async () => {
    const now = clock.nowMs();
    const finish = (state: ItemResult['state'], message: string | null) => {
      const items: ItemResult[] = [...job.items, { key: next.key, state, message, artifacts: [] }];
      return { completed: items.length === action.resources.length, items, ...(state === 'needs-input' ? { status: 'needs-input' as const } : {}) };
    };
    if (now - job.createdAtMs > action.settings.maxDurationSeconds * 1000) return finish('needs-input', 'study duration budget expired');
    const observed = await readVideo(http, clock, next);
    const duration = observed.progress.durationSeconds;
    if (duration === null) return finish('needs-input', 'Chaoxing video duration is unknown');
    if (observed.progress.serverCompleted) return finish('succeeded', 'server completed');
    await runner.emitProgress(job.id, next.key, observed.progress.serverFraction ?? 0, {
      title: observed.video.title,
      durationSeconds: duration,
      serverSeconds: null,
    });
    const previous = parseCursor((await runner.metadata(job.id)).cursor);
    const cursor = previous?.resourceKey === next.key ? previous : null;
    const interval = observed.defaults.reportTimeInterval * 1000;
    const remainingSeconds = duration * action.settings.targetFraction - (cursor?.seconds ?? 0);
    const waitMs = Math.max(0, Math.min(interval, remainingSeconds / action.settings.speed * 1000));
    const dueAt = cursor?.lastReportAtMs ?? now;
    if (cursor !== null && now < dueAt + waitMs) {
      return { completed: false, status: 'waiting' as const, nextRunAtMs: dueAt + waitMs };
    }
    const elapsed = cursor === null ? 0 : Math.max(0, (now - cursor.lastReportAtMs) / 1000);
    const playingTime = cursor === null
      ? 0
      : Math.min(duration, Math.round(cursor.seconds + elapsed * action.settings.speed));
    const sequence = (cursor?.sequence ?? 0) + 1;
    const operationId = `chaoxing-report:${job.id}:${next.key}:${sequence}`;
    // Keep pending state narrowly around the effectful GET; media status can be retried safely.
    const status = await readStatus(http, observed, next.native.kind === 'chaoxing' ? next.native.objectId : '');
    await runner.setCursor(job.id, JSON.stringify({
      resourceKey: next.key,
      seconds: playingTime,
      sequence,
      lastReportAtMs: now,
    } satisfies StudyCursor));
    await runner.setPendingOperation(job.id, operationId);
    try {
      const reportUrl = buildChaoxingProgressUrl({
        clazzId: next.course.native.kind === 'chaoxing' ? next.course.native.clazzId : '',
        userid: observed.defaults.userid,
        jobid: observed.video.jobid,
        objectId: observed.video.objectId,
        playingTime,
        duration,
        cpi: observed.defaults.cpi,
        dtoken: status.dtoken,
        otherInfo: observed.video.otherInfo,
        courseId: next.course.native.kind === 'chaoxing' ? next.course.native.courseId : '',
        timestampMs: now,
        attDuration: observed.video.duration,
        attDurationEnc: observed.video.attDurationEnc,
      });
      const response = await http.request({
        kind: 'write',
        method: 'GET',
        url: reportUrl,
        headers: { referer: cardUrl(next.course, next.native.kind === 'chaoxing' ? next.native.knowledgeId : '', next.native.kind === 'chaoxing' ? next.native.cardIndex : 0) },
      });
      if (response.status !== 200) throw Error(`HTTP ${response.status}`);
      const parsed = ReportResponseSchema.safeParse(await response.json());
      if (!parsed.success) throw Error('invalid acknowledgement');
      if (parsed.data.videoTimeLimit || parsed.data.hasJobLimit) {
        await runner.setPendingOperation(job.id, null);
        return finish('needs-input', 'Chaoxing requires an interaction before progress can continue');
      }
      const targetSeconds = duration * action.settings.targetFraction;
      if (playingTime >= targetSeconds) {
        if (action.settings.targetFraction >= 1) {
          const confirmed = await readVideo(http, clock, next);
          await runner.setPendingOperation(job.id, null);
          if (!confirmed.progress.serverCompleted) return finish('needs-input', 'final report acknowledged but server pass state was not observed');
          return finish('succeeded', 'server completed');
        }
        await runner.setPendingOperation(job.id, null);
        return finish('succeeded', 'target report acknowledged; server completion is not claimed');
      }
      await runner.setPendingOperation(job.id, null);
      return { completed: false, status: 'waiting' as const, nextRunAtMs: now + Math.max(0, Math.min(interval, (duration * action.settings.targetFraction - playingTime) / action.settings.speed * 1000)) };
    } catch {
      throw new LearningError({ code: 'UNCERTAIN', message: 'Chaoxing progress report outcome is unknown; reconcile before resending', retryAfterMs: null, operationId });
    }
  });
}

export async function reconcileChaoxingReport(input: {
  job: Job;
  action: Extract<ActionInput, { kind: 'study' }>;
  runner: JobRunner;
  http: SessionHttp;
  clock: Clock;
  operationId: string;
}): Promise<Receipt> {
  const meta = await input.runner.metadata(input.job.id);
  const cursor = parseCursor(meta.cursor);
  if (meta.pendingOperationId !== input.operationId || cursor === null || input.job.status !== 'uncertain') {
    throw new LearningError({ code: 'PRECONDITION_CHANGED', message: 'job has no matching uncertain Chaoxing report', retryAfterMs: null, operationId: input.operationId });
  }
  const resource = input.action.resources.find((item) => item.key === cursor.resourceKey);
  if (resource === undefined) throw new LearningError({ code: 'INTEGRITY', message: 'Chaoxing cursor resource is missing', retryAfterMs: null, operationId: input.operationId });
  const observed = await readVideo(input.http, input.clock, resource);
  if (!observed.progress.serverCompleted) {
    return { operationId: input.operationId, state: 'uncertain', message: 'server pass state is not visible; do not resend', result: { serverCompleted: false } };
  }
  await input.runner.confirmPendingAndPause(input.job.id, input.operationId);
  return { operationId: input.operationId, state: 'confirmed', message: 'Chaoxing pass state confirmed', result: { serverCompleted: true } };
}

function invalid(message: string): LearningError {
  return new LearningError({ code: 'INVALID_INPUT', message, retryAfterMs: null, operationId: null });
}

function protocol(message: string): LearningError {
  return new LearningError({ code: 'PROTOCOL', message, retryAfterMs: null, operationId: null });
}

function authRequired(): LearningError {
  return new LearningError({ code: 'AUTH_REQUIRED', message: 'Chaoxing login is required', retryAfterMs: null, operationId: null });
}
