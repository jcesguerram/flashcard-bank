// Pure card logic: finding #flashcard lines in a note, reading their parts,
// and writing them back. No Obsidian imports here, so it can be tested with
// plain Node (see tests/).
//
// A card is a list item that carries the card tag, e.g.
//   - [?] Question – Answer [Source:: …] [Related:: …] #flashcard ^e57187
//
// Indentation carries no meaning: a card indented under another is read
// exactly like any other card.
//
// Rewriting is surgical: the line is split into a "lead" (question – answer)
// and a "tail" of tokens (fields, tags, block id) with whatever text sits
// between them. Only the pieces that changed are replaced, so a card saved
// without changes comes back byte-for-byte identical.

export interface Field {
  name: string;
  value: string; // text after "::", untrimmed
  raw: string; // full "[Name:: value]"
  start: number; // offset in body
  end: number;
}

export interface Card {
  path: string;
  line: number; // first line, 0-based
  endLine: number; // last line, inclusive
  raw: string; // all lines of the card joined with "\n"
  prefix: string; // indent + bullet (+ checkbox) + space
  body: string; // raw minus prefix
  leadEnd: number; // offset in body where question–answer text ends
  q: string;
  a: string;
  sep: string; // dash used between question and answer
  fields: Field[];
  tags: string[];
  id: string | null;
  idStart: number; // offset in body, -1 if no id
}

export interface ConnLink {
  raw: string; // "[[Risk#^e57187|alias]]"
  linkpath: string; // "Risk"
  blockId: string | null; // "e57187"
  alias: string;
}

