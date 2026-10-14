// The card index (every #flashcard line in the vault), the concepts the cards
// link to, and the operations that write to notes. The view only reads from
// here and calls save/create.

import { App, TFile, debounce, normalizePath } from "obsidian";
import { AnkiMap, SyncCard, hashContent, toAnkiText } from "./sync";
import {
  Card, CardEdit, ConnLink, parseCards, rewriteCard, replaceCard, appendCard, newCardLine,
  idsInText, newId, fieldValue, getField, parseLinks, safeAlias, plainValue, textLinks,
} from "./card";

export interface FieldNames {
  source: string;
  related: string;
  deck: string;
}

export interface AnkiSettings {
  url: string;
  model: string;
  frontField: string;
  backField: string;
  tag: string;
}

export const DEFAULT_ANKI: AnkiSettings = {
  url: "http://127.0.0.1:8765",
  model: "Basic",
  frontField: "Front",
  backField: "Back",
  tag: "flashcard-bank",
};

export type AnkiStatus = "none" | "pending" | "synced" | "changed" | "leaving";

export interface Settings {
  anki: AnkiSettings;
  ankiMap: AnkiMap;
  tag: string;
  exclude: string[];
  newPrefix: string;
  lastNote: string;
  fields: FieldNames;
  showMap: boolean;
  mapExpanded: boolean;
}

export const DEFAULT_FIELDS: FieldNames = { source: "Source", related: "Related", deck: "Deck" };

export const DEFAULT_SETTINGS: Settings = {
  tag: "#flashcard",
  exclude: [],
  newPrefix: "- ",
  lastNote: "",
  fields: { ...DEFAULT_FIELDS },
  anki: { ...DEFAULT_ANKI },
  ankiMap: {},
  showMap: false,
  mapExpanded: false,
};

export function cardKey(c: Card): string {
  return c.id ? c.path + "#^" + c.id : c.path + ":L" + c.line;
}

export function pathOfKey(key: string): string {
  const hash = key.indexOf("#^");
  return hash >= 0 ? key.slice(0, hash) : key.replace(/:L\d+$/, "");
}

/** A connection as the editor holds it: the target card, plus the original link text if it already existed. */
export interface Conn {
  key: string; // target card key, or "?" + raw for links that don't resolve to a card
  raw?: string;
}

export interface Related {
  key: string;
  card?: Card;
  here: boolean; // true: written on this card; false: written on the other card
  inText?: boolean; // the link sits in the question/answer, not in the Related field
  raw?: string;
}

/** A concept: a note linked from cards' questions or answers. */
export interface Concept {
  key: string; // the note's path, or "?" + lowercased name for a note that doesn't exist yet
  name: string; // what to show
  linkpath: string; // what to link to
  exists: boolean;
}

/** The other cards sharing one of a card's concepts. */
export interface ConceptGroup {
  concept: Concept;
  cards: Card[];
}

export interface Draft {
  q: string;
  a: string;
  source: string;
  deck: string;
  conns: Conn[];
}

export class SaveError extends Error {
  constructor(public kind: "changed" | "missing" | "nofile", msg: string) {
    super(msg);
  }
}

export class CardStore {
  byPath = new Map<string, Card[]>();
  private listeners: (() => void)[] = [];
  private incoming: Map<string, string[]> | null = null;
  private conceptIdx: { byCard: Map<string, Concept[]>; byConcept: Map<string, { concept: Concept; cards: string[] }> } | null = null;
  private notifySoon = debounce(() => this.listeners.forEach((l) => l()), 150, true);

  private changed(): void {
    this.incoming = null;
    this.conceptIdx = null;
    this.notifySoon();
  }

  /** A note was created, renamed or deleted: concept links may resolve differently now. */
  linksMayHaveChanged(): void {
    if (!this.byPath.size) return;
    this.changed();
  }

  constructor(private app: App, private settings: () => Settings) {}

  get f(): FieldNames {
    return { ...DEFAULT_FIELDS, ...this.settings().fields };
  }

  get order(): string[] {
    const f = this.f;
    return [f.source, f.related, f.deck];
  }

  onChange(cb: () => void): () => void {
    this.listeners.push(cb);
    return () => (this.listeners = this.listeners.filter((l) => l !== cb));
  }

  all(): Card[] {
    const out: Card[] = [];
    for (const list of this.byPath.values()) out.push(...list);
    return out;
  }

  get(key: string): Card | undefined {
    return (this.byPath.get(pathOfKey(key)) || []).find((c) => cardKey(c) === key);
  }

