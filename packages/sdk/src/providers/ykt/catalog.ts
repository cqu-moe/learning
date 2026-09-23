import { LearningError } from '../../types/errors.js';
import type { Course, Outline, OutlineNode, Resource, ResourceKind } from '../../types/models.js';
import type { Page } from '../../types/errors.js';
import type { Scope } from '../../types/refs.js';
import { keyOfCourse, keyOfResource } from '../../types/refs.js';
import type { CourseRef } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { ClassroomWire, CourseListWire, HasKgWire, KgChapterWire, StandardChapterWire, moocEnvelopeChecked, YKT_BASE } from './schemas.js';
import { RawNode as RawNodeSchema } from './schemas.js';
import type { RawNode } from './schemas.js';

export interface ClassroomContext {
  classroomId: string;
  courseSign: string;
  skuId: string;
  universityId: string;
  courseName: string | null;
}

export async function fetchClassroomContext(http: SessionHttp, classroomId: string): Promise<ClassroomContext> {
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/v2/api/web/classrooms/${classroomId}?role=5`,
  });
  const parsed = ClassroomWire.parse(await response.json());
  return {
    classroomId,
    courseSign: parsed.data.course_sign,
    skuId: String(parsed.data.free_sku_id),
    universityId: String(parsed.data.uv_id),
    courseName: parsed.data.course_name ?? null,
  };
}

/** has_kg decision needs the full identity header set (Y08); success=false is a protocol failure. */
export function parseHasKg(payload: unknown): { kgId: string } | null {
  if (typeof payload === 'object' && payload !== null && (payload as { success?: unknown }).success === false) {
    throw new LearningError({
      code: 'PROTOCOL',
      message: `has_kg: success=false ${String((payload as { msg?: unknown }).msg ?? '')}`.trim(),
      retryAfterMs: null,
      operationId: null,
    });
  }
  const parsed = HasKgWire.parse(payload);
  if (!parsed.data.has) return null;
  return { kgId: String(parsed.data.kg_id ?? 0) };
}

export async function detectKg(http: SessionHttp, classroomId: string, universityId: string): Promise<{ kgId: string } | null> {
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/c27/online_courseware/course/classroom/${classroomId}/has_kg/?is_student=1&uv_id=${universityId}&classroom_id=${classroomId}`,
    headers: {
      xtbz: 'ykt',
      'university-id': universityId,
      'uv-id': universityId,
      'classroom-id': classroomId,
      'xt-agent': 'web',
    },
  });
  return parseHasKg(await response.json());
}

function leafKind(leafType: number | null | undefined): ResourceKind {
  switch (leafType) {
    case 0:
      return 'video';
    case 3:
      return 'document';
    case 5:
      return 'exam';
    case 6:
      return 'homework';
    default:
      return 'unknown';
  }
}

interface FlatLeaf {
  leafId: string;
  leafInfoId: string | null;
  name: string;
  leafType: number | null;
  order: number;
  sectionPath: string[];
}

function toLeaf(raw: RawNode, sectionPath: string[]): FlatLeaf {
  if (raw.id === undefined || raw.id === 0) {
    throw new LearningError({
      code: 'PROTOCOL',
      message: 'course tree leaf is missing its id; refusing to coerce 0',
      retryAfterMs: null,
      operationId: null,
    });
  }
  return {
    leafId: String(raw.id),
    leafInfoId: raw.leafinfo_id !== undefined && raw.leafinfo_id !== 0 ? String(raw.leafinfo_id) : null,
    name: raw.name ?? '',
    leafType: raw.leaf_type ?? null,
    order: raw.order ?? 0,
    sectionPath,
  };
}

/** Standard tree: heterogenous section_leaf_list — folders (leaf_type null + leaf_list) vs direct leaves. */
export function parseStandardChapterPayload(payload: unknown): { chapters: { id: string; name: string; leaves: FlatLeaf[] }[] } {
  moocEnvelopeChecked(payload, 'course/chapter');
  const parsed = StandardChapterWire.parse(payload);
  const walk = (entries: unknown[], path: string[], out: FlatLeaf[]): FlatLeaf[] => {
    for (const entry of entries) {
      const node = RawNodeSchema.parse(entry);
      const children = node.leaf_list ?? [];
      if (children.length > 0) {
        walk(children, [...path, node.name ?? ''], out);
      } else if (node.leaf_type !== null && node.leaf_type !== undefined) {
        out.push(toLeaf(node, path));
      }
    }
    return out;
  };
  return {
    chapters: parsed.data.course_chapter.map((chapter) => ({
      id: String(chapter.id ?? 0),
      name: chapter.name ?? '',
      leaves: walk(chapter.section_leaf_list ?? [], [], []),
    })),
  };
}