export const FIELD_RE = /\[[^[\]]*::(?:\[\[[^\]]*\]\]|[^[\]])*\]/g;
const LIST_RE = /^(\s*(?:[-*+]|\d+[.)])\s+(?:\[.\]\s+)?)/;
const NEW_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s/;
const FENCE_RE = /^\s*(```|~~~)/;
const ID_AT_END_RE = /(^|\s)\^([A-Za-z0-9-]+)\s*$/;
const TAG_RE = /(^|\s)(#[^\s#[\](),;:!?"']+)/g;
const SEP_RE = /\s+([–—])\s+/;
const SEP_HYPHEN_RE = /\s+(-)\s+/;

export function hasTag(text: string, tag: string): boolean {
  const t = tag.startsWith("#") ? tag : "#" + tag;
  const re = new RegExp("(^|\\s)" + escapeRe(t) + "(?=\\s|$)");
  return re.test(maskFields(text));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function maskFields(s: string): string {
  return s.replace(FIELD_RE, (m) => " ".repeat(m.length));
}

/** Split text into lines, remembering the line ending used. */
export function splitLines(text: string): { lines: string[]; eol: string } {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { lines: text.split(/\r?\n/), eol };
}

/** Find every card in a note. Skips frontmatter and fenced code blocks. */
export function parseCards(text: string, path: string, tag = "#flashcard"): Card[] {
  const { lines } = splitLines(text);
  const cards: Card[] = [];
  let inFence = false;
  let fenceMark = "";
  let start = 0;
  if (lines[0] === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---" || lines[i] === "...") {
        start = i + 1;
        break;
      }
    }
  }
  const at = (k: number): string => lines[k] ?? "";
  for (let i = start; i < lines.length; i++) {
    const ln = at(i);
    const f = ln.match(FENCE_RE);
    if (f) {
      if (!inFence) {
        inFence = true;
        fenceMark = f[1] ?? "";
      } else if (f[1] === fenceMark) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;
    const pm = ln.match(LIST_RE);
    if (!pm) continue;
    // Gather lazy continuation lines (no blank line, no new list item).
    let end = i;
    while (
      end + 1 < lines.length &&
      at(end + 1).trim() !== "" &&
      !NEW_ITEM_RE.test(at(end + 1)) &&
      !FENCE_RE.test(at(end + 1)) &&
      !/^\s*#{1,6}\s/.test(at(end + 1))
    ) {
      end++;
    }
    const raw = lines.slice(i, end + 1).join("\n");
    if (hasTag(raw, tag)) cards.push(readCard(raw, path, i, end, pm[1] ?? ""));
    i = end;
  }
  return cards;
}

export function readCard(raw: string, path: string, line: number, endLine: number, prefix: string): Card {
  const body = raw.slice(prefix.length);
  const fields: Field[] = [];
  FIELD_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FIELD_RE.exec(body)) !== null) {
    const inner = m[0].slice(1, -1);
    const k = inner.indexOf("::");
    fields.push({
      name: inner.slice(0, k).trim(),
      value: inner.slice(k + 2),
      raw: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  let masked = maskFields(body);
  let id: string | null = null;
  let idStart = -1;
  const im = masked.match(ID_AT_END_RE);
  if (im && im.index !== undefined) {
    id = im[2] ?? null;
    idStart = im.index + (im[1] ?? "").length;
    masked = masked.slice(0, idStart) + " ".repeat(masked.length - idStart);
  }
  const tags: string[] = [];
  let firstTag = -1;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(masked)) !== null) {
    tags.push(m[2] ?? "");
    if (firstTag < 0) firstTag = m.index + (m[1] ?? "").length;
  }
  const marks = [fields[0] ? fields[0].start : -1, firstTag, idStart].filter((x) => x >= 0);
  const leadEnd = marks.length ? Math.min(...marks) : body.length;
  const { q, a, sep } = splitQA(body.slice(0, leadEnd));
  return { path, line, endLine, raw, prefix, body, leadEnd, q, a, sep, fields, tags, id, idStart };
}

export function splitQA(lead: string): { q: string; a: string; sep: string } {
  const t = lead.replace(/\s+/g, " ").trim();
  const m = t.match(SEP_RE) || t.match(SEP_HYPHEN_RE);
  if (!m || m.index === undefined) return { q: t, a: "", sep: "–" };
  return { q: t.slice(0, m.index).trim(), a: t.slice(m.index + m[0].length).trim(), sep: m[1] ?? "–" };
}

export function getField(card: Card, name: string): Field | undefined {
  const n = name.toLowerCase();
  return card.fields.find((f) => f.name.toLowerCase() === n);
}

export function fieldValue(card: Card, name: string): string {
  const f = getField(card, name);
  return f ? f.value.trim() : "";
}

/** Wikilinks in a piece of text (embeds like ![[image.png]] are skipped). Non-link text is ignored. */
export function parseLinks(value: string): ConnLink[] {
  const out: ConnLink[] = [];
  const re = /\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m.index > 0 && value[m.index - 1] === "!") continue;
    const target = m[1] ?? "";
    const k = target.indexOf("#^");
    out.push({
      raw: m[0],
      linkpath: k >= 0 ? target.slice(0, k) : (target.split("#")[0] ?? ""),
      blockId: k >= 0 ? target.slice(k + 2) : null,
      alias: m[2] || "",
    });
  }
  return out;
}

/**
 * Links written in a card's question or answer. Links to a note (or a heading
 * in it) are concepts; links to a block (#^id) point to another card.
 */
export function textLinks(c: { q: string; a: string }): { concepts: ConnLink[]; cards: ConnLink[] } {
  const all = parseLinks(c.q + " " + c.a);
  return {
    concepts: all.filter((l) => !l.blockId && l.linkpath.trim() !== ""),
    cards: all.filter((l) => !!l.blockId),
  };
}

/** Display text of a field value: wikilinks shown as their alias or name. */
export function plainValue(value: string): string {
  return value
    .replace(/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_m, t: string, al?: string) => al || (t.split("#")[0] ?? ""))
    .trim();
}

/** Text safe to use as a link alias or inside a field. */
export function safeAlias(s: string): string {
  return s.replace(/\|/g, "/").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
}

export function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ").trim();
}

export interface CardEdit {
  q: string;
  a: string;
  /** Field values to set, by field name. Missing fields are appended. */
  fields: Record<string, string>;
  /** Field order used when a field has to be appended. */
  order: string[];
  /** Block id to add if the card has none. */
  newId?: string;
}

/**
 * Rebuild a card's raw text with the given edits. Untouched parts are kept
 * exactly as they were.
 */
export function rewriteCard(card: Card, edit: CardEdit): string {
  const body = card.body;
  // Lead: question – answer. Keep it verbatim if unchanged.
  const oldLead = body.slice(0, card.leadEnd);
  let lead = oldLead;
  const q = oneLine(edit.q);
  const a = oneLine(edit.a);
  if (q !== card.q || a !== card.a) {
    const trail = (oldLead.match(/\s*$/) || [""])[0] || (card.leadEnd < body.length ? " " : "");
    lead = q + (a ? " " + (card.sep || "–") + " " + a : "") + trail;
  }
  // Tail: replace changed fields in place.
  let tail = "";
  let pos = card.leadEnd;
  const known = new Set(card.fields.map((f) => f.name.toLowerCase()));
  for (const f of card.fields) {
    tail += body.slice(pos, f.start);
    const want = lookup(edit.fields, f.name);
    tail += want === undefined || want.trim() === f.value.trim() ? f.raw : fieldRaw(f.name, want);
    pos = f.end;
  }
  let rest = body.slice(pos);
  // Fields the card doesn't have yet go right after its last field (or before
  // the tags if it has none), in the configured order.
  const missing = edit.order.filter((n) => !known.has(n.toLowerCase()) && lookup(edit.fields, n) !== undefined);
  for (const n of Object.keys(edit.fields)) {
    if (!known.has(n.toLowerCase()) && !missing.some((x) => x.toLowerCase() === n.toLowerCase())) missing.push(n);
  }
  if (missing.length) {
    const add = missing.map((n) => fieldRaw(n, lookup(edit.fields, n) || "")).join(" ");
    if (card.fields.length) {
      tail += " " + add;
    } else {
      // No fields at all: insert between lead and the rest of the tail.
      const trimmedLead = lead.replace(/\s+$/, "");
      lead = trimmedLead + " " + add + (lead.length > trimmedLead.length || rest.length ? " " : "");
      if (!rest.length) lead = lead.replace(/\s+$/, "");
    }
  }
  let out = card.prefix + lead + tail + rest;
  if (!card.id && edit.newId) {
    const m = out.match(/\s*$/);
    const ws = m ? m[0] : "";
    out = out.slice(0, out.length - ws.length) + " ^" + edit.newId;
  }
  return out;
}

function lookup(map: Record<string, string>, name: string): string | undefined {
  const n = name.toLowerCase();
  for (const k of Object.keys(map)) if (k.toLowerCase() === n) return map[k];
  return undefined;
}

export function fieldRaw(name: string, value: string): string {
  const v = oneLine(value);
  return "[" + name + ":: " + v + (v ? "" : "") + "]";
}

/** Build a brand-new card line. */
export function newCardLine(
  prefix: string,
  q: string,
  a: string,
  fields: Record<string, string>,
  order: string[],
  tag: string,
  id: string
): string {
  const parts = [oneLine(q) + (oneLine(a) ? " – " + oneLine(a) : "")];
  for (const n of order) parts.push(fieldRaw(n, fields[n] || ""));
  for (const n of Object.keys(fields)) if (!order.includes(n)) parts.push(fieldRaw(n, fields[n] ?? ""));
  parts.push(tag.startsWith("#") ? tag : "#" + tag);
  parts.push("^" + id);
  return prefix + parts.join(" ");
}

/** Every block id already used in a note. */
export function idsInText(text: string): Set<string> {
  const out = new Set<string>();
  const re = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) if (m[1]) out.add(m[1]);
  return out;
}

/** A random 6-character id (lowercase letters and digits) not in `used`. */
export function newId(used: Set<string>, rnd: () => number = Math.random): string {
  for (;;) {
    let s = "";
    while (s.length < 6) s += Math.floor(rnd() * 36).toString(36);
    if (!used.has(s)) {
      used.add(s);
      return s;
    }
  }
}

export type ReplaceResult = { ok: true; text: string } | { ok: false; reason: "missing" | "changed" };

/**
 * Replace one card in a note's text. The card is found again by its block id
 * (or by its line when it has none) and must still read exactly as `expected`;
 * otherwise nothing is changed.
 */
export function replaceCard(text: string, card: Card, expected: string, replacement: string, tag: string): ReplaceResult {
  const cards = parseCards(text, card.path, tag);
  const now = card.id ? cards.find((c) => c.id === card.id) : cards.find((c) => c.line === card.line);
  if (!now) return { ok: false, reason: "missing" };
  if (now.raw !== expected) return { ok: false, reason: "changed" };
  const { lines, eol } = splitLines(text);
  const repl = replacement.split("\n");
  lines.splice(now.line, now.endLine - now.line + 1, ...repl);
  return { ok: true, text: lines.join(eol) };
}

/** Append a card line at the end of a note, separated by a blank line. */
export function appendCard(text: string, line: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (text === "") return line + eol;
  if (text.endsWith(eol + eol)) return text + line + eol;
  if (text.endsWith(eol)) return text + eol + line + eol;
  return text + eol + eol + line + eol;
}

// ── Sections ────────────────────────────────────────────────────────────────

/** A heading in a note. `nth` tells apart headings with the same level and text. */
export interface Heading {
  line: number;
  level: number;
  text: string;
  nth: number;
}

/** Where a new card goes: after the own content of a heading (null: the end of the note). */
export interface SectionRef {
  level: number;
  text: string;
  nth: number;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** The note's headings, in order. Skips frontmatter and fenced code blocks. */
export function headingsOf(text: string): Heading[] {
  const { lines } = splitLines(text);
  const out: Heading[] = [];
  const seen = new Map<string, number>();
  let start = 0;
  if (lines[0] === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === "---" || lines[i] === "...") {
        start = i + 1;
        break;
      }
    }
  }
  let fenceMark = "";
  for (let i = start; i < lines.length; i++) {
    const ln = lines[i] ?? "";
    const f = ln.match(FENCE_RE);
    if (f) {
      if (!fenceMark) fenceMark = f[1] ?? "";
      else if (f[1] === fenceMark) fenceMark = "";
      continue;
    }
    if (fenceMark) continue;
    const m = ln.match(HEADING_RE);
    if (!m) continue;
    const level = (m[1] ?? "").length;
    const t = (m[2] ?? "").trim();
    if (!t) continue;
    const k = level + "\u0000" + t;
    const nth = seen.get(k) ?? 0;
    seen.set(k, nth + 1);
    out.push({ line: i, level, text: t, nth });
  }
  return out;
}

export type InsertResult = { ok: true; text: string } | { ok: false; reason: "missing" };

/**
 * Insert a card line at the end of a section's own content (up to the next
 * heading of any level), or at the end of the note when `section` is null.
 * The card goes right after the last non-blank line; it joins a list that ends
 * there, and is set off by a blank line from anything else.
 */
export function insertCard(text: string, line: string, section: SectionRef | null): InsertResult {
  const { lines, eol } = splitLines(text);
  if (text === "") return { ok: true, text: line + eol };
  let from = 0;
  let to = lines.length; // exclusive
  if (section) {
    const hs = headingsOf(text);
    const i = hs.findIndex((h) => h.level === section.level && h.text === section.text && h.nth === section.nth);
    const h = hs[i];
    if (!h) return { ok: false, reason: "missing" };
    from = h.line;
    to = hs[i + 1]?.line ?? lines.length;
  }
  let last = to - 1;
  while (last > from && !(lines[last] ?? "").trim()) last--;
  if (!section && !(lines[last] ?? "").trim()) {
    // The note is only blank lines.
    return { ok: true, text: line + eol };
  }
  // Does a list end on that line? Walk back through its paragraph looking for a list item.
  let inList = false;
  for (let k = last; k >= from && (lines[k] ?? "").trim(); k--) {
    const ln = lines[k] ?? "";
    if (section && k === from) break; // the heading itself
    if (HEADING_RE.test(ln)) break;
    if (LIST_RE.test(ln)) {
      inList = true;
      break;
    }
  }
  const add = inList ? [line] : ["", line];
  lines.splice(last + 1, 0, ...add);
  // A note that didn't end with a line break still gets one after the card.
  let out = lines.join(eol);
  if (last + 1 + add.length === lines.length) out += eol;
  return { ok: true, text: out };
}
