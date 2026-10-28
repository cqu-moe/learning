import { parse } from 'parse5';
import type { Question, RichText } from '../types/models.js';
import { sha256Hex } from '../types/sha256.js';

const ENCRYPTED_CLASSES = new Set(['textfonts', 'xuetangx-com-encrypted-font']);
const SKIPPED_TAGS = new Set(['script', 'style', 'iframe']);
const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);

export function homeworkQuestionFingerprint(question: Pick<Question, 'id' | 'kind' | 'body' | 'options'>): string {
  return sha256Hex(JSON.stringify([question.id, question.kind, question.body.markdown, question.options.map(option => [option.key, option.body.markdown])]));
}

export interface NormalizeContentOptions {
  decoded?: ReadonlyMap<string, string>;
  images?: ReadonlyMap<string, string>;
}

interface ElementLike {
  tagName: string;
  attrs: Array<{ name: string; value: string }>;
  childNodes: unknown[];
}

interface TextNodeLike {
  value: string;
}

interface Accum {
  markdown: string[];
  plain: string[];
  encrypted: boolean;
  undecoded: boolean;
  missingImage: boolean;
  missingFormula: boolean;
}

function isElement(node: unknown): node is ElementLike {
  return typeof node === 'object' && node !== null && 'tagName' in node && 'attrs' in node && 'childNodes' in node;
}

function isTextNode(node: unknown): node is TextNodeLike {
  return typeof node === 'object' && node !== null && 'value' in node && typeof (node as { value: unknown }).value === 'string';
}

function attr(node: ElementLike, name: string): string | undefined {
  return node.attrs.find((item) => item.name === name)?.value;
}

function hasEncryptedClass(node: ElementLike): boolean {
  return (attr(node, 'class') ?? '').trim().split(/\s+/).some((token) => ENCRYPTED_CLASSES.has(token));
}

export function inspectHomeworkHtml(html: string): { characters: string[]; images: string[] } {
  const characters = new Set<string>();
  const images = new Set<string>();
  const stack: Array<{ nodes: unknown[]; index: number; encrypted: boolean }> = [
    { nodes: parse(html).childNodes, index: 0, encrypted: false },
  ];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame === undefined) {
      stack.pop();
      continue;
    }
    if (frame.index >= frame.nodes.length) {
      stack.pop();
      continue;
    }
    const node = frame.nodes[frame.index];
    frame.index += 1;

    if (isTextNode(node) && frame.encrypted) {
      for (const character of node.value) characters.add(character);
      continue;
    }
    if (!isElement(node)) continue;

    const tag = node.tagName.toLowerCase();
    if (SKIPPED_TAGS.has(tag)) continue;
    if (tag === 'img') {
      const src = attr(node, 'src');
      if (src !== undefined && src !== '') images.add(src);
    }
    stack.push({ nodes: node.childNodes, index: 0, encrypted: frame.encrypted || hasEncryptedClass(node) });
  }

  return { characters: [...characters], images: [...images] };
}

/** Converts untrusted HTML to Markdown without emitting executable HTML. */
export function normalizeContent(html: string, options: NormalizeContentOptions = {}): RichText {
  if (html === '') {
    return { markdown: '', plainText: '', decodeState: 'not-needed', sourceHash: sha256Hex('') };
  }

  const accum: Accum = { markdown: [], plain: [], encrypted: false, undecoded: false, missingImage: false, missingFormula: false };
  walk(parse(html).childNodes, accum, false, options);
  const markdown = accum.markdown
    .join('')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const plainText = accum.plain.join('').replace(/\s+/g, ' ').trim();
  const incomplete = accum.undecoded || accum.missingImage || accum.missingFormula;

  return {
    markdown,
    plainText,
    decodeState: incomplete ? 'partial' : accum.encrypted ? 'complete' : 'not-needed',
    sourceHash: sha256Hex(html),
  };
}

