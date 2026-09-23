import { LearningError } from '../../types/errors.js';
import type { Course, Outline, OutlineNode, Resource, ResourceKind } from '../../types/models.js';
import type { Page } from '../../types/errors.js';
import type { CourseRef, Scope } from '../../types/refs.js';
import { keyOfCourse, keyOfResource } from '../../types/refs.js';
import type { SessionHttp } from '../../http/client.js';
import { XTX_BASE, XTX_BASE_HEADERS } from './schemas.js';

interface ProductWire {
  classroom_id?: number;
  course_sign?: string;
  name?: string;
  sku_id?: number;
}

export function parseXtxCourseList(payload: unknown, scope: Scope): { items: Course[]; completeness: 'complete' | 'unknown' } {
  const body = (payload ?? {}) as { success?: boolean; msg?: string; data?: { product_list?: ProductWire[] } };
  if (body.success === false) {
    throw new LearningError({ code: 'PROTOCOL', message: `user-courses failed: ${body.msg ?? 'success=false'}`, retryAfterMs: null, operationId: null });
  }
  const products = body.data?.product_list ?? [];
  const items = products.map((product) => {
    if (typeof product.classroom_id !== 'number' || typeof product.course_sign !== 'string' || typeof product.sku_id !== 'number') {
      throw new LearningError({ code: 'PROTOCOL', message: 'course product missing classroom_id/course_sign/sku_id; refusing to coerce 0', retryAfterMs: null, operationId: null });
    }
    const native = { kind: 'xuetang' as const, classroomId: String(product.classroom_id), courseSign: product.course_sign, skuId: String(product.sku_id) };
    return {
      ref: { scope, key: keyOfCourse({ scope, key: 'pending', native }), native },
      title: product.name ?? String(product.classroom_id),
      system: 'xuetang',
      term: null,
      teachers: [],
      locked: null,
    } satisfies Course;
  });
  // E02: only the first page is documented; a non-empty page cannot prove completeness.
  return { items, completeness: items.length > 0 ? 'unknown' : 'complete' };
}

interface XtxLeafWire { id?: number; leafinfo_id?: number; name?: string; leaf_type?: number; order?: number; is_locked?: boolean }
interface XtxChapterWire { id?: number; name?: string; leaf_list?: XtxLeafWire[]; children?: XtxChapterWire[] }

export interface FlatXtxLeaf {
  leafId: string;
  leafInfoId: string | null;
  name: string;
  leafType: number | null;
  order: number;
  locked: boolean | null;
  path: string[];
}

export function parseXtxChapterTree(payload: unknown): { chapters: { id: string; name: string; leaves: FlatXtxLeaf[] }[] } {
  const body = (payload ?? {}) as { success?: boolean; msg?: string; data?: { course_chapter?: XtxChapterWire } };
  if (body.success === false) {
    throw new LearningError({ code: 'PROTOCOL', message: `kg_learn_chapter failed: ${body.msg ?? 'success=false'}`, retryAfterMs: null, operationId: null });
  }
  const chapters: { id: string; name: string; leaves: FlatXtxLeaf[] }[] = [];
  const walk = (node: XtxChapterWire, path: string[], isRoot: boolean): void => {
    const name = node.name ?? '';
    const leaves = node.leaf_list ?? [];
    if (!(isRoot && leaves.length === 0 && (node.children ?? []).length > 0)) {
      chapters.push({
        id: String(node.id ?? 0),
        name,
        leaves: leaves.map((leaf) => {
          if (leaf.id === undefined) {
            throw new LearningError({ code: 'PROTOCOL', message: 'xtx leaf missing id', retryAfterMs: null, operationId: null });
          }
          return {
            leafId: String(leaf.id),
            leafInfoId: leaf.leafinfo_id !== undefined && leaf.leafinfo_id !== 0 ? String(leaf.leafinfo_id) : null,
            name: leaf.name ?? '',
            leafType: leaf.leaf_type ?? null,
            order: leaf.order ?? 0,
            locked: typeof leaf.is_locked === 'boolean' ? leaf.is_locked : null,
            path,
          };
        }),
      });
    }
    for (const child of node.children ?? []) walk(child, [...path, child.name ?? ''], false);
  };
  const root = body.data?.course_chapter;
  if (root !== undefined) walk(root, [], true);
  return { chapters };
}

