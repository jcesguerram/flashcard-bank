// The "Sync with Anki" flow: read Anki, show what will happen, apply on confirm.

import { App, Modal, Notice } from "obsidian";
import { Plan, planIsEmpty, planSync, readAnki, runSync, SyncCard } from "./sync";
import { cardKey } from "./store";
import { plainValue, type Card } from "./card";
import type FlashcardBankPlugin from "./main";

function gather(plugin: FlashcardBankPlugin) {
  const store = plugin.store;
  const all = store.all();
  const withDeck = all.filter((c) => store.deckOf(c));
  const noId = withDeck.filter((c) => !c.id);
  const cards = withDeck.map((c) => store.syncCardOf(c)).filter((x): x is SyncCard => !!x);
  const known = new Map<string, string>(all.filter((c) => c.id).map((c) => [cardKey(c), plainValue(c.q)] as [string, string]));
  return { cards, known, noId };
}

export async function syncWithAnki(plugin: FlashcardBankPlugin): Promise<void> {
  const s = plugin.settings;
  const api = plugin.anki;
  let { cards, known, noId } = gather(plugin);

  let state;
  try {
    const models: string[] = await api.call("modelNames");
    if (!models.includes(s.anki.model)) {
      new Notice("The note type “" + s.anki.model + "” doesn't exist in Anki. Pick one in the plugin settings.", 8000);
      return;
    }
    const fields: string[] = await api.call("modelFieldNames", { modelName: s.anki.model });
    for (const f of [s.anki.frontField, s.anki.backField]) {
      if (!fields.includes(f)) {
        new Notice("The note type “" + s.anki.model + "” has no field “" + f + "”. Check the plugin settings.", 8000);
        return;
      }
    }
    state = await readAnki(api, s.ankiMap, s.anki.tag);
  } catch (e) {
    new Notice((e as Error).message, 8000);
    return;
  }

  const plan = planSync(cards, known, s.ankiMap, state.notes, state.tagged);
  if (planIsEmpty(plan) && !noId.length) {
    const extra = [
      plan.protectedNotes.length ? plan.protectedNotes.length + " without the tag (left untouched)" : "",
      plan.orphans.length ? plan.orphans.length + " with the tag that the plugin doesn't recognize (left untouched)" : "",
    ].filter(Boolean);
    new Notice("Anki is up to date." + (extra.length ? " Notes: " + extra.join("; ") + "." : ""));
    return;
  }

  const go = await new SyncModal(plugin.app, plan, noId).ask();
  if (!go) return;

  try {
    if (noId.length) {
      await plugin.store.assignIds(noId);
      ({ cards, known } = gather(plugin));
      state = await readAnki(api, s.ankiMap, s.anki.tag);
    }
    const final = planSync(cards, known, s.ankiMap, state.notes, state.tagged);
    // Never delete anything that wasn't in the confirmed summary.
    const confirmed = new Set(plan.remove.map((r) => r.key));
    final.remove = final.remove.filter((r) => confirmed.has(r.key));
    const res = await runSync(api, final, s.ankiMap, state.notes, s.anki);
    await plugin.saveSettings();
    const parts = [
      res.created ? res.created + " created" : "",
      res.updated ? res.updated + " updated" : "",
      res.removed ? res.removed + " deleted" : "",
    ].filter(Boolean);
    new Notice("Anki: " + (parts.join(", ") || "no changes") + (res.errors.length ? ". " + res.errors.length + " failed (see console)." : "."), 8000);
    if (res.errors.length) console.warn("[flashcard-bank] sync errors:\n" + res.errors.join("\n"));
  } catch (e) {
    await plugin.saveSettings();
    new Notice("The sync was interrupted: " + (e as Error).message, 8000);
  }
}

class SyncModal extends Modal {
  private resolve!: (v: boolean) => void;
  private done = false;

  constructor(app: App, private plan: Plan, private noId: Card[]) {
    super(app);
  }

  ask(): Promise<boolean> {
    return new Promise((r) => {
      this.resolve = r;
      this.open();
    });
  }

  onOpen(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("bt-sync-modal");
    el.createEl("h3", { text: "Sync with Anki" });
    const p = this.plan;
    const create = p.create.map((c) => c.q).concat(this.noId.map((c) => plainValue(c.q) + " (will get an id)"));
    this.section(el, "Will be created in Anki", create);
    this.section(el, "Will be updated", p.update.map((u) => u.card.q + " — " + [u.fields ? "content" : "", u.deck ? "deck → " + u.card.deck : "", u.fromKey && !u.fields && !u.deck ? "moved to another note" : ""].filter(Boolean).join(", ")));
    this.section(el, "Will be re-created (their Anki note no longer exists)", p.recreate.map((c) => c.q));
    if (p.remove.length) {
      const box = this.section(el, "Will be deleted from Anki, with their review history", p.remove.map((r) => r.q + (r.reason === "no-deck" ? " — its Deck was cleared" : " — no longer in Obsidian")), "is-danger");
      box?.addClass("bt-sync-danger");
    }
    if (p.protectedNotes.length) this.section(el, "Left untouched: they no longer carry the plugin's tag in Anki", p.protectedNotes.map((x) => x.q), "is-muted");
    if (p.orphans.length) {
      el.createEl("p", { cls: "bt-sync-note", text: p.orphans.length + " note(s) in Anki carry the plugin's tag but aren't in its register. They're left untouched." });
    }
    if (this.noId.length) {
      el.createEl("p", { cls: "bt-sync-note", text: this.noId.length + " card(s) with a Deck have no id: one will be written into their note before syncing." });
    }
    const btns = el.createDiv({ cls: "bt-sync-buttons" });
    const cancel = btns.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.finish(false));
    const ok = btns.createEl("button", { cls: "mod-cta" + (p.remove.length ? " mod-warning" : ""), text: p.remove.length ? "Sync and delete " + p.remove.length : "Sync" });
    ok.addEventListener("click", () => this.finish(true));
  }

  private section(el: HTMLElement, title: string, items: string[], cls = ""): HTMLElement | null {
    if (!items.length) return null;
    const box = el.createDiv({ cls: "bt-sync-section " + cls });
    box.createDiv({ cls: "bt-sync-title", text: title + " · " + items.length });
    const ul = box.createEl("ul");
    items.slice(0, 12).forEach((t) => ul.createEl("li", { text: t }));
    if (items.length > 12) ul.createEl("li", { cls: "bt-sync-more", text: "and " + (items.length - 12) + " more" });
    return box;
  }

  private finish(v: boolean): void {
    if (this.done) return;
    this.done = true;
    this.resolve(v);
    this.close();
  }

  onClose(): void {
    if (!this.done) {
      this.done = true;
      this.resolve(false);
    }
    this.contentEl.empty();
  }
}
