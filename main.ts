// main.ts — mend, the CLI SPEC.md specifies, written fresh around a line
// index with an anchor map: every file is read once into a LineIndex (its
// own line break, its lines, and, per tier, a map from a line's tier key to
// the positions where that line occurs), and every format's matching is a
// lookup in that index. Node 22, the standard library alone; run it as
// `node main.ts [options] [PATCH]`.
//
// Sections 1-4, 9 and 10 (command line, output and exit codes, safe paths,
// format detection, JSON edits, order and atomicity) follow the kit's
// starter; sections 5-8 (three-tier matching, unified diffs, SEARCH/REPLACE
// blocks, V4A patches) are written here, on the index. A file is split at
// its own break (CRLF when its first line feed follows a carriage return,
// LF otherwise) and written back with that same break, so a V4A edit of a
// CRLF file matches, applies and stays CRLF with the same final break.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and then this file hands over to runner.ts (the last lines below): keep
// that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file split at its own line break (SPEC.md section 3). */
function splitFile(text: string): { br: string; lines: string[]; finalBr: boolean } {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) parts.pop();
  return { br, lines: parts, finalBr };
}

function joinFile(lines: string[], br: string, finalBr: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (finalBr ? br : '');
}

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingST = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

/** The key of a line at a tier (section 5): exact, trailing spaces/tabs off, both ends off. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return trimEndST(line);
  return trimST(line);
}

/**
 * One file's lines with an anchor map: for each tier, the map from a line's
 * tier key to every 0-based position where a line with that key occurs.
 * Occurrences of old lines are found by looking up the first old line's key
 * in the map and checking the lines that follow, so an anchor (a single
 * line) and a multi-line block are both one map lookup.
 */
class LineIndex {
  readonly br: string;
  readonly finalBr: boolean;
  lines: string[];
  private anchorMaps = new Map<number, Map<string, number[]>>();

  constructor(text: string) {
    const s = splitFile(text);
    this.br = s.br;
    this.finalBr = s.finalBr;
    this.lines = s.lines;
  }

  private anchorMap(tier: number): Map<string, number[]> {
    let m = this.anchorMaps.get(tier);
    if (m === undefined) {
      m = new Map<string, number[]>();
      this.lines.forEach((l, i) => {
        const k = tierKey(l, tier);
        const arr = m!.get(k);
        if (arr !== undefined) arr.push(i);
        else m!.set(k, [i]);
      });
      this.anchorMaps.set(tier, m);
    }
    return m;
  }

  /** Positions at or after `from` whose single line equals `line` at `tier`. */
  singlePositions(line: string, tier: number, from: number): number[] {
    const arr = this.anchorMap(tier).get(tierKey(line, tier));
    if (arr === undefined) return [];
    return arr.filter((p) => p >= from);
  }

