// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

/** A file's lines with its own line break and whether it ends with one (SPEC.md section 3). */
interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileText {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, final: false };
  const lines = text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function renderFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function lineEqualAt(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every position where O occurs in lines at one tier, at or after `from`; occurrences may overlap. */
function occurrencesAt(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(from, 0); i + o.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < o.length; k += 1) {
      if (!lineEqualAt(lines[i + k]!, o[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once, with its positions, or null (SPEC.md section 5). */
function findTier(lines: string[], o: string[], from: number, strict: boolean, eof: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let pos = occurrencesAt(lines, o, t, from);
    if (eof) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of an old or new block: a context line, or a removed/added line. */
interface LinePart {
  text: string;
  ctx: boolean;
}

/** N as written: a context line is the file's own matched line, every other line is re-indented at tier 2. */
function buildReplacement(fileLines: string[], pos: number, o: LinePart[], n: LinePart[], tier: number): string[] {
  const oCtx: number[] = [];
  for (let k = 0; k < o.length; k += 1) if (o[k]!.ctx) oCtx.push(k);
  const f = o.length > 0 ? leadWs(fileLines[pos] ?? '') : '';
  const p = o.length > 0 ? leadWs(o[0]!.text) : '';
  const out: string[] = [];
  let ci = 0;
  for (const part of n) {
    if (part.ctx) {
      out.push(fileLines[pos + oCtx[ci]!] ?? '');
      ci += 1;
    } else if (tier === 2 && part.text !== '' && !/^[ \t]+$/.test(part.text) && part.text.startsWith(p)) {
      out.push(f + part.text.slice(p.length));
    } else {
      out.push(part.text);
    }
  }
  return out;
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a move edit made, as [old path, new path], for the R output line. */
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

/** One hunk of a unified diff (SPEC.md section 6). */
interface Hunk {
  a: number;
  o: LinePart[];
  n: LinePart[];
  bsCtxPlus: boolean;
  bsPlus: boolean;
}

/** One section of a unified diff: one edit. */
interface UniSection {
  oldPath: string | null;
  newPath: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function uniHeaderPath(l: string): string {
  let t = l.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  return t.trim();
}

function uniStripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function uniResolve(sec: UniSection): { old: string | null; nw: string | null } {
  let old: string | null;
  let nw: string | null;
  if (sec.oldPath !== null) old = sec.oldPath === '/dev/null' ? null : uniStripPrefix(sec.oldPath);
  else if (sec.renameFrom !== null) old = sec.renameFrom;
  else old = sec.diffOld;
  if (sec.newPath !== null) nw = sec.newPath === '/dev/null' ? null : uniStripPrefix(sec.newPath);
  else if (sec.renameTo !== null) nw = sec.renameTo;
  else nw = sec.diffNew;
  return { old, nw };
}

function uniHunk(a: number, body: string[]): Hunk {
  const o: LinePart[] = [];
  const n: LinePart[] = [];
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let j = 0; j < body.length; j += 1) {
    const bl = body[j]!;
    if (bl === '') {
      o.push({ text: '', ctx: true });
      n.push({ text: '', ctx: true });
      lastCtxPlus = j;
    } else if (bl.startsWith(' ')) {
      const t = bl.slice(1);
      o.push({ text: t, ctx: true });
      n.push({ text: t, ctx: true });
      lastCtxPlus = j;
    } else if (bl.startsWith('-')) {
      o.push({ text: bl.slice(1), ctx: false });
    } else if (bl.startsWith('+')) {
      n.push({ text: bl.slice(1), ctx: false });
      lastCtxPlus = j;
      lastPlus = j;
    }
  }
  const bsAfter = (idx: number): boolean => idx >= 0 && idx + 1 < body.length && body[idx + 1]!.startsWith('\\');
  return { a, o, n, bsCtxPlus: bsAfter(lastCtxPlus), bsPlus: bsAfter(lastPlus) };
}

function uniApplyHunks(text: string, hunks: Hunk[], path: string, strict: boolean): string {
  const f = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const oTexts = h.o.map((p) => p.text);
    if (oTexts.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), f.lines.length);
      const ins = h.n.map((p) => p.text);
      const atEnd = at === f.lines.length;
      f.lines.splice(at, 0, ...ins);
      if (atEnd) f.final = !h.bsCtxPlus;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, oTexts, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const toEnd = best + oTexts.length === f.lines.length;
    const rep = buildReplacement(f.lines, best, h.o, h.n, found.tier);
    f.lines.splice(best, oTexts.length, ...rep);
    if (toEnd) f.final = !h.bsCtxPlus;
    d += h.n.length - h.o.length;
  }
  return renderFile(f);
}

function uniSectionEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const { old, nw } = uniResolve(sec);
    const isCreate = sec.creation || old === null;
    const isDelete = !isCreate && (sec.deletion || nw === null);
    if (isCreate) {
      const p = nw ?? old ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let bs = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const part of h.n) {
          if (!part.ctx) {
            plus.push(part.text);
            hasPlus = true;
          }
        }
        if (hasPlus) bs = h.bsPlus;
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (bs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = old ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (old !== nw) {
      const o = old ?? '';
      const n = nw ?? '';
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const cur = tree.get(o);
      if (cur === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const out = uniApplyHunks(cur, sec.hunks, o, strict);
      tree.now.set(o, null);
      tree.now.set(n, out);
      tree.moves.push([o, n]);
      return;
    }
    const p = old ?? '';
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, uniApplyHunks(cur, sec.hunks, p, strict));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let pairSet = false;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let i = 0;
  const fail = (n: number): never => {
    throw new Exit2(`error: parse ${n}`);
  };
  const newSection = (s: UniSection): void => {
    sections.push(s);
    cur = s;
    inHeader = true;
    pairSet = false;
  };
  const blankSection = (): UniSection => ({
    oldPath: null,
    newPath: null,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    creation: false,
    deletion: false,
    hunks: [],
  });
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)\s*$/.exec(l);
      if (m === null) fail(i + 1);
      const s = blankSection();
      s.diffOld = m[1]!;
      s.diffNew = m[2]!;
      newSection(s);
      i += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) fail(i + 1);
      const m = hunkRe.exec(l);
      if (m === null) fail(i + 1);
      const a = Number(m[1]);
      i += 1;
      const body: string[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          body.push(bl);
          i += 1;
          continue;
        }
        break;
      }
      while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
      cur.hunks.push(uniHunk(a, body));
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (l.startsWith('--- ')) {
        if ((lines[i + 1] ?? '').startsWith('+++ ')) {
          if (pairSet) {
            const s = blankSection();
            s.oldPath = uniHeaderPath(l);
            s.newPath = uniHeaderPath(lines[i + 1]!);
            newSection(s);
            pairSet = true;
          } else {
            cur.oldPath = uniHeaderPath(l);
            cur.newPath = uniHeaderPath(lines[i + 1]!);
            pairSet = true;
          }
          i += 2;
          continue;
        }
        fail(i + 2);
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12);
        i += 1;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10);
        i += 1;
        continue;
      }
      if (l === 'new file mode' || l.startsWith('new file mode ')) {
        cur.creation = true;
        i += 1;
        continue;
      }
      if (l === 'deleted file mode' || l.startsWith('deleted file mode ')) {
        cur.deletion = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const s = blankSection();
      s.oldPath = uniHeaderPath(l);
      s.newPath = uniHeaderPath(lines[i + 1]!);
      newSection(s);
      pairSet = true;
      i += 2;
      continue;
    }
    i += 1;
  }
  return sections.map((s) => uniSectionEdit(s, strict));
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = parseFile(cur);
    const found = findTier(f.lines, oldLines, 0, strict, false);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const rep = buildReplacement(
      f.lines,
      pos,
      oldLines.map((t) => ({ text: t, ctx: false })),
      newLines.map((t) => ({ text: t, ctx: false })),
      found.tier,
    );
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, renderFile(f));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j -= 1) {
      const t = lines[j]!;
      if (blank(t)) continue;
      const tr = t.trim();
      if (tr.startsWith('```')) continue;
      path = tr;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(srEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/** One chunk of a V4A Update File section (SPEC.md section 8). */
interface VChunk {
  anchor: string | null;
  eof: boolean;
  o: LinePart[];
  n: LinePart[];
}

function v4aCollect(lines: string[], from: number, last: number): { body: { text: string; no: number }[]; next: number } {
  const body: { text: string; no: number }[] = [];
  let i = from;
  while (i < last) {
    const l = lines[i]!;
    if (l.startsWith('*** Add File:') || l.startsWith('*** Delete File:') || l.startsWith('*** Update File:')) break;
    body.push({ text: l, no: i + 1 });
    i += 1;
  }
  while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
  return { body, next: i };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aFindAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = cursor; i < lines.length; i += 1) {
      if (lineEqualAt(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const ai = v4aFindAnchor(f.lines, ch.anchor, cursor, strict);
        if (ai < 0) throw new Fail('no-match', path);
        cursor = ai + 1;
      }
      const oTexts = ch.o.map((p) => p.text);
      if (oTexts.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((p) => p.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const found = findTier(f.lines, oTexts, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.pos[0]!;
      const rep = buildReplacement(f.lines, pos, ch.o, ch.n, found.tier);
      f.lines.splice(pos, oTexts.length, ...rep);
      cursor = pos + rep.length;
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    const l = lines[i]!;
    if (l.startsWith('*** Add File:')) {
      const path = l.slice('*** Add File:'.length).trim();
      const { body, next } = v4aCollect(lines, i + 1, last);
      const fileLines: string[] = [];
      for (const bl of body) {
        if (bl.text.startsWith('+')) fileLines.push(bl.text.slice(1));
        else if (blank(bl.text)) fileLines.push('');
        else throw new Exit2(`error: parse ${bl.no}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
      i = next;
      continue;
    }
    if (l.startsWith('*** Delete File:')) {
      const path = l.slice('*** Delete File:'.length).trim();
      const { body, next } = v4aCollect(lines, i + 1, last);
      for (const bl of body) {
        if (!blank(bl.text)) throw new Exit2(`error: parse ${bl.no}`);
      }
      edits.push(v4aDeleteEdit(path));
      i = next;
      continue;
    }
    if (l.startsWith('*** Update File:')) {
      const path = l.slice('*** Update File:'.length).trim();
      const updateNo = i + 1;
      const { body, next } = v4aCollect(lines, i + 1, last);
      let moveTo: string | null = null;
      let idx = 0;
      if (body.length > 0 && body[0]!.text.startsWith('*** Move to:')) {
        moveTo = body[0]!.text.slice('*** Move to:'.length).trim();
        idx = 1;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let sawEof = false;
      const startChunk = (anchor: string | null): void => {
        if (curChunk !== null) chunks.push(curChunk);
        curChunk = { anchor, eof: false, o: [], n: [] };
      };
      for (; idx < body.length; idx += 1) {
        const bl = body[idx]!;
        if (bl.text.startsWith('@@')) {
          startChunk(bl.text.slice(2).trim());
          continue;
        }
        if (bl.text.trimEnd() === '*** End of File') {
          if (curChunk === null) throw new Exit2(`error: parse ${bl.no}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          sawEof = true;
          continue;
        }
        if (bl.text === '' || bl.text.startsWith(' ') || bl.text.startsWith('-') || bl.text.startsWith('+')) {
          if (curChunk === null) {
            if (chunks.length === 0 && !sawEof) {
              curChunk = { anchor: null, eof: false, o: [], n: [] };
            } else {
              throw new Exit2(`error: parse ${bl.no}`);
            }
          }
          if (bl.text === '') {
            curChunk.o.push({ text: '', ctx: true });
            curChunk.n.push({ text: '', ctx: true });
          } else if (bl.text.startsWith(' ')) {
            const t = bl.text.slice(1);
            curChunk.o.push({ text: t, ctx: true });
            curChunk.n.push({ text: t, ctx: true });
          } else if (bl.text.startsWith('-')) {
            curChunk.o.push({ text: bl.text.slice(1), ctx: false });
          } else {
            curChunk.n.push({ text: bl.text.slice(1), ctx: false });
          }
          continue;
        }
        throw new Exit2(`error: parse ${bl.no}`);
      }
      if (curChunk !== null) chunks.push(curChunk);
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateNo}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = next;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

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
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? srEdits(lines, strict) : v4aEdits(lines, strict);
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
  const changed: string[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (tree.original(p) !== tree.now.get(p)) changed.push(p);
  }
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      suppressed.add(oldP);
      suppressed.add(newP);
    }
  }
  for (const p of changed) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const texts = rows.map((r) => r.text);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
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