function leafKind(leafType: number | null | undefined): ResourceKind {
  switch (leafType) {
    case 0: return 'video';
    case 6: return 'homework';
    case 3: return 'document';
    case 5: return 'exam';
    default: return 'unknown';
  }
}

export async function xtxCourses(http: SessionHttp, scope: Scope): Promise<Page<Course>> {
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${XTX_BASE}/api/v1/lms/user/user-courses/?status=1&page=1`,
    headers: XTX_BASE_HEADERS,
  });
  const parsed = parseXtxCourseList(await response.json(), scope);
  return { items: parsed.items, nextCursor: null, completeness: parsed.completeness, warnings: [] };
}

export async function xtxOutline(http: SessionHttp, ref: CourseRef): Promise<{ value: Outline; warnings: [] }> {
  if (ref.native.kind !== 'xuetang') {
    throw new LearningError({ code: 'INVALID_INPUT', message: 'xtx outline requires an xuetang course ref', retryAfterMs: null, operationId: null });
  }
  const response = await http.request({
    kind: 'read',
    method: 'GET',
    url: `${XTX_BASE}/api/v1/lms/kg/kg_learn_chapter/?cid=${ref.native.classroomId}&sign=${ref.native.courseSign}`,
    headers: XTX_BASE_HEADERS,
  });
  const payload = (await response.json()) as { success?: boolean; msg?: string; data?: { course_chapter?: XtxChapterWire } };
  if (payload.success === false) {
    throw new LearningError({ code: 'PROTOCOL', message: `kg_learn_chapter failed: ${payload.msg ?? 'success=false'}`, retryAfterMs: null, operationId: null });
  }
  let counter = 0;
  const buildNode = (node: XtxChapterWire, path: string[]): OutlineNode => {
    const leaves = node.leaf_list ?? [];
    const childResults: OutlineNode[] = [];
    for (const child of node.children ?? []) {
      childResults.push(buildNode(child, [...path, node.name ?? '']));
    }
    counter += 1;
    return {
      id: `ch:${counter}:${node.id ?? 0}`,
      title: node.name ?? '',
      children: childResults,
      resources: leaves.map((leaf) => {
        if (leaf.id === undefined) {
          throw new LearningError({ code: 'PROTOCOL', message: 'xtx leaf missing id', retryAfterMs: null, operationId: null });
        }
        return {
      ref: {
        course: ref,
          key: keyOfResource({
            course: ref,
            key: 'pending',
            native: { kind: 'xuetang', leafId: String(leaf.id), leafInfoId: leaf.leafinfo_id !== undefined && leaf.leafinfo_id !== 0 ? String(leaf.leafinfo_id) : null },
          }),
          native: { kind: 'xuetang' as const, leafId: String(leaf.id), leafInfoId: leaf.leafinfo_id !== undefined && leaf.leafinfo_id !== 0 ? String(leaf.leafinfo_id) : null },
      },
          title: leaf.name ?? '',
          kind: leafKind(leaf.leaf_type),
          path: [...path, node.name ?? ''],
          order: leaf.order ?? 0,
          durationSeconds: null,
          locked: typeof leaf.is_locked === 'boolean' ? leaf.is_locked : null,
        } satisfies Resource;
      }),
    };
  };
  const rootWire = payload.data?.course_chapter;
  const roots: OutlineNode[] = [];
  if (rootWire !== undefined) {
    const rootNode = buildNode(rootWire, []);
    roots.push({ ...rootNode, children: [] });
    for (const child of rootWire.children ?? []) roots.push(buildNode(child, []));
  }
  return { value: { course: ref, roots, completeness: 'complete' }, warnings: [] };
}
