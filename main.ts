// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), finds the lines each edit names at the first
// of three matching tiers, and changes every file or none, exactly as the
// written specification SPEC.md (version 1) says.
//
// Node 22 and its standard library alone. Deterministic: the same check gives
// the same exit code, stdout and files every run.

import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

type Brk = '\n' | '\r\n';

interface FileState {
  lines: string[];
  brk: Brk;
  eol: boolean;
}

interface EditFailure {
  code: string;
  path: string;
}

type EditFn = (tree: Tree, strict: boolean) => EditFailure | null;

interface Edit {
  apply: EditFn;
}

interface Tree {
  state(path: string): FileState | null;
  exists(path: string): boolean;
  set(path: string, fs: FileState | null): void;
  initialBytes(path: string): string | null;
  finalBytes(path: string): string | null;
  touchedPaths(): string[];
  moves: { old: string; new: string }[];
}

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

// ---------------------------------------------------------------------------
// Text and lines (SPEC section 3)
// ---------------------------------------------------------------------------

function parseText(text: string): FileState {
  if (text.length === 0) return { lines: [], brk: '\n', eol: false };
  const lf = text.indexOf('\n');
  const brk: Brk = lf > 0 && text[lf - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(brk);
  let eol = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    eol = true;
  }
  return { lines: parts, brk, eol };
}

function serializeText(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.brk) + (f.eol ? f.brk : '');
}

function cloneState(f: FileState): FileState {
  return { lines: [...f.lines], brk: f.brk, eol: f.eol };
}

// A patch's lines: split at \n, one trailing \r removed from each, without
// the empty piece after a final \n.
function splitPatchLines(text: string): string[] {
  const raw = text.split('\n');
  if (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return raw.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function rstripWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripWs(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function isBlank(s: string): boolean {
  return s.trim() === '';
}

// ---------------------------------------------------------------------------
// Paths (SPEC section 3)
// ---------------------------------------------------------------------------

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Matching lines (SPEC section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstripWs(a) === rstripWs(b);
  return stripWs(a) === stripWs(b);
}

function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j], o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, 1, 2) at which O occurs at least once, with every
// occurrence at that tier. With strict only tier 0 is tried.
function findTier(lines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier++) {
    const pos = occurrences(lines, o, tier, from);
    if (pos.length > 0) return { tier, pos };
  }
  return null;
}

interface OLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

interface NLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

// Build the lines that replace a matched block. A context line is written as
// the file's own matched line, never the patch's. At tier 2 every other line
// of N is re-indented from the old block's first line to the file's.
function buildReplacement(n: NLine[], fileLines: string[], start: number, tier: number, oFirst: string): string[] {
  const out: string[] = [];
  const f = leadingWs(fileLines[start]);
  const p = leadingWs(oFirst);
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[start + nl.oIdx]);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && /[^ \t]/.test(t) && t.startsWith(p)) {
      t = f + t.slice(p.length);
    }
    out.push(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The working tree: the files as earlier edits left them, against the disk
// ---------------------------------------------------------------------------

function makeTree(): Tree {
  const cur = new Map<string, FileState | null>();
  const orig = new Map<string, string | null>();
  const moves: { old: string; new: string }[] = [];

  function loadDisk(path: string): string | null {
    try {
      const st = statSync(path);
      if (!st.isFile()) return null;
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  }

  const tree: Tree = {
    moves,
    state(path: string): FileState | null {
      if (cur.has(path)) {
        const v = cur.get(path);
        return v === undefined ? null : v;
      }
      const bytes = loadDisk(path);
      orig.set(path, bytes);
      const fs = bytes === null ? null : parseText(bytes);
      cur.set(path, fs);
      return fs;
    },
    exists(path: string): boolean {
      if (cur.has(path)) return cur.get(path) !== null;
      try {
        statSync(path);
        return true;
      } catch {
        return false;
      }
    },
    set(path: string, fs: FileState | null): void {
      cur.set(path, fs);
    },
    initialBytes(path: string): string | null {
      if (orig.has(path)) {
        const v = orig.get(path);
        return v === undefined ? null : v;
      }
      const bytes = loadDisk(path);
      orig.set(path, bytes);
      return bytes;
    },
    finalBytes(path: string): string | null {
      const fs = tree.state(path);
      return fs === null ? null : serializeText(fs);
    },
    touchedPaths(): string[] {
      return [...cur.keys()];
    },
  };
  return tree;
}

function byteCompare(a: string, b: string): number {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i] !== bb[i]) return ba[i] - bb[i];
  }
  return ba.length - bb.length;
}