/** KG tree: every node has leaf_list (direct) and children (subsections); root leaves are preserved. */
export function parseKgChapterPayload(payload: unknown): { chapters: { id: string; name: string; leaves: FlatLeaf[] }[] } {
  moocEnvelopeChecked(payload, 'kg/student_learn_chapter');
  const parsed = KgChapterWire.parse(payload);
  const root = parsed.data.course_chapter;
  const walk = (nodeInput: unknown, path: string[], out: FlatLeaf[]): FlatLeaf[] => {
    const node = RawNodeSchema.parse(nodeInput);
    for (const leaf of node.leaf_list ?? []) out.push(toLeaf(RawNodeSchema.parse(leaf), path));
    for (const child of node.children ?? []) walk(child, [...path, RawNodeSchema.parse(child).name ?? ''], out);
    return out;
  };
  const chapters: { id: string; name: string; leaves: FlatLeaf[] }[] = [];
  const rootLeaves = (root.leaf_list ?? []).map((leaf) => toLeaf(RawNodeSchema.parse(leaf), []));
  if (rootLeaves.length > 0) {
    chapters.push({ id: String(root.id ?? 0), name: root.name ?? '', leaves: rootLeaves });
  }
  for (const chapterInput of root.children ?? []) {
    const chapter = RawNodeSchema.parse(chapterInput);
    chapters.push({
      id: String(chapter.id ?? 0),
      name: chapter.name ?? '',
      leaves: walk(chapter, [], []),
    });
  }
  return { chapters };
}

function buildOutline(scope: Scope, course: CourseRef, chapters: { id: string; name: string; leaves: FlatLeaf[] }[], system: 'ykt-standard' | 'ykt-kg'): Outline {
  const roots: OutlineNode[] = chapters.map((chapter, chapterIndex) => {
    const sections = new Map<string, { title: string; children: OutlineNode[]; resources: Resource[] }>();
    const resources: Resource[] = [];
    for (const leaf of chapter.leaves) {
      const resource: Resource = {
        ref: {
          course,
          key: keyOfResource({
            course,
            key: 'pending',
            native: { kind: 'ykt', leafId: leaf.leafId, leafInfoId: leaf.leafInfoId },
          }),
          native: { kind: 'ykt', leafId: leaf.leafId, leafInfoId: leaf.leafInfoId },
        },
        title: leaf.name,
        kind: leafKind(leaf.leafType),
        path: [chapter.name, ...leaf.sectionPath],
        order: leaf.order,
        durationSeconds: null,
        locked: null,
      };
      if (leaf.sectionPath.length === 0) {
        resources.push(resource);
      } else {
        const sectionKey = leaf.sectionPath.join('/');
        const section = sections.get(sectionKey) ?? { title: leaf.sectionPath[leaf.sectionPath.length - 1] ?? '', children: [], resources: [] };
        section.resources.push(resource);
        sections.set(sectionKey, section);
      }
    }
    return {
      id: `ch:${chapterIndex}:${chapter.id}`,
      title: chapter.name,
      children: [...sections.entries()].map(([key, section], index) => ({
        id: `sec:${chapterIndex}:${key}:${index}`,
        title: section.title,
        children: section.children,
        resources: section.resources,
      })),
      resources,
    };
  });
  void system;
  return { course, roots, completeness: 'complete' };
}

export async function yktOutline(http: SessionHttp, scope: Scope, ref: CourseRef): Promise<{ value: Outline; warnings: [] }> {
  if (ref.native.kind !== 'ykt') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'ykt outline requires a ykt course ref', retryAfterMs: null, operationId: null });
  }
  const context = await fetchClassroomContext(http, ref.native.classroomId);
  const kg = await detectKg(http, ref.native.classroomId, context.universityId);
  if (kg !== null) {
    const response = await http.request({
      kind: 'read',
      method: 'GET',
      url: `${YKT_BASE}/mooc-api/v1/lms/kg/student_learn_chapter/?cid=${ref.native.classroomId}&term=latest&uv_id=${context.universityId}&classroom_id=${ref.native.classroomId}`,
      headers: { xtbz: 'ykt' },
    });
    const parsed = parseKgChapterPayload(await response.json());
    return { value: buildOutline(scope, ref, parsed.chapters, 'ykt-kg'), warnings: [] };
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/mooc-api/v1/lms/learn/course/chapter?cid=${ref.native.classroomId}&sign=${context.courseSign}`,
    headers: { xtbz: 'ykt' },
  });
  const parsed = parseStandardChapterPayload(await response.json());
  return { value: buildOutline(scope, ref, parsed.chapters, 'ykt-standard'), warnings: [] };
}

export async function yktCourses(http: SessionHttp, scope: Scope): Promise<Page<Course>> {
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${YKT_BASE}/v2/api/web/courses/list?identity=2`,
  });
  const parsed = CourseListWire.parse(await response.json());
  if (parsed.errcode !== 0) {
    throw new LearningError({ code: 'PROTOCOL', message: `courses/list errcode=${parsed.errcode}`, retryAfterMs: null, operationId: null });
  }
  const items = parsed.data.list.map((raw) => {
    const native = { kind: 'ykt' as const, classroomId: String(raw.classroom_id) };
    return {
      ref: { scope, key: keyOfCourse({ scope, key: 'pending', native }), native },
      title: raw.course.name ?? String(raw.classroom_id),
      system: null,
      term: raw.term === undefined ? null : String(raw.term),
      teachers: (raw.course.teachers ?? []).map((t) => t.name ?? '').filter((name) => name !== ''),
      locked: null,
    } satisfies Course;
  });
  return { items, nextCursor: null, completeness: 'complete', warnings: [] };
}

export function yktResolveCourse(scope: Scope, url: string): CourseRef {
  const match = /\/studentLog\/(\d+)/.exec(url);
  if (match === null) {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'url does not contain a studentLog classroom id', retryAfterMs: null, operationId: null });
  }
  const native = { kind: 'ykt' as const, classroomId: match[1] ?? '' };
  return { scope, key: keyOfCourse({ scope, key: 'pending', native }), native };
}
