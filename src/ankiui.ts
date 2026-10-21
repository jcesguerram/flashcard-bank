// The "Sync with Anki" flow: read Anki, show what will happen, apply on confirm.
// Only one sync runs at a time (see FlashcardBankPlugin.syncAnki); a notice shows
// what it's doing until it finishes.

import { App, Modal, Notice } from "obsidian";
import { Plan, planIsEmpty, planSync, readAnki, runSync, SyncCard } from "./sync";
import { cardKey, pathOfKey } from "./store";
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

/** A notice that stays up while the sync works, and can change its text. */
class Progress {
  private notice: Notice | null = null;

  show(text: string): void {
    if (this.notice) this.notice.setMessage(text);
    else this.notice = new Notice(text, 0);
  }

  hide(): void {
    this.notice?.hide();
    this.notice = null;
  }
}

/**
 * Run one sync. Returns true when something may have been written (to Anki, to
 * the plugin's register, or block ids to notes), so the caller knows whether
 * the bank needs refreshing.
 */
export async function syncWithAnki(plugin: FlashcardBankPlugin): Promise<boolean> {
  const s = plugin.settings;
  const api = plugin.anki;
  const progress = new Progress();
  let { cards, known, noId } = gather(plugin);

  let state;
  try {
    progress.show("Anki: reading your collection…");
    const models: string[] = await api.call("modelNames");
    if (!models.includes(s.anki.model)) {
      progress.hide();
      new Notice("The note type “" + s.anki.model + "” doesn't exist in Anki. Pick one in the plugin settings.", 8000);
      return false;
    }
    const fields: string[] = await api.call("modelFieldNames", { modelName: s.anki.model });
    for (const f of [s.anki.frontField, s.anki.backField]) {
      if (!fields.includes(f)) {
        progress.hide();
        new Notice("The note type “" + s.anki.model + "” has no field “" + f + "”. Check the plugin settings.", 8000);
        return false;
      }
    }
    state = await readAnki(api, s.ankiMap, s.anki.tag, s.anki.frontField);
  } catch (e) {
    progress.hide();
    new Notice((e as Error).message, 8000);
    return false;
  }
  progress.hide();

  const plan = planSync(cards, known, s.ankiMap, state.notes, state.tagged);
  if (planIsEmpty(plan) && !noId.length) {
    const extra = [
      plan.protectedNotes.length ? plan.protectedNotes.length + " without the tag (left untouched)" : "",
      plan.orphans.length ? plan.orphans.length + " with the tag that the plugin doesn't recognize (left untouched)" : "",
    ].filter(Boolean);
    new Notice("Anki is up to date." + (extra.length ? " Notes: " + extra.join("; ") + "." : ""));
    return false;
  }

  const go = await new SyncModal(plugin.app, plan, noId).ask();
  if (!go) return false;

  try {
    if (noId.length) {
      progress.show("Anki: giving ids to " + plural(noId.length, "card") + "…");
      await plugin.store.assignIds(noId);
    }
    // Plan again from a fresh read of the vault and of Anki: the summary may
    // have stayed open for a while, and Anki or the notes may have changed.
    progress.show("Anki: checking your collection again…");
    ({ cards, known } = gather(plugin));
    state = await readAnki(api, s.ankiMap, s.anki.tag, s.anki.frontField);
    const final = planSync(cards, known, s.ankiMap, state.notes, state.tagged);
    // Never delete anything that wasn't in the confirmed summary.
    const confirmed = new Set(plan.remove.map((r) => r.key));
    final.remove = final.remove.filter((r) => confirmed.has(r.key));
    const res = await runSync(api, final, s.ankiMap, state.notes, s.anki, (done, total) => {
      progress.show("Anki: syncing… " + done + " of " + total);
    });
    await plugin.saveSettings();
    progress.hide();
    const parts = [
      res.created ? res.created + " created" : "",
      res.updated ? res.updated + " updated" : "",
      res.removed ? res.removed + " deleted" : "",
    ].filter(Boolean);
    if (res.errors.length) {
      await plugin.appendLog("Anki sync: " + res.errors.length + " failed", res.errors);
      new SyncErrorsModal(
        plugin.app,
        "Anki sync: some cards failed",
        "Done in Anki: " + (parts.join(", ") || "nothing") + ". The cards below failed; the next sync tries them again. The details are also in error.log in the plugin folder.",
        res.errors
      ).open();
    } else {
      new Notice("Anki: " + (parts.join(", ") || "no changes") + ".", 8000);
    }
  } catch (e) {
    try {
      await plugin.saveSettings(); // keep what finished before the interruption
    } catch (e2) {
      await plugin.appendLog("Anki sync: couldn't save the register", [(e2 as Error).message]);
    }
    await plugin.appendLog("Anki sync interrupted", [(e as Error).message]);
    new SyncErrorsModal(
      plugin.app,
      "Anki sync interrupted",
      "The sync stopped before it finished. What was done in Anki before that is kept and remembered; run the sync again to finish. The details are also in error.log in the plugin folder.",
      [(e as Error).message]
    ).open();
  } finally {
    progress.hide();
  }
  return true;
}