// ---------------------------------------------------------------------------
// Invocation and format detection (SPEC sections 1 and 4)
// ---------------------------------------------------------------------------

interface Cli {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

function parseCli(argv: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  let patch: string | null = null;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let noMoreOptions = false;
  let positional = 0;
  for (const a of argv) {
    if (!noMoreOptions && a === '--') {
      noMoreOptions = true;
      continue;
    }
    if (!noMoreOptions && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return null;
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return null;
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return null;
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') return null;
        format = v;
      } else {
        return null;
      }
      continue;
    }
    positional++;
    if (positional > 1) return null;
    patch = a;
  }
  return { format: format === null ? 'auto' : format, check, strict, patch };
}

function detectFormat(lines: string[]): string | null {
  let firstNonBlank = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      firstNonBlank = i;
      break;
    }
  }
  if (firstNonBlank === -1) return null;
  const firstLine = lines[firstNonBlank];
  if (firstLine.trim() === '*** Begin Patch') return 'v4a';
  const firstCh = firstLine.trimStart()[0];
  if (firstCh === '[' || firstCh === '{') return 'json';
  for (const l of lines) {
    if (rstripWs(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

interface BodyItem {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  empty: boolean;
}

interface Hunk {
  a: number;
  items: BodyItem[];
}

interface UniSection {
  inHeader: boolean;
  sawPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newUniSection(): UniSection {
  return {
    inHeader: true,
    sawPair: false,
    pairOld: null,
    pairNew: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

// The path of a --- or +++ line: the text after the four characters, up to
// the first tab, with surrounding spaces removed, a leading a/ or b/ removed.
function parseDiffPath(line: string): string {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest.startsWith('a/')) return rest.slice(2);
  if (rest.startsWith('b/')) return rest.slice(2);
  return rest;
}

function bodyItem(raw: string): BodyItem {
  if (raw === '') return { kind: 'ctx', text: '', empty: true };
  if (raw.startsWith(' ')) return { kind: 'ctx', text: raw.slice(1), empty: false };
  if (raw.startsWith('-')) return { kind: 'old', text: raw.slice(1), empty: false };
  if (raw.startsWith('+')) return { kind: 'new', text: raw.slice(1), empty: false };
  return { kind: 'bs', text: raw.slice(1), empty: false };
}

function splitHunk(hunk: Hunk): { o: OLine[]; n: NLine[] } {
  const o: OLine[] = [];
  const n: NLine[] = [];
  for (const it of hunk.items) {
    if (it.kind === 'bs') continue;
    if (it.kind === 'ctx') {
      const idx = o.length;
      o.push({ text: it.text, ctx: true, oIdx: idx });
      n.push({ text: it.text, ctx: true, oIdx: idx });
    } else if (it.kind === 'old') {
      o.push({ text: it.text, ctx: false, oIdx: -1 });
    } else {
      n.push({ text: it.text, ctx: false, oIdx: -1 });
    }
  }
  return { o, n };
}

// Whether a \ line follows the hunk's last context or + line.
function backslashAfterLast(hunk: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < hunk.items.length; i++) {
    if (hunk.items[i].kind === 'ctx' || hunk.items[i].kind === 'new') last = i;
  }
  if (last === -1) return false;
  return last + 1 < hunk.items.length && hunk.items[last + 1].kind === 'bs';
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: UniSection | null = null;
  const finish = (): void => {
    if (sec !== null) {
      edits.push(unifiedEdit(sec));
      sec = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new ParseError(i + 1);
      finish();
      sec = newUniSection();
      sec.diffOld = m[1];
      sec.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (sec !== null && sec.inHeader && !sec.sawPair) {
        sec.pairOld = parseDiffPath(line);
        sec.sawPair = true;
        i++;
        continue;
      }
      finish();
      sec = newUniSection();
      sec.pairOld = parseDiffPath(line);
      sec.sawPair = true;
      i++;
      continue;
    }
    if (sec !== null && sec.inHeader && line.startsWith('--- ')) {
      throw new ParseError(i + 2);
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new ParseError(i + 1);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new ParseError(i + 1);
      sec.inHeader = false;
      const hunk: Hunk = { a: parseInt(m[1], 10), items: [] };
      i++;
      while (i < lines.length) {
        const bl = lines[i];
        if (bl.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          hunk.items.push(bodyItem(bl));
          i++;
        } else {
          break;
        }
      }
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1].empty) hunk.items.pop();
      sec.hunks.push(hunk);
      continue;
    }
    if (sec !== null && sec.inHeader) {
      if (line.startsWith('+++ ')) {
        sec.pairNew = parseDiffPath(line);
      } else if (line.startsWith('rename from ')) {
        sec.renameFrom = line.slice('rename from '.length).trim();
      } else if (line.startsWith('rename to ')) {
        sec.renameTo = line.slice('rename to '.length).trim();
      } else if (line === 'new file mode' || line.startsWith('new file mode ')) {
        sec.newFile = true;
      } else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) {
        sec.deletedFile = true;
      }
      i++;
      continue;
    }
    i++;
  }
  finish();
  return edits;
}

function unifiedEdit(sec: UniSection): Edit {
  const oldPath = sec.pairOld !== null ? sec.pairOld : sec.renameFrom !== null ? sec.renameFrom : sec.diffOld !== null ? sec.diffOld : '';
  const newPath = sec.pairNew !== null ? sec.pairNew : sec.renameTo !== null ? sec.renameTo : sec.diffNew !== null ? sec.diffNew : '';
  const isCreate = oldPath === '/dev/null' || sec.newFile;
  const isDelete = newPath === '/dev/null' || sec.deletedFile;
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return {
    apply(tree: Tree, strict: boolean): EditFailure | null {
      if (isCreate) {
        if (!isSafePath(newPath)) return { code: 'unsafe', path: newPath };
        if (tree.exists(newPath)) return { code: 'exists', path: newPath };
        const content: string[] = [];
        for (const h of sec.hunks) {
          for (const it of h.items) {
            if (it.kind === 'new') content.push(it.text);
          }
        }
        let eol = false;
        if (content.length > 0) {
          eol = true;
          for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
            if (sec.hunks[hi].items.some((it) => it.kind === 'new')) {
              eol = !backslashAfterLast(sec.hunks[hi]);
              break;
            }
          }
        }
        tree.set(newPath, { lines: content, brk: '\n', eol });
        return null;
      }
      if (isDelete) {
        if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
        if (tree.state(oldPath) === null) return { code: 'missing', path: oldPath };
        tree.set(oldPath, null);
        return null;
      }
      if (!isSafePath(oldPath)) return { code: 'unsafe', path: oldPath };
      if (isMove && !isSafePath(newPath)) return { code: 'unsafe', path: newPath };
      const st = tree.state(oldPath);
      if (st === null) return { code: 'missing', path: oldPath };
      if (isMove && tree.exists(newPath)) return { code: 'exists', path: newPath };
      const next = cloneState(st);
      let d = 0;
      for (const hunk of sec.hunks) {
        const r = applyHunk(next, hunk, d, strict, oldPath);
        if (r.fail !== null) return r.fail;
        d += r.delta;
      }
      if (isMove) {
        tree.set(newPath, next);
        tree.set(oldPath, null);
        tree.moves.push({ old: oldPath, new: newPath });
      } else {
        tree.set(oldPath, next);
      }
      return null;
    },
  };
}