  excluded(path: string): boolean {
    return this.settings().exclude.some((f) => {
      const p = f.trim() ? normalizePath(f.trim()) : "";
      return p && (path === p || path.startsWith(p + "/"));
    });
  }

  private mayHaveCards(file: TFile): boolean {
    const tag = this.settings().tag.toLowerCase();
    const tags = this.app.metadataCache.getFileCache(file)?.tags;
    return !!tags && tags.some((t) => t.tag.toLowerCase() === tag);
  }

  async rebuild(): Promise<void> {
    const next = new Map<string, Card[]>();
    for (const f of this.app.vault.getMarkdownFiles()) {
      if (this.excluded(f.path) || !this.mayHaveCards(f)) continue;
      const cards = parseCards(await this.app.vault.cachedRead(f), f.path, this.settings().tag);
      if (cards.length) next.set(f.path, cards);
    }
    this.byPath = next;
    this.changed();
  }

  /** Re-read one note (called when Obsidian reports it changed). */
  async updateFile(file: TFile, data?: string): Promise<void> {
    if (file.extension !== "md") return;
    const had = this.byPath.has(file.path);
    if (this.excluded(file.path) || (!had && !this.mayHaveCards(file))) return;
    const text = data !== undefined ? data : await this.app.vault.cachedRead(file);
    const cards = parseCards(text, file.path, this.settings().tag);
    if (cards.length) this.byPath.set(file.path, cards);
    else this.byPath.delete(file.path);
    this.changed();
  }

  removePath(path: string): void {
    if (this.byPath.delete(path)) this.changed();
  }

  // ── Related cards (Related field and card links in the text, both directions) ──

  /** Links in the card's Related field (the ones the editor can change). */
  linksOf(c: Card): ConnLink[] {
    return parseLinks(fieldValue(c, this.f.related));
  }

  /** Every link from this card to another card: Related field first, then links to cards in the text. */
  private cardLinksOf(c: Card): { l: ConnLink; inText: boolean }[] {
    return this.linksOf(c).map((l) => ({ l, inText: false }))
      .concat(textLinks(c).cards.map((l) => ({ l, inText: true })));
  }

  /** Key of the card a link points to, if it points to one. */
  resolve(l: ConnLink, sourcePath: string): string | null {
    if (!l.blockId) return null;
    const f = this.app.metadataCache.getFirstLinkpathDest(l.linkpath, sourcePath);
    if (!f) return null;
    const key = f.path + "#^" + l.blockId;
    return this.get(key) ? key : null;
  }

