import { parse } from 'parse5';
import type { RichText } from '../types/models.js';
import { sha256Hex } from '../types/sha256.js';

const ENC_MARKER = 'textfonts';

interface TextNodeLike { value: string }

function isElement(node: unknown): node is { tagName: string; attrs: Array<{ name: string; value: string }>; childNodes: unknown[] } {
  return typeof node === 'object' && node !== null && 'tagName' in node && 'attrs' in node;
}

function isTextNode(node: unknown): node is TextNodeLike {
  return typeof node === 'object' && node !== null && 'value' in node && typeof (node as { value: unknown }).value === 'string';
}

interface Accum {
  markdown: string[];
  plain: string[];
  fontLocked: boolean;
}

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

/** Script/handler/javascript-link stripping HTML → Markdown+plainText (A121). */
export function normalizeContent(html: string): RichText {
  if (html === '') {
    return { markdown: '', plainText: '', decodeState: 'not-needed', sourceHash: sha256Hex('') };
  }
  const document = parse(html);
  const accum: Accum = { markdown: [], plain: [], fontLocked: false };
  walk(document.childNodes, accum, { inSubSup: false });
  const markdown = accum.markdown.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const plainText = accum.plain.join('').replace(/\s+/g, ' ').trim();
  return {
    markdown,
    plainText,
    decodeState: accum.fontLocked ? 'partial' : 'not-needed',
    sourceHash: sha256Hex(html),
  };
}

function attr(node: { attrs: Array<{ name: string; value: string }> }, name: string): string | undefined {
  return node.attrs.find((a) => a.name === name)?.value;
}

function walk(nodes: unknown[], accum: Accum, state: { inSubSup: boolean }): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (isTextNode(node)) {
      const text = decodeEntities(node.value);
      accum.markdown.push(text);
      accum.plain.push(text);
      continue;
    }
    if (!isElement(node)) continue;
    const tag = node.tagName.toLowerCase();
    const classAttr = attr(node, 'class') ?? '';
    if (tag === 'script' || tag === 'style' || tag === 'iframe') continue;
    if (classAttr.includes(ENC_MARKER)) {
      accum.fontLocked = true;
      continue; // encrypted glyphs stay out until decoded (T24)
    }
    if (BLOCK_TAGS.has(tag)) {
      accum.markdown.push('\n');
      walk(node.childNodes, accum, state);
      accum.markdown.push('\n');
      continue;
    }
    if (tag === 'sub' || tag === 'sup') {
      const subs: string[] = [];
      const sups: string[] = [];
      const plainParts: string[] = [];
      let cursor = index;
      while (cursor < nodes.length) {
        const current = nodes[cursor];
        if (!isElement(current)) break;
        const currentTag = current.tagName.toLowerCase();
        if (currentTag !== 'sub' && currentTag !== 'sup') break;
        const inner: string[] = [];
        const holder: Accum = { markdown: inner, plain: [], fontLocked: false };
        walk(current.childNodes, holder, { inSubSup: true });
        const body = inner.join('').trim();
        if (body !== '') {
          (currentTag === 'sub' ? subs : sups).push(body);
          plainParts.push(body);
        }
        cursor += 1;
      }
      index = cursor - 1;
      if (subs.length > 0 || sups.length > 0) {
        const lastChunk = accum.markdown[accum.markdown.length - 1] ?? '';
        const baseMatch = /[A-Za-z0-9.+\-×·/=]*$/.exec(lastChunk);
        const base = baseMatch !== null && baseMatch[0] !== '' ? baseMatch[0] : '';
        if (base !== '') accum.markdown[accum.markdown.length - 1] = lastChunk.slice(0, lastChunk.length - base.length);
        let token = base;
        if (subs.length > 0) token += `_{${subs.join('')}}`;
        if (sups.length > 0) token += `^{${sups.join('')}}`;
        accum.markdown.push(`$${token}$`);
        accum.plain.push(base + plainParts.join(''));
      }
      continue;
    }
    if (tag === 'img') {
      const alt = attr(node, 'alt') ?? 'image';
      accum.markdown.push(`![${alt}]`);
      accum.plain.push(alt);
      continue;
    }
    if (tag === 'a') {
      const href = attr(node, 'href') ?? '';
      if (/^\s*javascript:/i.test(href)) {
        walk(node.childNodes, accum, state);
        continue;
      }
      walk(node.childNodes, accum, state);
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      accum.markdown.push('**');
      walk(node.childNodes, accum, state);
      accum.markdown.push('**');
      continue;
    }
    walk(node.childNodes, accum, state);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&([a-z0-9]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole);
}
