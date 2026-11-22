// Faster Site Builder — a fast drop-in for makefun-site 1.0.0.
//
// run(input) returns exactly what makefun-site 1.0.0's build returns for the same input: the output tree
// (every path it writes and that file's text, byte for byte). Written from the spec in makefun-site's README
// (front matter, template dialect, Markdown subset, slug rule, report) with its code as the reference wherever
// the two differ. Dependency-free, one ES module.
//
// Speed comes from doing the same work with less of it: a single-pass Markdown renderer that writes straight
// into shared output buffers (no token array, no per-line regexes), inline rendering over string ranges
// (no substring copies for strong/emphasis/link spans), cached slug and long-date formatting, an
// allocation-light template engine, and reading-minutes computed once per source.

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The HTML escape table: & < > " ' and nothing else. */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * A slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9
 * one "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing
 * is left. Results are cached per build: titles and tag names repeat, and NFKD normalisation is the dear part.
 */
function makeSlugify() {
  const cache = new Map();
  return function slugify(text) {
    const hit = cache.get(text);
    if (hit !== undefined) return hit;
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let out = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
    out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
    cache.set(text, out);
    return out;
  };
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". Cached per build. */
function makeLongDate() {
  const cache = new Map();
  return function longDate(date) {
    let v = cache.get(date);
    if (v === undefined) {
      const [y, m, d] = date.split('-');
      v = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
      cache.set(date, v);
    }
    return v;
  };
}

/** The words of a body: its runs of characters other than whitespace. The native regex wins here: a
 * hand-rolled loop over the same text measured slower than irregexp's /\S+/g. */
function wordsOf(text) {
  const m = text.match(/\S+/g);
  return m === null ? 0 : m.length;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused.
 * `text` has "\n" line ends. Only the front-matter region is split; the body is sliced, never re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let j = text.indexOf('\n---', 3);
  let after = -1;
  while (j !== -1) {
    after = j + 4;
    if (after === text.length || text.charCodeAt(after) === 10) break;
    j = text.indexOf('\n---', j + 1);
    after = -1;
  }
  if (j === -1) return { error: 'the front matter is not closed' };
  const fmText = text.slice(4, j);
  const body = after === text.length ? '' : text.slice(after + 1);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (isBlank(line) || line.charCodeAt(0) === 35) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${li + 2} is not "key: value"` };
    let okKey = true;
    for (let k = 0; k < colon; k++) {
      const cc = line.charCodeAt(k);
      if (!((cc >= 97 && cc <= 122) || cc === 95)) { okKey = false; break; }
    }
    if (!okKey) return { error: `line ${li + 2} is not "key: value"` };
    const key = line.slice(0, colon);
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
    else return { error: `line ${li + 2} is not "key: value"` };
    raw = raw.replace(/[ \t]+$/, '');
    if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

/** A line trimmed of spaces and tabs at both ends; the line itself when nothing is trimmed. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence opening line: its language, or null. Three backticks, an optional language, spaces/tabs only. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  const start = i;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    i++;
  }
  const lang = line.slice(start, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** A fence closing line: three backticks, spaces or tabs after them. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty; 7+ '#' is not a heading). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  const text = trimLine(line.slice(n + 1));
  if (text === '') return null;
  return { depth: n, text };
}

/** A thematic break: `---` or `***`, then spaces or tabs only. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet list item line: its text, or null. `- ` or `* ` then the item. */
function bulletOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { text: line.slice(2) };
  return null;
}

/** An ordered list item line: its start number and text, or null. 1-9 digits, `. `, then the item. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i === 0 || i > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
function isContinued(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i < 2 || i >= line.length) return false;
  return !/\s/.test(line[i]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/** The characters a backslash escapes, by code: \ ` * _ [ ] ( ) # + - . ! > */
const ESCAPABLE_CODE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE_CODE[c] = 1;

/** The HTML entity for an escapable character code, or undefined when the character is written as-is. */
function entityFor(code) {
  switch (code) {
    case 38: return '&amp;';
    case 60: return '&lt;';
    case 62: return '&gt;';
    case 34: return '&quot;';
    case 39: return '&#39;';
    default: return undefined;
  }
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from, end) {
  const wlen = what.length;
  for (let j = from; j <= end - wlen; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < end && ESCAPABLE_CODE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < end && ESCAPABLE_CODE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline, appended to `out`; `env.link(target)` is a link's href. Plain runs are pushed as
 * whole slices, so a paragraph with no markup costs one slice, not one push per character. The scan runs on
 * character codes, not one-character strings: indexing a string allocates, `charCodeAt` does not.
 */
function inlineRange(s, a, b, env, out) {
  let i = a;
  let run = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < b && ESCAPABLE_CODE[s.charCodeAt(i + 1)] === 1) {
        if (i > run) out.push(s.slice(run, i));
        const n = s.charCodeAt(i + 1);
        const e = entityFor(n);
        out.push(e === undefined ? s[i + 1] : e);
        i += 2;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2, b);
        if (j > i + 2) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<strong>');
          inlineRange(s, i + 2, j, env, out);
          out.push('</strong>');
          i = j + 2;
          run = i;
          continue;
        }
        i += 2;
        continue;
      }
      const j = findSingleStar(s, i + 1, b);
      if (j > i + 1) {
        if (i > run) out.push(s.slice(run, i));
        out.push('<em>');
        inlineRange(s, i + 1, j, env, out);
        out.push('</em>');
        i = j + 1;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1, b);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) {
        m = s.indexOf(')', k + 2);
        if (m >= b) m = -1;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !/\s/.test(target)) {
          if (i > run) out.push(s.slice(run, i));
          out.push('<a href="', escapeHtml(env.link(target)), '">');
          inlineRange(s, i + 1, k, env, out);
          out.push('</a>');
          i = m + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) {
      if (i > run) out.push(s.slice(run, i));
      out.push(entityFor(c));
      i++;
      run = i;
      continue;
    }
    i++;
  }
  if (b > run) out.push(s.slice(run, b));
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n" after the last), its table of
 * contents (every level 2 and 3 heading: level, id and its inline HTML) and its excerpt (the first
 * paragraph's inline HTML, or ""). Blocks are rendered as they are lexed, never tokenised first, and every
 * block's inline HTML is written straight into the one shared output buffer — only a heading's toc entry
 * and the first paragraph's excerpt are sliced out of it.
 */
function makeRenderMarkdown(slugify) {
  return function renderMarkdown(src, env) {
    const lines = src.split('\n');
    const n = lines.length;
    const ids = new Set();
    const out = [];
    const toc = [];
    let excerpt = null;
    let i = 0;
    while (i < n) {
      const line = lines[i];
      if (isBlank(line)) {
        i++;
        continue;
      }
      const fence = fenceOpen(line);
      if (fence !== null) {
        i++;
        out.push('<pre><code');
        if (fence !== '') out.push(' class="language-', escapeHtml(fence), '"');
        out.push('>');
        while (i < n && !fenceClose(lines[i])) {
          out.push(escapeHtml(lines[i]), '\n');
          i++;
        }
        i++;
        out.push('</code></pre>', '\n');
        continue;
      }
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text), ids);
        out.push(`<h${heading.depth} id="${id}">`);
        const start = out.length;
        inlineRange(heading.text, 0, heading.text.length, env, out);
        const html = out.slice(start).join('');
        out.push(`</h${heading.depth}>`, '\n');
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
      if (isHr(line)) {
        out.push('<hr>', '\n');
        i++;
        continue;
      }
      if (line.charCodeAt(0) === 62) {
        const raw = [];
        while (i < n && lines[i].charCodeAt(0) === 62) {
          const l = lines[i++];
          raw.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
        }
        const parts = [];
        for (let k = 0; k < raw.length; k++) {
          const t = trimLine(raw[k]);
          if (t !== '') parts.push(t);
        }
        if (parts.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
        else {
          const text = parts.length === 1 ? parts[0] : parts.join('\n');
          out.push('<blockquote>\n<p>');
          inlineRange(text, 0, text.length, env, out);
          out.push('</p>\n</blockquote>', '\n');
        }
        continue;
      }
      const bullet = bulletOf(line);
      const ordered = bullet === null ? orderedOf(line) : null;
      if (bullet !== null || ordered !== null) {
        const isOrdered = ordered !== null;
        const start = isOrdered ? ordered.start : 1;
        const items = [];
        while (i < n) {
          const m = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
          } else if (isContinued(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        out.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
        for (let k = 0; k < items.length; k++) {
          const parts = items[k];
          const text = parts.length === 1 ? parts[0] : parts.join('\n');
          out.push('<li>');
          inlineRange(text, 0, text.length, env, out);
          out.push('</li>\n');
        }
        out.push(`</${tag}>`, '\n');
        continue;
      }
      const body = [trimLine(line)];
      i++;
      while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
      const text = body.length === 1 ? body[0] : body.join('\n');
      out.push('<p>');
      const start = out.length;
      inlineRange(text, 0, text.length, env, out);
      if (excerpt === null) excerpt = out.slice(start).join('');
      out.push('</p>', '\n');
    }
    return { html: out.join(''), toc, excerpt: excerpt ?? '' };
  };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. `ctx` holds the parsed templates
 * (`templates`, a Map of name to nodes, a template that did not parse absent), the HTML escape, the
 * include depth, and the render-once cache (`info`, `cache`, `globals`, below). Appending to one shared
 * buffer keeps a page's render to a single join. `clean` is true while no scope in the chain binds one of
 * the globals (a loop variable named `site`, `tags` or `recent` would shadow it).
 */
function renderNodes(nodes, scope, ctx, depth, out, clean) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(ctx.escape(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out, clean);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const childClean = clean && !GLOBALS.has(n.name);
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out, childClean);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const inf = ctx.info.get(n.name);
        if (inf !== undefined && inf.cacheable && clean && depth + inf.maxDepth <= 7) {
          out.push(cachedRender(n.name, ctx));
        } else {
          renderNodes(t, scope, ctx, depth + 1, out, clean);
        }
        break;
      }
    }
  }
}