function walk(nodes: unknown[], accum: Accum, encrypted: boolean, options: NormalizeContentOptions): void {
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (isTextNode(node)) {
      appendText(node.value, encrypted, accum, options);
      continue;
    }
    if (!isElement(node)) continue;

    const tag = node.tagName.toLowerCase();
    if (SKIPPED_TAGS.has(tag)) continue;

    const latex = attr(node, 'data-latex') ?? attr(node, 'data-tex');
    if (latex !== undefined && latex.trim() !== '') {
      appendFormula(latex, accum);
      continue;
    }
    if (tag === 'math') {
      appendFormula(mathmlToLatex(node, accum), accum);
      if (accum.missingFormula) {
        accum.markdown.push('【公式未完整转换】');
        accum.plain.push('【公式未完整转换】');
      }
      continue;
    }

    const elementEncrypted = encrypted || hasEncryptedClass(node);
    if (BLOCK_TAGS.has(tag)) {
      accum.markdown.push('\n');
      walk(node.childNodes, accum, elementEncrypted, options);
      accum.markdown.push('\n');
      continue;
    }
    if (tag === 'sub' || tag === 'sup') {
      index = renderScriptSequence(nodes, index, accum, elementEncrypted, options);
      continue;
    }
    if (tag === 'img') {
      renderImage(node, accum, options);
      continue;
    }
    if (tag === 'strong' || tag === 'b') {
      accum.markdown.push('**');
      walk(node.childNodes, accum, elementEncrypted, options);
      accum.markdown.push('**');
      continue;
    }
    walk(node.childNodes, accum, elementEncrypted, options);
  }
}

function appendText(value: string, encrypted: boolean, accum: Accum, options: NormalizeContentOptions): void {
  if (!encrypted) {
    appendReadableText(value, accum);
    return;
  }

  const decoded: string[] = [];
  for (const character of value) {
    if (/\s/.test(character)) {
      decoded.push(character);
      continue;
    }
    accum.encrypted = true;
    const replacement = options.decoded?.get(character);
    if (replacement === undefined) {
      accum.undecoded = true;
      decoded.push('【未解码】');
    } else {
      decoded.push(replacement);
    }
  }
  const text = decoded.join('');
  appendReadableText(text, accum);
}

function appendReadableText(value: string, accum: Accum): void {
  const formulas = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<![\\$])\$([^$\n]+)\$|\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]/g;
  let offset = 0;
  for (const match of value.matchAll(formulas)) {
    const prefix = value.slice(offset, match.index);
    accum.markdown.push(escapeMarkdownText(prefix));
    accum.plain.push(prefix);
    appendFormula(match[1] ?? match[2] ?? match[3] ?? match[4]!, accum, match[1] !== undefined || match[4] !== undefined);
    offset = match.index + match[0].length;
  }
  accum.markdown.push(escapeMarkdownText(value.slice(offset)));
  accum.plain.push(value.slice(offset));
}

function renderScriptSequence(
  nodes: unknown[],
  start: number,
  accum: Accum,
  encrypted: boolean,
  options: NormalizeContentOptions,
): number {
  const subs: string[] = [];
  const sups: string[] = [];
  let cursor = start;

  while (cursor < nodes.length) {
    const current = nodes[cursor];
    if (!isElement(current)) break;
    const tag = current.tagName.toLowerCase();
    if (tag !== 'sub' && tag !== 'sup') break;

    const holder: Accum = { markdown: [], plain: [], encrypted: false, undecoded: false, missingImage: false, missingFormula: false };
    walk(current.childNodes, holder, encrypted, options);
    mergeStatus(accum, holder);
    const body = holder.plain.join('').trim();
    if (body !== '') (tag === 'sub' ? subs : sups).push(body);
    cursor += 1;
  }

  if (subs.length > 0 || sups.length > 0) {
    const lastChunk = accum.markdown[accum.markdown.length - 1] ?? '';
    const baseMatch = /[A-Za-z0-9.+\-×·/=\\]*$/.exec(lastChunk);
    const base = baseMatch?.slice(-1)[0] === '\\' ? '' : (baseMatch?.[0] ?? '');
    if (base !== '') accum.markdown[accum.markdown.length - 1] = lastChunk.slice(0, lastChunk.length - base.length);
    let token = base;
    if (subs.length > 0) token += `_{${subs.join('')}}`;
    if (sups.length > 0) token += `^{${sups.join('')}}`;
    accum.markdown.push(`$${token}$`);
    accum.plain.push(subs.join('') + sups.join(''));
  }
  return cursor - 1;
}

function mergeStatus(target: Accum, source: Accum): void {
  target.encrypted ||= source.encrypted;
  target.undecoded ||= source.undecoded;
  target.missingImage ||= source.missingImage;
  target.missingFormula ||= source.missingFormula;
}

