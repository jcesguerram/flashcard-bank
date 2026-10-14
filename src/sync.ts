// Anki sync logic: what a sync would do (plan) and doing it (run). No Obsidian
// imports, so it's testable with a fake AnkiConnect.
//
// Ringfencing: the plugin only updates or deletes Anki notes that are BOTH in
// its own map (card key → note id) AND still carry its tag in Anki. Anything
// else in Anki is never touched.

export interface AnkiApi {
  call<T = unknown>(action: string, params?: Record<string, unknown>): Promise<T>;
}

/** What the plugin remembers about a synced card. */
export interface MapEntry {
  noteId: number;
  id: string; // block id of the card
  deck: string;
  hash: string; // of the content last sent
}

export type AnkiMap = Record<string, MapEntry>; // card key (path#^id) → entry

/** A card as the sync sees it. */
export interface SyncCard {
  key: string; // path#^id
  id: string;
  q: string; // plain question (for summaries)
  deck: string;
  front: string; // HTML sent to Anki
  back: string;
}

export interface NoteState {
  exists: boolean;
  tagged: boolean;
  deck: string | null;
  cards: number[];
}

export interface Plan {
  create: SyncCard[];
  update: { card: SyncCard; entry: MapEntry; fields: boolean; deck: boolean; fromKey?: string }[];
  recreate: SyncCard[]; // was synced, but the Anki note no longer exists
  remove: { key: string; entry: MapEntry; q: string; reason: "deleted" | "no-deck" }[];
  forget: string[]; // map entries to drop without touching Anki (note already gone)
  protectedNotes: { key: string; entry: MapEntry; q: string }[]; // in the map but untagged in Anki: never touched
  orphans: number[]; // tagged notes in Anki that aren't in the map: never touched
  unchanged: number;
}

export function hashContent(front: string, back: string): string {
  let h = 5381;
  const s = front + "\u0001" + back;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Plain text for Anki: wikilinks become their alias (or note name). */
export function toAnkiText(s: string): string {
  const plain = s.replace(/\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_m, t: string, al?: string) => al || (t.split("#")[0] ?? ""));
  return escapeHtml(plain.trim());
}

/**
 * Work out what a sync would do.
 * @param cards   cards that should be in Anki (have a Deck and a block id)
 * @param known   every card key currently in the vault, with its question (to tell "deck removed" from "card deleted")
 * @param map     the plugin's memory of synced cards
 * @param notes   state in Anki of every note id in the map
 * @param tagged  every note id in Anki carrying the plugin's tag
 */
export function planSync(
  cards: SyncCard[],
  known: Map<string, string>,
  map: AnkiMap,
  notes: Map<number, NoteState>,
  tagged: number[]
): Plan {
  const plan: Plan = { create: [], update: [], recreate: [], remove: [], forget: [], protectedNotes: [], orphans: [], unchanged: 0 };
  const wanted = new Map(cards.map((c) => [c.key, c]));
  const claimed = new Set<string>(); // map keys taken over by a moved card

  // Cards whose key isn't in the map may be a card that moved to another note
  // (same block id, same content): reuse that entry instead of creating anew.
  const movedFrom = new Map<string, string>();
  for (const c of cards) {
    if (map[c.key]) continue;
    const hash = hashContent(c.front, c.back);
    const from = Object.keys(map).find((k) => !wanted.has(k) && !known.has(k) && !claimed.has(k) && map[k]?.id === c.id && map[k]?.hash === hash);
    if (from) {
      movedFrom.set(c.key, from);
      claimed.add(from);
    }
  }

  for (const c of cards) {
    const fromKey = movedFrom.get(c.key);
    const entry = map[c.key] || (fromKey ? map[fromKey] : undefined);
    if (!entry) {
      plan.create.push(c);
      continue;
    }
    const st = notes.get(entry.noteId);
    if (!st || !st.exists) {
      plan.recreate.push(c);
      if (fromKey) plan.forget.push(fromKey);
      continue;
    }
    if (!st.tagged) {
      plan.protectedNotes.push({ key: fromKey || c.key, entry, q: c.q });
      continue;
    }
    const fields = entry.hash !== hashContent(c.front, c.back);
    const deck = (st.deck ?? entry.deck) !== c.deck;
    if (fields || deck || fromKey) plan.update.push({ card: c, entry, fields, deck, fromKey });
    else plan.unchanged++;
  }

  for (const [key, entry] of Object.entries(map)) {
    if (wanted.has(key) || claimed.has(key)) continue;
    const st = notes.get(entry.noteId);
    const q = known.get(key) || "(card deleted in Obsidian)";
    if (!st || !st.exists) plan.forget.push(key);
    else if (!st.tagged) plan.protectedNotes.push({ key, entry, q });
    else plan.remove.push({ key, entry, q, reason: known.has(key) ? "no-deck" : "deleted" });
  }

  const mapped = new Set(Object.values(map).map((e) => e.noteId));
  plan.orphans = tagged.filter((id) => !mapped.has(id));
  return plan;
}

