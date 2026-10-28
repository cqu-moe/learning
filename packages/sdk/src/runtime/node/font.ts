import { createHash } from 'node:crypto';
import { matchGlyph, type GlyphReference } from '../../content/font-match.js';
import type { DecodeResult } from '../../types/models.js';

// opentype.js 2.0.0 publishes JavaScript without its historical types package.
// @ts-expect-error no bundled declaration file
import * as opentype from 'opentype.js';

interface PathCommand {
  type: 'M' | 'L' | 'Q' | 'C' | 'Z';
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

interface OpenTypeFont {
  numGlyphs: number;
  tables?: {
    fvar?: { axes?: Array<{ tag: string; minValue: number; maxValue: number }> };
  };
  variation?: {
    getDefaultCoordinates(): Record<string, number>;
    getTransform(glyph: OpenTypeGlyph, coords: Record<string, number>): OpenTypeGlyph;
  };
  charToGlyphIndex(character: string): number;
  glyphs: { get(index: number): OpenTypeGlyph | undefined };
}

interface OpenTypeGlyph {
  index: number;
  path: { commands: PathCommand[] };
}

interface DecodeOptions {
  signal?: AbortSignal;
  deadlineAtMs?: number;
}

interface ReferenceIndex {
  glyphs: GlyphReference[];
}

const GRID = 16;
const CURVE_STEPS = 6;
const MAX_FONT_BYTES = 32 * 1024 * 1024;
const MAX_GLYPHS = 100_000;
const MAX_CHARACTERS = 4_096;
const MAX_REFERENCE_GLYPHS = 40_000;
const MAX_PATH_COMMANDS = 50_000;
const DEFAULT_DEADLINE_MS = 60_000;
const MAX_REFERENCE_CACHE = 4;
const REFERENCE_RANGES: Array<readonly [number, number]> = [
  [0x4e00, 0x9fff],
  [0x21, 0x7e],
  [0x3000, 0x303f],
  [0xff01, 0xff60],
];

const referenceCache = new Map<string, Promise<ReferenceIndex>>();

export async function decodeFont(
  fontBytes: Uint8Array,
  referenceBytes: Uint8Array,
  characters: string[],
  options?: DecodeOptions,
): Promise<DecodeResult> {
  const deadlineAtMs = options?.deadlineAtMs ?? Date.now() + DEFAULT_DEADLINE_MS;
  if (!Number.isFinite(deadlineAtMs)) throw new Error('font decode deadline must be finite');
  const budget: Budget = { deadlineAtMs, signal: options?.signal };
  checkBudget(budget);
  validateFontBytes(fontBytes);
  validateFontBytes(referenceBytes);
  if (!Array.isArray(characters) || characters.length > MAX_CHARACTERS) {
    throw new Error(`characters exceed budget: ${characters.length} > ${MAX_CHARACTERS}`);
  }
  for (const character of characters) {
    if (typeof character !== 'string' || [...character].length !== 1) {
      throw new Error('each font decode character must contain one Unicode scalar');
    }
  }

  const font = parseFont(fontBytes);
  if (font.numGlyphs > MAX_GLYPHS) throw new Error(`font glyph count exceeds budget: ${font.numGlyphs}`);
  const referenceSha256 = sha256(referenceBytes);
  let referencePromise = referenceCache.get(referenceSha256);
  if (referencePromise === undefined) {
    if (referenceCache.size >= MAX_REFERENCE_CACHE) {
      const oldest = referenceCache.keys().next().value;
      if (oldest !== undefined) referenceCache.delete(oldest);
    }
    referencePromise = buildReferenceIndex(referenceBytes, referenceSha256, budget);
    referenceCache.set(referenceSha256, referencePromise);
    referencePromise.catch(() => referenceCache.delete(referenceSha256));
  }
  const referenceIndex = await referencePromise;
  await yieldToEventLoop();
  checkBudget(budget);

  const mapping: DecodeResult['mapping'] = [];
  const unresolved: string[] = [];
  const unique = uniqueCharacters(characters);
  for (let index = 0; index < unique.length; index += 1) {
    if (index > 0 && index % 8 === 0) {
      await yieldToEventLoop();
      checkBudget(budget);
    }
    const character = unique[index];
    if (character === undefined) continue;
    checkBudget(budget);
    const glyphIndex = font.charToGlyphIndex(character);
    const glyph = glyphIndex > 0 ? font.glyphs.get(glyphIndex) : undefined;
    const vector = glyph === undefined ? null : rasterize(glyphCommands(font, glyph));
    const match = vector === null
      ? { state: 'unresolved' } as const
      : matchGlyph(vector, referenceIndex.glyphs);
    if (match.state === 'exact') {
      mapping.push({ from: character, to: match.char, score: match.score });
    } else {
      unresolved.push(character);
    }
  }

  return {
    mapping,
    unresolved,
    rendererVersion: `font-decode/1 opentype.js/2.0.0 raster/${GRID}x${GRID}`,
  };
}

async function buildReferenceIndex(
  referenceBytes: Uint8Array,
  referenceSha256: string,
  budget: Budget,
): Promise<ReferenceIndex> {
  const font = parseFont(referenceBytes);
  if (font.numGlyphs > MAX_GLYPHS) throw new Error(`reference font glyph count exceeds budget: ${font.numGlyphs}`);

  const glyphs: GlyphReference[] = [];
  for (const [start, end] of REFERENCE_RANGES) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      if (glyphs.length >= MAX_REFERENCE_GLYPHS) {
        throw new Error(`reference candidate glyph count exceeds budget: ${glyphs.length}`);
      }
      if ((codePoint - start) % 128 === 0) {
        checkBudget(budget);
        await yieldToEventLoop();
      }
      const character = String.fromCodePoint(codePoint);
      const glyphIndex = font.charToGlyphIndex(character);
      const glyph = glyphIndex > 0 ? font.glyphs.get(glyphIndex) : undefined;
      const vector = glyph === undefined ? null : rasterize(glyphCommands(font, glyph));
      if (vector !== null) glyphs.push({ char: character, vector });
    }
  }
  if (glyphs.length === 0) throw new Error('reference font has no rasterizable decode glyphs');

  return {
    glyphs,
  };
}