function plural(n: number, word: string): string {
  return n + " " + word + (n === 1 ? "" : "s");
}

function noteOf(key: string): string {
  return pathOfKey(key).split("/").pop()!.replace(/\.md$/, "");
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
    // Created and deleted cards are listed in full: they're what opts a card in, or removes review history.
    const create = p.create.map((c) => ({ text: c.q, note: noteOf(c.key) }))
      .concat(this.noId.map((c) => ({ text: plainValue(c.q) + " (will get an id)", note: noteOf(c.path) })));
    this.section(el, "Will be created in Anki", create, "", true);
    this.section(el, "Will be updated", p.update.map((u) => ({
      text: u.card.q + " — " + [u.fields ? "content" : "", u.deck ? "deck → " + u.card.deck : "", u.fromKey && !u.fields && !u.deck ? "moved to another note" : ""].filter(Boolean).join(", "),
      note: noteOf(u.card.key),
    })));
    this.section(el, "Will be re-created (their Anki note no longer exists)", p.recreate.map((c) => ({ text: c.q, note: noteOf(c.key) })));
    // Cards going to Anki without an answer: they're synced, but their back will be empty.
    const blank = p.create.concat(p.recreate, p.update.filter((u) => u.fields).map((u) => u.card))
      .filter((c) => !c.back.trim())
      .map((c) => ({ text: c.q, note: noteOf(c.key) }))
      .concat(this.noId.filter((c) => !c.a.trim()).map((c) => ({ text: plainValue(c.q), note: noteOf(c.path) })));
    const warn = this.section(el, "No answer yet: their back in Anki will be empty", blank, "is-warning", true);
    warn?.addClass("bt-sync-warn");
    if (p.remove.length) {
      const items = p.remove.map((r) => ({
        text: r.q + (r.reason === "no-deck" ? " — its Deck was cleared" : " — no longer in Obsidian"),
        note: (r.reason === "no-deck" ? "" : "was in ") + noteOf(r.key),
      }));
      const box = this.section(el, "Will be deleted from Anki, with their review history", items, "is-danger", true);
      box?.addClass("bt-sync-danger");
    }
    if (p.protectedNotes.length) this.section(el, "Left untouched: they no longer carry the plugin's tag in Anki", p.protectedNotes.map((x) => ({ text: x.q, note: noteOf(x.key) })), "is-muted");
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

  /** A titled list. `full` lists every item (in a scrolling box); otherwise the first 12. */
  private section(el: HTMLElement, title: string, items: { text: string; note: string }[], cls = "", full = false): HTMLElement | null {
    if (!items.length) return null;
    const box = el.createDiv({ cls: "bt-sync-section " + cls + (full ? " is-full" : "") });
    box.createDiv({ cls: "bt-sync-title", text: title + " · " + items.length });
    const ul = box.createEl("ul");
    const shown = full ? items : items.slice(0, 12);
    for (const it of shown) {
      const li = ul.createEl("li", { text: it.text });
      if (it.note) li.createSpan({ cls: "bt-sync-where", text: " · " + it.note });
    }
    if (!full && items.length > 12) ul.createEl("li", { cls: "bt-sync-more", text: "and " + (items.length - 12) + " more" });
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

/** What went wrong in a sync, card by card, with a way to copy it. */
class SyncErrorsModal extends Modal {
  constructor(app: App, private title: string, private summary: string, private errors: string[]) {
    super(app);
  }

  onOpen(): void {
    const el = this.contentEl;
    el.empty();
    el.addClass("bt-sync-modal");
    el.createEl("h3", { text: this.title });
    el.createEl("p", { cls: "bt-sync-note", text: this.summary });
    const box = el.createDiv({ cls: "bt-sync-section is-full is-danger bt-sync-danger" });
    box.createDiv({ cls: "bt-sync-title", text: (this.errors.length === 1 ? "Error" : "Errors") + " · " + this.errors.length });
    const ul = box.createEl("ul");
    for (const e of this.errors) ul.createEl("li", { text: e });
    const btns = el.createDiv({ cls: "bt-sync-buttons" });
    const copy = btns.createEl("button", { text: "Copy" });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.errors.join("\n")).then(() => copy.setText("Copied"));
    });
    const ok = btns.createEl("button", { cls: "mod-cta", text: "Close" });
    ok.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