function applyHunk(
  f: FileState,
  hunk: Hunk,
  d: number,
  strict: boolean,
  path: string,
): { fail: EditFailure | null; delta: number } {
  const { o, n } = splitHunk(hunk);
  const oTexts = o.map((e) => e.text);
  if (oTexts.length > 0) {
    const found = findTier(f.lines, oTexts, 0, strict);
    if (found === null) return { fail: { code: 'no-match', path }, delta: 0 };
    const target = hunk.a - 1 + d;
    let best = found.pos[0];
    let bestDist = Math.abs(found.pos[0] - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const rep = buildReplacement(n, f.lines, best, found.tier, oTexts[0]);
    const toEnd = best + oTexts.length === f.lines.length;
    f.lines.splice(best, oTexts.length, ...rep);
    if (toEnd) f.eol = !backslashAfterLast(hunk);
    return { fail: null, delta: n.length - oTexts.length };
  }
  const insertAt = Math.min(Math.max(hunk.a + d, 0), f.lines.length);
  const atEnd = insertAt === f.lines.length;
  const texts = n.map((e) => e.text);
  f.lines.splice(insertAt, 0, ...texts);
  if (atEnd) f.eol = !backslashAfterLast(hunk);
  return { fail: null, delta: texts.length };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[]): Edit {
  return {
    apply(tree: Tree, strict: boolean): EditFailure | null {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (oldLines.length === 0) {
        if (tree.exists(path)) return { code: 'exists', path };
        tree.set(path, { lines: [...newLines], brk: '\n', eol: newLines.length > 0 });
        return null;
      }
      const st = tree.state(path);
      if (st === null) return { code: 'missing', path };
      const found = findTier(st.lines, oldLines, 0, strict);
      if (found === null) return { code: 'no-match', path };
      if (found.pos.length > 1) return { code: 'ambiguous', path };
      const pos = found.pos[0];
      const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 }));
      const rep = buildReplacement(n, st.lines, pos, found.tier, oldLines[0]);
      const next = cloneState(st);
      next.lines.splice(pos, oldLines.length, ...rep);
      tree.set(path, next);
      return null;
    },
  };
}