function parseFont(bytes: Uint8Array): OpenTypeFont {
  try {
    return opentype.parse(bytes) as OpenTypeFont;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`font parsing failed: ${message}`, { cause: error });
  }
}

function validateFontBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('font bytes must be non-empty');
  if (bytes.byteLength > MAX_FONT_BYTES) throw new Error(`font size exceeds budget: ${bytes.byteLength} > ${MAX_FONT_BYTES}`);
}

interface Budget {
  deadlineAtMs: number;
  signal?: AbortSignal | undefined;
}

function checkBudget(budget: Budget): void {
  if (budget.signal?.aborted) throw new Error('font decoding aborted');
  if (Date.now() >= budget.deadlineAtMs) throw new Error(`font decode deadline passed: ${budget.deadlineAtMs}`);
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function uniqueCharacters(characters: string[]): string[] {
  return [...new Set(characters)];
}

function glyphCommands(font: OpenTypeFont, glyph: OpenTypeGlyph): PathCommand[] {
  const commands = variationCommands(font, glyph) ?? glyph.path.commands;
  if (!Array.isArray(commands) || commands.length > MAX_PATH_COMMANDS) {
    throw new Error(`glyph path command count exceeds budget: ${commands?.length ?? 0} > ${MAX_PATH_COMMANDS}`);
  }
  return commands;
}

function variationCommands(font: OpenTypeFont, glyph: OpenTypeGlyph): PathCommand[] | undefined {
  if (font.variation === undefined) return undefined;
  const coordinates = { ...font.variation.getDefaultCoordinates() };
  const weightAxis = font.tables?.fvar?.axes?.find((axis) => axis.tag === 'wght');
  if (weightAxis !== undefined && weightAxis.minValue <= 400 && 400 <= weightAxis.maxValue) {
    coordinates.wght = 400;
  }
  return font.variation.getTransform(glyph, coordinates).path.commands;
}

type Point = readonly [number, number];

function rasterize(commands: PathCommand[]): number[] | null {
  const contours = flattenContours(commands);
  if (contours.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const contour of contours) {
    for (const [x, y] of contour) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const width = maxX - minX;
  const height = maxY - minY;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  const scale = (GRID - 1) / Math.max(width, height);
  const offsetX = (GRID - 1 - width * scale) / 2;
  const offsetY = (GRID - 1 - height * scale) / 2;
  const normalized = contours.map((contour) => contour.map(([x, y]): Point => [
    (x - minX) * scale + offsetX,
    (y - minY) * scale + offsetY,
  ]));
  const vector = new Array<number>(GRID * GRID).fill(0);

  for (let y = 0; y < GRID; y += 1) {
    const sampleY = y + 0.5;
    for (let x = 0; x < GRID; x += 1) {
      const sampleX = x + 0.5;
      let winding = 0;
      for (const contour of normalized) {
        for (let i = 0; i < contour.length - 1; i += 1) {
          const [x1, y1] = contour[i] ?? [0, 0];
          const [x2, y2] = contour[i + 1] ?? [0, 0];
          if ((y1 <= sampleY) === (y2 <= sampleY)) continue;
          const intersectionX = x1 + ((sampleY - y1) / (y2 - y1)) * (x2 - x1);
          if (intersectionX <= sampleX) winding += y2 > y1 ? 1 : -1;
        }
      }
      if (winding !== 0) vector[y * GRID + x] = 1;
    }
  }
  return vector;
}

function flattenContours(commands: PathCommand[]): Point[][] {
  const contours: Point[][] = [];
  let contour: Point[] = [];
  let current: Point | undefined;

  const move = (point: Point) => {
    if (contour.length > 0) contours.push(contour);
    contour = [point];
    current = point;
  };
  const line = (point: Point) => {
    if (current === undefined) return;
    contour.push(point);
    current = point;
  };
  const curve = (controls: Point[], end: Point) => {
    if (current === undefined) return;
    const [startX, startY] = current;
    for (let step = 1; step <= CURVE_STEPS; step += 1) {
      const t = step / CURVE_STEPS;
      const u = 1 - t;
      let x: number;
      let y: number;
      if (controls.length === 1) {
        const [cx, cy] = controls[0] ?? [0, 0];
        x = u * u * startX + 2 * u * t * cx + t * t * end[0];
        y = u * u * startY + 2 * u * t * cy + t * t * end[1];
      } else {
        const [c1x, c1y] = controls[0] ?? [0, 0];
        const [c2x, c2y] = controls[1] ?? [0, 0];
        x = u ** 3 * startX + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t ** 3 * end[0];
        y = u ** 3 * startY + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t ** 3 * end[1];
      }
      contour.push([x, y]);
    }
    current = end;
  };

  for (const command of commands) {
    if (command.type === 'M' && command.x !== undefined && command.y !== undefined) {
      move([command.x, command.y]);
    } else if (command.type === 'L' && command.x !== undefined && command.y !== undefined) {
      line([command.x, command.y]);
    } else if (command.type === 'Q' && command.x !== undefined && command.y !== undefined
      && command.x1 !== undefined && command.y1 !== undefined) {
      curve([[command.x1, command.y1]], [command.x, command.y]);
    } else if (command.type === 'C' && command.x !== undefined && command.y !== undefined
      && command.x1 !== undefined && command.y1 !== undefined
      && command.x2 !== undefined && command.y2 !== undefined) {
      curve([[command.x1, command.y1], [command.x2, command.y2]], [command.x, command.y]);
    } else if (command.type === 'Z' && contour.length > 0) {
      contour.push(contour[0] ?? [0, 0]);
      contours.push(contour);
      contour = [];
      current = undefined;
    }
  }
  if (contour.length > 0) {
    contour.push(contour[0] ?? [0, 0]);
    contours.push(contour);
  }
  return contours;
}