export function planIsEmpty(p: Plan): boolean {
  return !p.create.length && !p.update.length && !p.recreate.length && !p.remove.length && !p.forget.length;
}

/** Read from Anki what planSync needs. */
export async function readAnki(api: AnkiApi, map: AnkiMap, tag: string): Promise<{ notes: Map<number, NoteState>; tagged: number[] }> {
  const ids = Array.from(new Set(Object.values(map).map((e) => e.noteId)));
  const notes = new Map<number, NoteState>();
  if (ids.length) {
    // AnkiConnect answers one entry per id, in order; an empty object for a note that no longer exists.
    const info = await api.call<({ noteId?: number; tags?: string[]; cards?: number[] } | null)[]>("notesInfo", { notes: ids });
    const firstCards: number[] = [];
    ids.forEach((id, i) => {
      const n = info[i];
      const exists = !!n && typeof n.noteId === "number";
      const st: NoteState = { exists, tagged: exists && (n.tags || []).includes(tag), deck: null, cards: exists ? n.cards || [] : [] };
      notes.set(id, st);
      if (st.cards[0] !== undefined) firstCards.push(st.cards[0]);
    });
    if (firstCards.length) {
      const cinfo = await api.call<({ cardId?: number; deckName?: string } | null)[]>("cardsInfo", { cards: firstCards });
      const deckOfCard = new Map<number, string>();
      for (const c of cinfo) if (c && typeof c.cardId === "number" && typeof c.deckName === "string") deckOfCard.set(c.cardId, c.deckName);
      for (const st of notes.values()) if (st.cards[0] !== undefined) st.deck = deckOfCard.get(st.cards[0]) ?? null;
    }
  }
  const tagged = await api.call<number[]>("findNotes", { query: "tag:" + tag });
  return { notes, tagged };
}

export interface RunOptions {
  model: string;
  frontField: string;
  backField: string;
  tag: string;
}

export interface RunResult {
  created: number;
  updated: number;
  removed: number;
  errors: string[];
}

/**
 * Apply a plan. `map` is updated in place as each step succeeds, so a failure
 * halfway leaves it consistent with what actually happened in Anki.
 */
export async function runSync(api: AnkiApi, plan: Plan, map: AnkiMap, notes: Map<number, NoteState>, opt: RunOptions): Promise<RunResult> {
  const res: RunResult = { created: 0, updated: 0, removed: 0, errors: [] };
  const decks = new Set<string>();
  plan.create.concat(plan.recreate).forEach((c) => decks.add(c.deck));
  plan.update.filter((u) => u.deck).forEach((u) => decks.add(u.card.deck));
  for (const d of decks) {
    try {
      await api.call("createDeck", { deck: d });
    } catch (e) {
      res.errors.push(`Couldn't create the deck “${d}”: ${(e as Error).message}`);
    }
  }

  for (const c of plan.create.concat(plan.recreate)) {
    try {
      const noteId: number = await api.call("addNote", {
        note: {
          deckName: c.deck,
          modelName: opt.model,
          fields: { [opt.frontField]: c.front, [opt.backField]: c.back },
          tags: [opt.tag],
          options: { allowDuplicate: true },
        },
      });
      map[c.key] = { noteId, id: c.id, deck: c.deck, hash: hashContent(c.front, c.back) };
      res.created++;
    } catch (e) {
      res.errors.push(`“${c.q}”: ${(e as Error).message}`);
    }
  }

  for (const u of plan.update) {
    try {
      if (u.fields) {
        await api.call("updateNoteFields", { note: { id: u.entry.noteId, fields: { [opt.frontField]: u.card.front, [opt.backField]: u.card.back } } });
      }
      if (u.deck) {
        const cards = notes.get(u.entry.noteId)?.cards || [];
        if (cards.length) await api.call("changeDeck", { cards, deck: u.card.deck });
      }
      if (u.fromKey) delete map[u.fromKey];
      map[u.card.key] = { noteId: u.entry.noteId, id: u.card.id, deck: u.card.deck, hash: hashContent(u.card.front, u.card.back) };
      res.updated++;
    } catch (e) {
      res.errors.push(`“${u.card.q}”: ${(e as Error).message}`);
    }
  }

  if (plan.remove.length) {
    try {
      await api.call("deleteNotes", { notes: plan.remove.map((r) => r.entry.noteId) });
      plan.remove.forEach((r) => delete map[r.key]);
      res.removed += plan.remove.length;
    } catch (e) {
      res.errors.push("Couldn't delete notes in Anki: " + (e as Error).message);
    }
  }
  plan.forget.forEach((k) => delete map[k]);
  return res;
}