  /** Links written on this card plus links other cards wrote to it. */
  relatedOf(c: Card): Related[] {
    const out: Related[] = [];
    const seen = new Set<string>([cardKey(c)]);
    for (const { l, inText } of this.cardLinksOf(c)) {
      const key = this.resolve(l, c.path);
      if (key) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, card: this.get(key), here: true, inText, raw: l.raw });
      } else if (!inText) out.push({ key: "?" + l.raw, here: true, raw: l.raw });
    }
    if (c.id) {
      for (const ok of this.incomingIndex().get(cardKey(c)) || []) {
        if (seen.has(ok)) continue;
        seen.add(ok);
        out.push({ key: ok, card: this.get(ok), here: false });
      }
    }
    return out;
  }

  /** target key → keys of the cards linking to it (Related field or text). Rebuilt lazily after any change. */
  private incomingIndex(): Map<string, string[]> {
    if (this.incoming) return this.incoming;
    const m = new Map<string, string[]>();
    for (const o of this.all()) {
      const ok = cardKey(o);
      for (const { l } of this.cardLinksOf(o)) {
        const t = this.resolve(l, o.path);
        if (!t || t === ok) continue;
        const list = m.get(t) || [];
        if (!list.includes(ok)) list.push(ok);
        m.set(t, list);
      }
    }
    this.incoming = m;
    return m;
  }

  // ── Concepts (links to notes in the question or answer) ───────────────────

  /** The concept a link points to. Resolved through Obsidian, so aliases and other spellings of an existing note match. */
  conceptOf(l: ConnLink, sourcePath: string): Concept {
    const f = this.app.metadataCache.getFirstLinkpathDest(l.linkpath, sourcePath);
    if (f) return { key: f.path, name: f.basename, linkpath: l.linkpath, exists: true };
    const name = l.linkpath.split("/").pop()!.replace(/\.md$/i, "").trim();
    return { key: "?" + name.toLowerCase(), name, linkpath: l.linkpath, exists: false };
  }

  /** Concepts in a question and answer (also used for an unsaved draft). */
  conceptsInText(q: string, a: string, sourcePath: string): Concept[] {
    const out: Concept[] = [];
    for (const l of textLinks({ q, a }).concepts) {
      const k = this.conceptOf(l, sourcePath);
      if (!out.some((x) => x.key === k.key)) out.push(k);
    }
    return out;
  }

  conceptsOf(c: Card): Concept[] {
    return this.conceptIndex().byCard.get(cardKey(c)) || [];
  }

  /** Every concept with the keys of the cards that mention it. */
  allConcepts(): { concept: Concept; cards: string[] }[] {
    return Array.from(this.conceptIndex().byConcept.values());
  }

  /** For each of the given concepts, the other cards that mention it. */
  relatedByConcept(concepts: Concept[], exclude: string | null): ConceptGroup[] {
    const idx = this.conceptIndex().byConcept;
    return concepts.map((concept) => ({
      concept,
      cards: (idx.get(concept.key)?.cards || []).filter((k) => k !== exclude).map((k) => this.get(k)).filter((x): x is Card => !!x),
    }));
  }

  private conceptIndex() {
    if (this.conceptIdx) return this.conceptIdx;
    const byCard = new Map<string, Concept[]>();
    const byConcept = new Map<string, { concept: Concept; cards: string[] }>();
    for (const c of this.all()) {
      const k = cardKey(c);
      const list = this.conceptsInText(c.q, c.a, c.path);
      byCard.set(k, list);
      for (const con of list) {
        const e = byConcept.get(con.key) || { concept: con, cards: [] };
        e.cards.push(k);
        byConcept.set(con.key, e);
      }
    }
    this.conceptIdx = { byCard, byConcept };
    return this.conceptIdx;
  }

  /** Sources of a card for filtering: each linked file, plus any plain text. */
  sourcesOf(c: Card): string[] {
    const v = fieldValue(c, this.f.source);
    if (!v) return [];
    const out = parseLinks(v).map((l) => l.linkpath);
    const rest = v.replace(/\[\[[^\]]*\]\]/g, "").replace(/^[\s,;]+|[\s,;]+$/g, "").trim();
    if (rest) out.push(rest);
    return out;
  }

  draftOf(c: Card): Draft {
    const f = this.f;
    return {
      q: c.q,
      a: c.a,
      source: fieldValue(c, f.source),
      deck: fieldValue(c, f.deck),
      conns: this.linksOf(c).map((l) => ({ key: this.resolve(l, c.path) || "?" + l.raw, raw: l.raw })),
    };
  }

  // ── Anki ─────────────────────────────────────────────────────────────────

  deckOf(c: Card): string {
    return plainValue(fieldValue(c, this.f.deck));
  }

  /** The card as the Anki sync sees it (null when it has no Deck or no block id). */
  syncCardOf(c: Card): SyncCard | null {
    const deck = this.deckOf(c);
    if (!deck || !c.id) return null;
    return { key: cardKey(c), id: c.id, q: c.q, deck, front: toAnkiText(c.q), back: toAnkiText(c.a) };
  }

  ankiStatus(c: Card): AnkiStatus {
    const entry = this.settings().ankiMap[cardKey(c)];
    const deck = this.deckOf(c);
    if (!deck) return entry ? "leaving" : "none";
    const sc = this.syncCardOf(c);
    if (!sc || !entry) return "pending";
    return entry.hash === hashContent(sc.front, sc.back) && entry.deck === sc.deck ? "synced" : "changed";
  }

  /** Give block ids to the given cards (one write per note). Returns how many got one. */
  async assignIds(cards: Card[]): Promise<number> {
    const byPath = new Map<string, Card[]>();
    cards.forEach((c) => byPath.set(c.path, (byPath.get(c.path) || []).concat(c)));
    let n = 0;
    for (const [path, list] of byPath) {
      const file = this.fileOf(path);
      await this.app.vault.process(file, (text) => {
        let out = text;
        const used = idsInText(text);
        for (const c of list) {
          const id = newId(used);
          const r = replaceCard(out, c, c.raw, rewriteCard(c, { q: c.q, a: c.a, fields: {}, order: this.order, newId: id }), this.settings().tag);
          if (r.ok) {
            out = r.text;
            n++;
          }
        }
        return out;
      });
      await this.updateFile(file, await this.app.vault.read(file));
    }
    return n;
  }

  // ── Writing ──────────────────────────────────────────────────────────────

  /**
   * Save an existing card. `original` is the card as it was when the editor
   * opened it; if its line changed in the note since then, nothing is written
   * and a SaveError("changed") is thrown.
   */
  async save(original: Card, draft: Draft, plannedIds: Map<string, string>): Promise<string> {
    const related = await this.prepareConns(original.path, original, draft.conns, plannedIds);
    const file = this.fileOf(original.path);
    const fields = this.fieldEdits(original, draft, related);
    let savedId = original.id;
    const failed: { error: SaveError | null } = { error: null };
    await this.app.vault.process(file, (text) => {
      const used = idsInText(text);
      let id: string | undefined;
      if (!original.id) {
        const planned = plannedIds.get(cardKey(original));
        id = planned && !used.has(planned) ? planned : newId(used);
      }
      const edit: CardEdit = { q: draft.q, a: draft.a, fields, order: this.order, newId: id };
      const r = replaceCard(text, original, original.raw, rewriteCard(original, edit), this.settings().tag);
      if (!r.ok) {
        failed.error = new SaveError(r.reason, r.reason === "changed"
          ? "The card changed in the note since you opened it. Nothing was saved; its current text was reloaded."
          : "The card wasn't found in the note. Nothing was saved.");
        return text;
      }
      if (id) savedId = id;
      return r.text;
    });
    if (failed.error) throw failed.error;
    return savedId ? original.path + "#^" + savedId : cardKey(original);
  }

  /** Create a card at the end of the note at `path`. */
  async create(path: string, draft: Draft, plannedIds: Map<string, string>): Promise<string> {
    const file = this.fileOf(path);
    const related = await this.prepareConns(path, null, draft.conns, plannedIds);
    const s = this.settings();
    const f = this.f;
    let id = "";
    await this.app.vault.process(file, (text) => {
      const used = idsInText(text);
      const planned = plannedIds.get("new");
      id = planned && !used.has(planned) ? planned : newId(used);
      const line = newCardLine(
        s.newPrefix, draft.q, draft.a,
        { [f.source]: draft.source, [f.related]: related ?? "", [f.deck]: draft.deck },
        this.order, s.tag, id
      );
      return appendCard(text, line);
    });
    return path + "#^" + id;
  }

  /** Field values to write. Fields the card lacks are only added when non-empty. */
  private fieldEdits(c: Card, d: Draft, related: string | null): Record<string, string> {
    const f = this.f;
    const out: Record<string, string> = {};
    const put = (name: string, v: string) => {
      if (getField(c, name) || v.trim()) out[name] = v;
    };
    put(f.source, d.source);
    put(f.deck, d.deck);
    if (related !== null) put(f.related, related);
    return out;
  }

  /**
   * Make sure every connected card has a block id (writing one into its note
   * if needed) and build the Related value. Returns null when the list is
   * unchanged, so the field is left exactly as it was.
   */
  private async prepareConns(sourcePath: string, original: Card | null, conns: Conn[], plannedIds: Map<string, string>): Promise<string | null> {
    if (original) {
      const before = this.linksOf(original).map((l) => l.raw);
      const after = conns.map((c) => c.raw || "");
      if (before.length === after.length && before.every((r, i) => r === after[i])) return null;
    }
    const parts: string[] = [];
    for (const conn of conns) {
      if (conn.raw) {
        parts.push(conn.raw);
        continue;
      }
      const target = this.get(conn.key);
      if (!target) continue;
      let id = target.id;
      if (!id) id = await this.giveId(target, plannedIds.get(conn.key));
      const file = this.fileOf(target.path);
      const linktext = this.app.metadataCache.fileToLinktext(file, sourcePath, true);
      parts.push("[[" + linktext + "#^" + id + "|" + safeAlias(target.q) + "]]");
    }
    return parts.join(", ");
  }

  /** Add a block id to a card that has none. */
  private async giveId(target: Card, planned?: string): Promise<string> {
    const file = this.fileOf(target.path);
    let id = "";
    const failed: { error: SaveError | null } = { error: null };
    await this.app.vault.process(file, (text) => {
      const used = idsInText(text);
      id = planned && !used.has(planned) ? planned : newId(used);
      const out = rewriteCard(target, { q: target.q, a: target.a, fields: {}, order: this.order, newId: id });
      const r = replaceCard(text, target, target.raw, out, this.settings().tag);
      if (!r.ok) {
        failed.error = new SaveError(r.reason, "Couldn't give an id to “" + target.q + "”: the card changed in its note. Nothing was saved.");
        return text;
      }
      return r.text;
    });
    if (failed.error) throw failed.error;
    await this.updateFile(file, await this.app.vault.read(file));
    return id;
  }

  fileOf(path: string): TFile {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) throw new SaveError("nofile", "Note not found: " + path);
    return f;
  }
}