  /** Positions at or after `from` where O occurs at `tier`; with `endAtEnd` only ones ending at the last line. */
  occurrences(O: string[], tier: number, from: number, endAtEnd: boolean): number[] {
    const out: number[] = [];
    for (const p of this.singlePositions(O[0]!, tier, from)) {
      if (p + O.length > this.lines.length) continue;
      if (endAtEnd && p + O.length !== this.lines.length) continue;
      let ok = true;
      for (let k = 1; k < O.length; k++) {
        if (tierKey(this.lines[p + k]!, tier) !== tierKey(O[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(p);
    }
    return out;
  }

  /** The first tier at which O occurs at least once at or after `from`, with its positions. */
  findTier(O: string[], strict: boolean, from: number, endAtEnd: boolean): { tier: number; positions: number[] } | null {
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      const positions = this.occurrences(O, t, from, endAtEnd);
      if (positions.length > 0) return { tier: t, positions };
    }
    return null;
  }

  /** The first line at or after `from` equal to `anchor`, at the first tier where one is. */
  findAnchor(anchor: string, strict: boolean, from: number): number | null {
    const tiers = strict ? [0] : [0, 1, 2];
    for (const t of tiers) {
      const pos = this.singlePositions(anchor, t, from);
      if (pos.length > 0) return pos[0]!;
    }
    return null;
  }

  /** Drop the cached anchor maps after the lines changed. */
  invalidate(): void {
    this.anchorMaps.clear();
  }

  text(finalBr: boolean): string {
    return joinFile(this.lines, this.br, finalBr);
  }
}

/**
 * The replacement lines for an occurrence of O at `pos` (section 5): a
 * context line of N is written as the file's own matched line, never the
 * patch's; at tier 2 every other line of N is re-indented from O's first
 * line's leading spaces and tabs to the file's first matched line's.
 * `ctxN` maps an index in N to its index in O for context lines.
 */
function applyLines(O: string[], N: string[], ctxN: Map<number, number>, fileLines: string[], pos: number, tier: number): string[] {
  const F = tier === 2 && O.length > 0 ? leadingST(fileLines[pos]!) : '';
  const P = tier === 2 && O.length > 0 ? leadingST(O[0]!) : '';
  return N.map((nl, i) => {
    const oi = ctxN.get(i);
    if (oi !== undefined) return fileLines[pos + oi]!;
    if (tier === 2 && nl !== '' && !/^[ \t]+$/.test(nl) && nl.startsWith(P)) return F + nl.slice(P.length);
    return nl;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------------- section 6: unified diffs ---------------- */

interface Hunk {
  A: number;
  O: string[];
  N: string[];
  ctxN: Map<number, number>;
  noFinal: boolean;
  plusLines: string[];
  lastPlusBackslash: boolean;
}

interface UniSection {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renOld: string | undefined;
  renNew: string | undefined;
  gitOld: string | null;
  gitNew: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** The path of a `--- ` / `+++ ` line: text after the four characters, up to the first tab, spaces removed. */
function headerPath(line: string): string {
  return line.slice(4).split('\t')[0]!.trim();
}

/** A leading `a/` or `b/` is removed from either path. */
function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

function devNull(p: string): string | null {
  return p === '/dev/null' ? null : p;
}

/** Parse one hunk at `lines[i]` (a line starting with `@@`); `next` is the index after its body. */
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const A = Number(m[1]);
  interface BL {
    kind: 'ctx' | 'old' | 'new' | 'bs';
    text: string;
    raw: string;
  }
  const body: BL[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const lj = lines[j]!;
    if (lj.startsWith('diff --git ')) break;
    if (lj.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (lj === '') {
      body.push({ kind: 'ctx', text: '', raw: '' });
      j++;
      continue;
    }
    const c = lj[0];
    if (c === ' ') {
      body.push({ kind: 'ctx', text: lj.slice(1), raw: lj });
      j++;
      continue;
    }
    if (c === '-') {
      body.push({ kind: 'old', text: lj.slice(1), raw: lj });
      j++;
      continue;
    }
    if (c === '+') {
      body.push({ kind: 'new', text: lj.slice(1), raw: lj });
      j++;
      continue;
    }
    if (c === '\\') {
      body.push({ kind: 'bs', text: lj.slice(1), raw: lj });
      j++;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  while (body.length > 0 && body[body.length - 1]!.raw === '') body.pop();
  const O: string[] = [];
  const N: string[] = [];
  const ctxN = new Map<number, number>();
  for (const b of body) {
    if (b.kind === 'ctx') {
      ctxN.set(N.length, O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === 'old') O.push(b.text);
    else if (b.kind === 'new') N.push(b.text);
  }
  // A `\` line follows the hunk's last context or `+` line: no final break.
  let noFinal = false;
  let lastCtxNew = -1;
  body.forEach((b, k) => {
    if (b.kind === 'ctx' || b.kind === 'new') lastCtxNew = k;
  });
  if (lastCtxNew >= 0 && body[lastCtxNew + 1]?.kind === 'bs') noFinal = true;
  const plusLines = body.filter((b) => b.kind === 'new').map((b) => b.text);
  let lastPlusBackslash = false;
  let lastPlusIdx = -1;
  body.forEach((b, k) => {
    if (b.kind === 'new') lastPlusIdx = k;
  });
  if (lastPlusIdx >= 0 && body[lastPlusIdx + 1]?.kind === 'bs') lastPlusBackslash = true;
  return { hunk: { A, O, N, ctxN, noFinal, plusLines, lastPlusBackslash }, next: j };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  const newSection = (gitOld: string | null, gitNew: string | null): UniSection => ({
    pairOld: undefined,
    pairNew: undefined,
    renOld: undefined,
    renNew: undefined,
    gitOld,
    gitNew,
    create: false,
    del: false,
    hunks: [],
  });
  let cur: UniSection | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      sections.push(cur);
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const { hunk, next } = parseHunk(lines, i);
      cur.hunks.push(hunk);
      inHeader = false;
      i = next;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          cur.pairOld = devNull(stripAB(headerPath(l)));
          cur.pairNew = devNull(stripAB(headerPath(lines[i + 1]!)));
          i += 2;
          continue;
        }
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        cur.renOld = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renNew = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        cur = newSection(null, null);
        cur.pairOld = devNull(stripAB(headerPath(l)));
        cur.pairNew = devNull(stripAB(headerPath(lines[i + 1]!)));
        sections.push(cur);
        inHeader = true;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection(null, null);
      cur.pairOld = devNull(stripAB(headerPath(l)));
      cur.pairNew = devNull(stripAB(headerPath(lines[i + 1]!)));
      sections.push(cur);
      inHeader = true;
      i += 2;
      continue;
    }
    i++;
  }
  return sections.map((sec) => {
    const oldP = sec.pairOld !== undefined ? sec.pairOld : sec.renOld !== undefined ? sec.renOld : sec.gitOld;
    const newP = sec.pairNew !== undefined ? sec.pairNew : sec.renNew !== undefined ? sec.renNew : sec.gitNew;
    return (tree: Tree): void => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      if (sec.create || oldP === null) {
        if (newP === null) throw new Fail('unsafe', '');
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        let lastH: Hunk | null = null;
        for (const h of sec.hunks) {
          plus.push(...h.plusLines);
          if (h.plusLines.length > 0) lastH = h;
        }
        const noBreak = lastH !== null && lastH.lastPlusBackslash;
        const text = plus.length === 0 ? '' : plus.join('\n') + (noBreak ? '' : '\n');
        tree.now.set(newP, text);
        return;
      }
      const op = oldP!;
      if (sec.del || newP === null) {
        if (tree.get(op) === null) throw new Fail('missing', op);
        tree.now.set(op, null);
        return;
      }
      const content = tree.get(op);
      if (content === null) throw new Fail('missing', op);
      const isMove = newP !== null && newP !== op;
      if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
      const idx = new LineIndex(content);
      let finalBr = idx.finalBr;
      let d = 0;
      for (const h of sec.hunks) {
        if (h.O.length === 0) {
          let pos = h.A + d;
          if (pos < 0) pos = 0;
          if (pos > idx.lines.length) pos = idx.lines.length;
          const atEnd = pos === idx.lines.length;
          const ins = applyLines(h.O, h.N, h.ctxN, idx.lines, pos, 0);
          idx.lines.splice(pos, 0, ...ins);
          if (atEnd) finalBr = !h.noFinal;
          d += h.N.length;
        } else {
          const found = idx.findTier(h.O, strict, 0, false);
          if (found === null) throw new Fail('no-match', op);
          const target = h.A - 1 + d;
          let best = found.positions[0]!;
          let bestDist = Math.abs(best - target);
          for (const p of found.positions) {
            const dist = Math.abs(p - target);
            if (dist < bestDist) {
              best = p;
              bestDist = dist;
            }
          }
          const runsToEnd = best + h.O.length === idx.lines.length;
          const rep = applyLines(h.O, h.N, h.ctxN, idx.lines, best, found.tier);
          idx.lines.splice(best, h.O.length, ...rep);
          if (runsToEnd) finalBr = !h.noFinal;
          d += h.N.length - h.O.length;
        }
        idx.invalidate();
      }
      const result = idx.text(finalBr);
      if (isMove) {
        tree.now.set(newP!, result);
        tree.now.set(op, null);
        tree.moves.push([op, newP!]);
      } else {
        tree.now.set(op, result);
      }
    };
  });
}

/* ---------------- section 7: SEARCH/REPLACE blocks ---------------- */

interface SrBlock {
  path: string;
  old: string[];
  new: string[];
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let lastReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep === -1) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > lastReplace; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    blocks.push({ path, old: lines.slice(i + 1, eq), new: lines.slice(eq + 1, rep) });
    prevPath = path;
    lastReplace = rep;
    i = rep + 1;
  }
  return blocks.map((b) => {
    return (tree: Tree): void => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.old.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        const text = b.new.length === 0 ? '' : b.new.join('\n') + '\n';
        tree.now.set(b.path, text);
        return;
      }
      const content = tree.get(b.path);
      if (content === null) throw new Fail('missing', b.path);
      const idx = new LineIndex(content);
      const found = idx.findTier(b.old, strict, 0, false);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.positions[0]!;
      const rep = applyLines(b.old, b.new, new Map<number, number>(), idx.lines, pos, found.tier);
      idx.lines.splice(pos, b.old.length, ...rep);
      idx.invalidate();
      tree.now.set(b.path, idx.text(idx.finalBr));
    };
  });
}

/* ---------------- section 8: V4A patches ---------------- */

interface VChunk {
  anchor: string | null;
  body: string[];
  eof: boolean;
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  fileLines: string[];
  chunks: VChunk[];
  line: number;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isHeader = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (l.startsWith('*** Add File: ')) {
      kind = 'add';
      path = l.slice(14).trim();
    } else if (l.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = l.slice(17).trim();
    } else if (l.startsWith('*** Update File: ')) {
      kind = 'update';
      path = l.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const headerLine = i + 1;
    const raw: number[] = [];
    let j = i + 1;
    while (j < last && !isHeader(lines[j]!)) {
      raw.push(j);
      j++;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && blank(lines[raw[raw.length - 1]!]!)) raw.pop();
    if (kind === 'add') {
      const fileLines: string[] = [];
      for (const k of raw) {
        const sl = lines[k]!;
        if (sl.startsWith('+')) fileLines.push(sl.slice(1));
        else if (sl === '') fileLines.push('');
        else throw new Exit2(`error: parse ${k + 1}`);
      }
      sections.push({ kind, path, moveTo: null, fileLines, chunks: [], line: headerLine });
    } else if (kind === 'delete') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]! + 1}`);
      sections.push({ kind, path, moveTo: null, fileLines: [], chunks: [], line: headerLine });
    } else {
      let moveTo: string | null = null;
      let k0 = 0;
      if (raw.length > 0 && lines[raw[0]!]!.startsWith('*** Move to: ')) {
        moveTo = lines[raw[0]!]!.slice(13).trim();
        k0 = 1;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      for (let t = k0; t < raw.length; t++) {
        const k = raw[t]!;
        const sl = lines[k]!;
        if (sl.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchor = sl.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
        } else if (sl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${k + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
        } else if (sl === '' || sl.startsWith(' ') || sl.startsWith('-') || sl.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${k + 1}`);
            cur = { anchor: null, body: [], eof: false };
          }
          cur.body.push(sl);
        } else {
          throw new Exit2(`error: parse ${k + 1}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
      sections.push({ kind, path, moveTo, fileLines: [], chunks, line: headerLine });
    }
    i = j;
  }
  return sections.map((sec) => {
    if (sec.kind === 'add') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
        const text = sec.fileLines.length === 0 ? '' : sec.fileLines.join('\n') + '\n';
        tree.now.set(sec.path, text);
      };
    }
    if (sec.kind === 'delete') {
      return (tree: Tree): void => {
        if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
        if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
        tree.now.set(sec.path, null);
      };
    }
    return (tree: Tree): void => {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
      const content = tree.get(sec.path);
      if (content === null) throw new Fail('missing', sec.path);
      if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
      // The file's own line break (CRLF or LF) comes from the index: old
      // lines are matched against lines split at that break, and the result
      // is written back with the same break and the same final break.
      const idx = new LineIndex(content);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        // SPEC section 8: the anchor is found first, the cursor moves past
        // it, and O is searched at or after the cursor. An anchor that is
        // also the chunk's first context line is therefore already behind
        // the cursor when O is searched, and no-match is the correct answer
        // for such a patch — that is not a CRLF gap.
        if (chunk.anchor !== null) {
          const apos = idx.findAnchor(chunk.anchor, strict, cursor);
          if (apos === null) throw new Fail('no-match', sec.path);
          cursor = apos + 1;
        }
        const O: string[] = [];
        const N: string[] = [];
        const ctxN = new Map<number, number>();
        for (const bl of chunk.body) {
          if (bl === '' || bl.startsWith(' ')) {
            ctxN.set(N.length, O.length);
            O.push(bl === '' ? '' : bl.slice(1));
            N.push(bl === '' ? '' : bl.slice(1));
          } else if (bl.startsWith('-')) O.push(bl.slice(1));
          else if (bl.startsWith('+')) N.push(bl.slice(1));
        }
        if (O.length === 0) {
          const insPos = chunk.eof ? idx.lines.length : cursor;
          const ins = applyLines(O, N, ctxN, idx.lines, insPos, 0);
          idx.lines.splice(insPos, 0, ...ins);
          cursor = insPos + ins.length;
        } else {
          const found = idx.findTier(O, strict, cursor, chunk.eof);
          if (found === null) throw new Fail('no-match', sec.path);
          const pos = found.positions[0]!;
          const rep = applyLines(O, N, ctxN, idx.lines, pos, found.tier);
          idx.lines.splice(pos, O.length, ...rep);
          cursor = pos + rep.length;
        }
        idx.invalidate();
      }
      const result = idx.text(idx.finalBr);
      if (sec.moveTo !== null) {
        tree.now.set(sec.moveTo, result);
        tree.now.set(sec.path, null);
        tree.moves.push([sec.path, sec.moveTo]);
      } else {
        tree.now.set(sec.path, result);
      }
    };
  });
}

/* ---------------- section 1, 2, 10: invocation, output, order ---------------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows = new Map<string, string>();
  const changed: string[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push(p);
    rows.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      if (rows.get(oldP)?.startsWith('D ') && rows.get(newP)?.startsWith('A ')) {
        rows.delete(oldP);
        rows.delete(newP);
        rows.set(newP, `R ${oldP} -> ${newP}`);
      }
    }
  }
  const keys = [...rows.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const outLines = keys.map((k) => rows.get(k)!);
  if (!check) {
    // Write every changed path, not just the ones with an output row: a
    // move's old path loses its D row to the R row but must still be deleted.
    for (const p of [...changed].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