/** The names every template may read from the build alone: the render-once cache's key. */
const GLOBALS = new Set(['site', 'tags', 'recent']);

/**
 * One template's render, as the build alone determines it, computed once and kept: a template whose free
 * names are all globals renders the same for every page, so it is rendered once from the globals and the
 * string reused. `maxDepth` is the template's deepest include nesting plus one (0 when it includes
 * nothing, Infinity when an include cycle is reachable); the cache is used at depth `d` only while
 * `d + maxDepth <= 7`, which is exactly when the include-depth cutoff would bite the same way in the
 * cached render (computed at depth 0) and in the real one.
 */
function cachedRender(name, ctx) {
  let s = ctx.cache.get(name);
  if (s === undefined) {
    const buf = [];
    renderNodes(ctx.templates.get(name), { vars: ctx.globals, parent: null }, ctx, 0, buf, true);
    s = buf.join('');
    ctx.cache.set(name, s);
  }
  return s;
}

/**
 * For every parsed template: the names it reads from its enclosing scope (its free names, through its
 * includes, minus the names its own `for` loops bind) and its deepest include nesting. A template is
 * cacheable when its free names are all globals and its include nesting is finite.
 */
function analyzeTemplates(templates) {
  const info = new Map();
  const visiting = new Set();
  function analyze(name) {
    const done = info.get(name);
    if (done !== undefined) return done;
    if (visiting.has(name)) return { free: new Set(), maxDepth: Infinity, cacheable: false };
    visiting.add(name);
    const nodes = templates.get(name);
    const free = new Set();
    let maxDepth = 0;
    const walk = (ns, bound) => {
      for (const n of ns) {
        if (n.kind === 'var' || n.kind === 'raw') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
        } else if (n.kind === 'if') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          walk(n.then, bound);
          if (n.else !== null) walk(n.else, bound);
        } else if (n.kind === 'for') {
          if (!bound.has(n.path[0])) free.add(n.path[0]);
          const b2 = new Set(bound);
          b2.add(n.name);
          b2.add('loop');
          walk(n.body, b2);
        } else if (n.kind === 'include') {
          const sub = templates.get(n.name);
          if (sub !== undefined) {
            const subInfo = analyze(n.name);
            for (const x of subInfo.free) if (!bound.has(x)) free.add(x);
            if (subInfo.maxDepth === Infinity) maxDepth = Infinity;
            else if (maxDepth !== Infinity) maxDepth = Math.max(maxDepth, 1 + subInfo.maxDepth);
          }
        }
      }
    };
    if (nodes !== undefined) walk(nodes, new Set());
    visiting.delete(name);
    const result = { free, maxDepth, cacheable: maxDepth !== Infinity && [...free].every((x) => GLOBALS.has(x)) };
    info.set(name, result);
    return result;
  }
  for (const name of templates.keys()) analyze(name);
  return info;
}