function parseSearchReplace(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (rstripWs(lines[i]) !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const cand = lines[j];
      if (isBlank(cand)) continue;
      if (cand.trim().startsWith('```')) continue;
      path = cand.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseError(s + 1);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = rstripWs(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseError(s + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (rstripWs(lines[j]) === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new ParseError(s + 1);
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: BodyItem[];
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return {
    apply(tree: Tree): EditFailure | null {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (tree.exists(path)) return { code: 'exists', path };
      tree.set(path, { lines: [...fileLines], brk: '\n', eol: fileLines.length > 0 });
      return null;
    },
  };
}

function v4aDeleteEdit(path: string): Edit {
  return {
    apply(tree: Tree): EditFailure | null {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (tree.state(path) === null) return { code: 'missing', path };
      tree.set(path, null);
      return null;
    },
  };
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const lastTier = strict ? 0 : 2;
  for (let tier = 0; tier <= lastTier; tier++) {
    for (let i = from; i < lines.length; i++) {
      if (lineEq(lines[i], anchor, tier)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): Edit {
  return {
    apply(tree: Tree, strict: boolean): EditFailure | null {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (moveTo !== null && !isSafePath(moveTo)) return { code: 'unsafe', path: moveTo };
      const st = tree.state(path);
      if (st === null) return { code: 'missing', path };
      if (moveTo !== null && tree.exists(moveTo)) return { code: 'exists', path: moveTo };
      const next = cloneState(st);
      let cursor = 0;
      for (const chunk of chunks) {
        if (chunk.anchor !== null) {
          const at = findAnchor(next.lines, chunk.anchor, cursor, strict);
          if (at === -1) return { code: 'no-match', path };
          cursor = at + 1;
        }
        const { o, n } = splitHunk({ a: 0, items: chunk.items });
        const oTexts = o.map((e) => e.text);
        if (oTexts.length > 0) {
          let found: { tier: number; pos: number[] } | null = null;
          const lastTier = strict ? 0 : 2;
          for (let tier = 0; tier <= lastTier; tier++) {
            const pos = occurrences(next.lines, oTexts, tier, cursor).filter(
              (p) => !chunk.eof || p + oTexts.length === next.lines.length,
            );
            if (pos.length > 0) {
              found = { tier, pos };
              break;
            }
          }
          if (found === null) return { code: 'no-match', path };
          const pos = found.pos[0];
          const rep = buildReplacement(n, next.lines, pos, found.tier, oTexts[0]);
          next.lines.splice(pos, oTexts.length, ...rep);
          cursor = pos + rep.length;
        } else {
          const at = chunk.eof ? next.lines.length : cursor;
          const texts = n.map((e) => e.text);
          next.lines.splice(at, 0, ...texts);
          cursor = at + texts.length;
        }
      }
      if (moveTo !== null) {
        tree.set(moveTo, next);
        tree.set(path, null);
        tree.moves.push({ old: path, new: moveTo });
      } else {
        tree.set(path, next);
      }
      return null;
    },
  };
}

function parseV4a(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      if (first === -1) first = i;
      last = i;
    }
  }
  if (first === -1) throw new ParseError(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseError(lines.length + 1);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && isBlank(lines[i])) i++;
    if (i >= last) break;
    const line = lines[i];
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else {
      throw new ParseError(i + 1);
    }
    const secLine = i;
    i++;
    const bodyStart = i;
    while (i < last) {
      const l = lines[i];
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      i++;
    }
    const body = lines.slice(bodyStart, i);
    while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (let k = 0; k < body.length; k++) {
        const bl = body[k];
        if (bl === '') fileLines.push('');
        else if (bl.startsWith('+')) fileLines.push(bl.slice(1));
        else throw new ParseError(bodyStart + k + 1);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'delete') {
      if (body.length > 0) throw new ParseError(bodyStart + 1);
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (body.length > 0 && body[0].startsWith('*** Move to: ')) {
        moveTo = body[0].slice('*** Move to: '.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const closeChunk = (): void => {
        if (cur !== null) {
          chunks.push(cur);
          cur = null;
        }
      };
      for (; idx < body.length; idx++) {
        const bl = body[idx];
        if (bl.startsWith('@@')) {
          closeChunk();
          const anchor = bl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, items: [] };
        } else if (bl === '*** End of File') {
          if (cur === null) throw new ParseError(bodyStart + idx + 1);
          cur.eof = true;
          closeChunk();
        } else if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new ParseError(bodyStart + idx + 1);
            cur = { anchor: null, eof: false, items: [] };
          }
          cur.items.push(bodyItem(bl));
        } else {
          throw new ParseError(bodyStart + idx + 1);
        }
      }
      closeChunk();
      if (chunks.length === 0 && moveTo === null) throw new ParseError(secLine + 1);
      edits.push(v4aUpdateEdit(path, moveTo, chunks));
    }
  }
  return edits;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC section 9)
// ---------------------------------------------------------------------------

function jsonCreateEdit(path: string, fileText: string): Edit {
  return {
    apply(tree: Tree): EditFailure | null {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      if (tree.exists(path)) return { code: 'exists', path };
      tree.set(path, parseText(fileText));
      return null;
    },
  };
}

function jsonStrReplaceEdit(path: string, oldStr: string, newStr: string): Edit {
  return {
    apply(tree: Tree): EditFailure | null {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      const st = tree.state(path);
      if (st === null) return { code: 'missing', path };
      const isCrlf = st.brk === '\r\n';
      let text = serializeText(st);
      let oldS = oldStr;
      let newS = newStr;
      if (isCrlf) {
        text = text.replace(/\r\n/g, '\n');
        oldS = oldS.replace(/\r\n/g, '\n');
        newS = newS.replace(/\r\n/g, '\n');
      }
      let count = 0;
      let foundAt = -1;
      let from = 0;
      for (;;) {
        const p = text.indexOf(oldS, from);
        if (p === -1) break;
        count++;
        if (foundAt === -1) foundAt = p;
        from = p + 1;
      }
      if (count === 0) return { code: 'no-match', path };
      if (count > 1) return { code: 'ambiguous', path };
      const replaced = text.slice(0, foundAt) + newS + text.slice(foundAt + oldS.length);
      tree.set(path, parseText(isCrlf ? replaced.replace(/\n/g, '\r\n') : replaced));
      return null;
    },
  };
}

function jsonInsertEdit(path: string, insertLine: number, newStr: string): Edit {
  return {
    apply(tree: Tree): EditFailure | null {
      if (!isSafePath(path)) return { code: 'unsafe', path };
      const st = tree.state(path);
      if (st === null) return { code: 'missing', path };
      if (insertLine < 0 || insertLine > st.lines.length) return { code: 'no-match', path };
      const ins = splitPatchLines(newStr);
      const next = cloneState(st);
      next.lines.splice(insertLine, 0, ...ins);
      tree.set(path, next);
      return null;
    },
  };
}

function jsonEdit(el: unknown, errLine: number): Edit {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) throw new ParseError(errLine);
  const o = el as Record<string, unknown>;
  if (typeof o.path !== 'string') throw new ParseError(errLine);
  if (typeof o.command !== 'string') throw new ParseError(errLine);
  const path = o.path;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') throw new ParseError(errLine);
    return jsonCreateEdit(path, o.file_text);
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') throw new ParseError(errLine);
    if (o.new_str !== undefined && typeof o.new_str !== 'string') throw new ParseError(errLine);
    return jsonStrReplaceEdit(path, o.old_str, typeof o.new_str === 'string' ? o.new_str : '');
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) throw new ParseError(errLine);
    if (typeof o.new_str !== 'string') throw new ParseError(errLine);
    return jsonInsertEdit(path, o.insert_line, o.new_str);
  }
  throw new ParseError(errLine);
}