function renderImage(node: ElementLike, accum: Accum, options: NormalizeContentOptions): void {
  const alt = (attr(node, 'alt') ?? 'image').replace(/\s+/g, ' ').trim() || 'image';
  const src = attr(node, 'src') ?? '';
  const mapped = options.images === undefined ? undefined : safeLocalPath(options.images.get(src));

  if (options.images === undefined || mapped === undefined) {
    accum.missingImage ||= options.images !== undefined;
    accum.markdown.push(`![${escapeMarkdownText(alt)}]${options.images === undefined ? '' : '[缺图]'}`);
  } else {
    const title = attr(node, 'title')?.replace(/\s+/g, ' ').trim();
    const destination = mapped.replace(/([\\()\s])/g, '\\$1');
    accum.markdown.push(
      `![${escapeMarkdownText(alt)}](${destination}${title === undefined || title === '' ? '' : ` "${escapeMarkdownTitle(title)}"`})`,
    );
  }
  accum.plain.push(` ${alt} `);
}

function safeLocalPath(path: string | undefined): string | undefined {
  if (path === undefined || path === '' || hasControlCharacter(path)) return undefined;
  if (path.startsWith('/') || path.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
  if (/(?:javascript|vbscript|data):/i.test(path)) return undefined;
  if (path.includes('\\') || path.split('/').some((segment) => segment === '.' || segment === '..')) return undefined;
  return path;
}

function appendFormula(latex: string, accum: Accum, display = false): void {
  let sanitized = '';
  for (const character of latex) sanitized += hasControlCharacter(character) ? ' ' : character;
  const formula = sanitized.replace(/</g, '\\<').trim();
  if (formula === '') return;
  const delimiter = display ? '$$' : '$';
  accum.markdown.push(`${delimiter}${formula}${delimiter}`);
  accum.plain.push(formula);
}

function hasControlCharacter(text: string): boolean {
  return [...text].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

function mathmlToLatex(node: ElementLike, accum: Accum): string {
  const children = node.childNodes.filter(isElement).map((child) => mathmlNode(child, accum)).filter((part) => part !== '');
  return children.join(' ');
}

function mathmlNode(node: ElementLike, accum: Accum): string {
  const tag = node.tagName.toLowerCase();
  const children = node.childNodes.filter(isElement);
  if (tag === 'annotation' || tag === 'annotation-xml') return '';
  if (tag === 'semantics') {
    const presentation = children.find(child => !child.tagName.startsWith('annotation'));
    return presentation === undefined ? '' : mathmlNode(presentation, accum);
  }
  const parts = children.map(child => mathmlNode(child, accum));
  if (tag === 'mrow' || tag === 'mstyle') return parts.join('');
  if (tag === 'mfrac') {
    if (parts.length !== 2) accum.missingFormula = true;
    return parts.length >= 2 ? `\\frac{${parts[0]}}{${parts[1]}}` : parts.join('');
  }
  if (tag === 'msqrt') return `\\sqrt{${parts.join('')}}`;
  if (tag === 'msub' || tag === 'msup' || tag === 'msubsup') {
    if (parts.length !== (tag === 'msubsup' ? 3 : 2)) accum.missingFormula = true;
    if (parts.length === 0) return '';
    if (tag === 'msub') return parts[0] + (parts[1] !== undefined ? `_{${parts[1]}}` : '');
    if (tag === 'msup') return parts[0] + (parts[1] !== undefined ? `^{${parts[1]}}` : '');
    return parts[0] + (parts[1] !== undefined ? `_{${parts[1]}}` : '') + (parts[2] !== undefined ? `^{${parts[2]}}` : '');
  }
  // shortcut: unknown MathML keeps its symbols but blocks submission until a verified conversion is added.
  if (!['mi', 'mn', 'mo', 'mtext', 'ms', 'mspace'].includes(tag)) accum.missingFormula = true;
  return node.childNodes.filter(isTextNode).map((child) => child.value.trim()).join('') + parts.join(' ');
}

function escapeMarkdownText(text: string): string {
  return text.replace(/([\\<>[\]])/g, '\\$1');
}

function escapeMarkdownTitle(text: string): string {
  return escapeMarkdownText(text).replace(/"/g, '\\"');
}