// ---------------------------------------------------------------- the build

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** One site's output tree: path -> text. makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  const slugify = makeSlugify();
  const longDate = makeLongDate();
  const renderMarkdown = makeRenderMarkdown(slugify);

  // 2. Templates, parsed in code-unit order of name; one that does not parse is reported and left out.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft. The checks run in order and
  // the first one that fails is the one reported.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // Permalinks: a post's directory is `posts/`; a page's is its source's directory. Its slug is its `slug`
  // key, or the slug of its title, made unique in its directory in source order.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // Markdown: each body's Markdown, its links resolved to the pages and static files they name.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // Collections: the posts, newest date first, and equal dates by slug in code-unit order.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count then slug.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        out.push(name);
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (s.post) continue;
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  /** A page's link record as templates read it. */
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

  /** A post's card, as lists show it. Reading minutes are computed once per source. */
  const cardOf = (s) => {
    if (s._rm === undefined) s._rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    return {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: s._rm,
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
  };

  /** A page as its layout reads it. */
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  /** A tag as templates read it (its posts as cards). */
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

  // Layouts: every page through its layout, the index pages and the tag pages through theirs, then statics.
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
    const ctx = { templates: b.templates, escape: escapeHtml, info: analyzeTemplates(b.templates), cache: new Map(), globals: { site, tags: allTags, recent } };
    const render = (name, vars) => {
      const nodes = b.templates.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out, true);
      return out.join('');
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: tagOf(t) });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}