function parseJson(lines: string[], patchText: string): Edit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  const firstCh = lines[first].trimStart()[0];
  if (firstCh === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(first + 1);
    const edits: Edit[] = [];
    for (const el of arr) edits.push(jsonEdit(el, first + 1));
    return edits;
  }
  const edits: Edit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      throw new ParseError(i + 1);
    }
    edits.push(jsonEdit(obj, i + 1));
  }
  return edits;
}

// ---------------------------------------------------------------------------
// Order and atomicity, output and exit codes (SPEC sections 2 and 10)
// ---------------------------------------------------------------------------

interface Change {
  sortKey: string;
  line: string;
  path: string;
  kind: 'A' | 'D' | 'M' | 'R';
  newPath: string | null;
}

function computeChanges(tree: Tree): Change[] {
  const changes: Change[] = [];
  const rOld = new Set<string>();
  const rNew = new Set<string>();
  for (const m of tree.moves) {
    const ibOld = tree.initialBytes(m.old);
    const fbOld = tree.finalBytes(m.old);
    const ibNew = tree.initialBytes(m.new);
    const fbNew = tree.finalBytes(m.new);
    if (ibOld !== null && fbOld === null && ibNew === null && fbNew !== null) {
      changes.push({ sortKey: m.new, line: `R ${m.old} -> ${m.new}`, path: m.old, kind: 'R', newPath: m.new });
      rOld.add(m.old);
      rNew.add(m.new);
    }
  }
  for (const p of tree.touchedPaths()) {
    if (rOld.has(p) || rNew.has(p)) continue;
    const ib = tree.initialBytes(p);
    const fb = tree.finalBytes(p);
    if (ib === null && fb !== null) {
      changes.push({ sortKey: p, line: `A ${p}`, path: p, kind: 'A', newPath: null });
    } else if (ib !== null && fb === null) {
      changes.push({ sortKey: p, line: `D ${p}`, path: p, kind: 'D', newPath: null });
    } else if (ib !== null && fb !== null && ib !== fb) {
      changes.push({ sortKey: p, line: `M ${p}`, path: p, kind: 'M', newPath: null });
    }
  }
  changes.sort((a, b) => byteCompare(a.sortKey, b.sortKey));
  return changes;
}

