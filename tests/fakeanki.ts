// An in-memory stand-in for AnkiConnect, for tests and the UI harness.
import type { AnkiApi } from "../src/sync";

export interface FakeNote { noteId: number; fields: Record<string, string>; tags: string[]; cards: number[]; deck: string; model: string }

export class FakeAnki implements AnkiApi {
  notes = new Map<number, FakeNote>();
  decks = new Set<string>(["Default"]);
  models: Record<string, string[]> = { "Básico": ["Anverso", "Reverso"], Basic: ["Front", "Back"] };
  calls: string[] = [];
  private next = 1000;
  down = false;

  async call<T = any>(action: string, p: any = {}): Promise<T> {
    if (this.down) throw new Error("No se pudo conectar con Anki. ¿Está abierto, con AnkiConnect instalado?");
    this.calls.push(action);
    const r = this.run(action, p);
    return JSON.parse(JSON.stringify(r)) as T;
  }

  private run(action: string, p: any): any {
    switch (action) {
      case "version": return 6;
      case "deckNames": return Array.from(this.decks);
      case "modelNames": return Object.keys(this.models);
      case "modelFieldNames": return this.models[p.modelName] || [];
      case "createDeck": this.decks.add(p.deck); return 1;
      case "addNote": {
        const n = p.note;
        if (!this.models[n.modelName]) throw new Error("model was not found: " + n.modelName);
        if (!this.decks.has(n.deckName)) throw new Error("deck was not found: " + n.deckName);
        const id = ++this.next;
        this.notes.set(id, { noteId: id, fields: { ...n.fields }, tags: [...(n.tags || [])], cards: [id * 10], deck: n.deckName, model: n.modelName });
        return id;
      }
      case "notesInfo": return p.notes.map((id: number) => {
        const n = this.notes.get(id);
        if (!n) return {};
        const fields: any = {};
        for (const k in n.fields) fields[k] = { value: n.fields[k], order: 0 };
        return { noteId: n.noteId, tags: n.tags, cards: n.cards, fields, modelName: n.model };
      });
      case "cardsInfo": return p.cards.map((cid: number) => {
        for (const n of this.notes.values()) if (n.cards.includes(cid)) return { cardId: cid, deckName: n.deck, note: n.noteId };
        return {};
      });
      case "findNotes": {
        const m = String(p.query).match(/^tag:(.+)$/);
        return Array.from(this.notes.values()).filter((n) => m && n.tags.includes(m[1])).map((n) => n.noteId);
      }
      case "updateNoteFields": {
        const n = this.notes.get(p.note.id);
        if (!n) throw new Error("note was not found: " + p.note.id);
        Object.assign(n.fields, p.note.fields);
        return null;
      }
      case "changeDeck": {
        for (const n of this.notes.values()) if (n.cards.some((c) => p.cards.includes(c))) n.deck = p.deck;
        return null;
      }
      case "deleteNotes": p.notes.forEach((id: number) => this.notes.delete(id)); return null;
      default: throw new Error("unsupported action: " + action);
    }
  }
}