function writeChanges(tree: Tree, changes: Change[]): void {
  for (const c of changes) {
    if (c.kind === 'D' || c.kind === 'R') {
      try {
        unlinkSync(c.path);
      } catch {
        // Best effort: a path already gone needs no delete.
      }
    }
  }
  for (const c of changes) {
    if (c.kind === 'D') continue;
    const target = c.kind === 'R' && c.newPath !== null ? c.newPath : c.path;
    const fb = tree.finalBytes(target);
    if (fb === null) continue;
    try {
      const dir = dirname(target);
      if (dir !== '.') mkdirSync(dir, { recursive: true });
      writeFileSync(target, fb, 'utf8');
    } catch {
      // Best effort: keep the rest of the tree written.
    }
  }
}

function main(): number {
  const cli = parseCli(process.argv.slice(2));
  if (cli === null) {
    process.stdout.write('error: usage\n');
    return 2;
  }
  let patchText: string;
  if (cli.patch === null || cli.patch === '-') {
    try {
      patchText = readFileSync(0, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  } else {
    try {
      patchText = readFileSync(cli.patch, 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      return 2;
    }
  }
  const lines = splitPatchLines(patchText);
  let format = cli.format;
  if (format === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) {
      process.stdout.write('error: format\n');
      return 2;
    }
    format = detected;
  }
  let edits: Edit[];
  try {
    if (format === 'unified') edits = parseUnified(lines);
    else if (format === 'search-replace') edits = parseSearchReplace(lines);
    else if (format === 'v4a') edits = parseV4a(lines);
    else edits = parseJson(lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) {
      process.stdout.write(`error: parse ${e.line}\n`);
      return 2;
    }
    throw e;
  }
  if (edits.length === 0) {
    process.stdout.write('error: parse 1\n');
    return 2;
  }
  const tree = makeTree();
  const failures: EditFailure[] = [];
  for (const edit of edits) {
    const f = edit.apply(tree, cli.strict);
    if (f !== null) failures.push(f);
  }
  if (failures.length > 0) {
    let out = '';
    for (const f of failures) out += `error: ${f.code} ${f.path}\n`;
    out += `failed: ${failures.length} of ${edits.length} edits\n`;
    process.stdout.write(out);
    return 1;
  }
  const changes = computeChanges(tree);
  if (!cli.check) writeChanges(tree, changes);
  let out = '';
  for (const c of changes) out += `${c.line}\n`;
  out += changes.length === 1 ? 'ok: 1 file\n' : `ok: ${changes.length} files\n`;
  process.stdout.write(out);
  return 0;
}

// In a trial the runner takes over: it reads the checks from the env, runs
// this CLI on each one in a fresh directory, and posts what it did.
if (process.env.MAKEFUN_ENV_URL) {
  runTrial(process.env.MAKEFUN_ENV_URL).catch((err: unknown) => {
    process.stderr.write(`runTrial failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
} else {
  process.exitCode = main();
}
