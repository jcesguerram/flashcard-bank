// The "Flashcard Bank" tab: concepts list, card list, editor and concept map.

import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import { Card, rewriteCard, newCardLine, plainValue, safeAlias, newId, parseLinks } from "./card";
import { CardStore, Concept, Draft, SaveError, cardKey, pathOfKey } from "./store";
import { InlineSuggest } from "./suggest";
import { drawConceptMap } from "./map";
import type FlashcardBankPlugin from "./main";

export const VIEW_TYPE = "flashcard-bank";
const NO_CONCEPT = "\u0000no-concept";

export class BankView extends ItemView {
  private store: CardStore;
  private unsubscribe: (() => void) | null = null;

  // filters
  private query = "";
  private concept = ""; // concept key, NO_CONCEPT, or "" for all
  private source = "";
  private note = "";

  // editor state
  private selKey: string | null = null; // card being edited, or "new"
  private original: Card | null = null; // snapshot of the card when opened
  private draft: Draft | null = null;
  private dirty = false;
  private discardArmed: string | null = null;
  private newNote = "";
  private plannedIds = new Map<string, string>();
  private saving = false;

  // elements
  private conceptsEl!: HTMLElement;
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private mapEl!: HTMLElement;
  private editorEl!: HTMLElement;
  private sourceSel!: HTMLSelectElement;
  private noteSel!: HTMLSelectElement;
  private bodyEl!: HTMLElement;
  private mapBtn!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, private plugin: FlashcardBankPlugin) {
    super(leaf);
    this.store = plugin.store;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Flashcard bank"; }
  getIcon() { return "layers"; }

  private get cfg() { return this.plugin.settings; }
  private get fieldNames() { return this.store.f; }

  async onOpen() {
    try {
      this.buildView();
    } catch (e) {
      this.showError("while opening", e);
    }
  }

  /** Show an unexpected error inside the tab (and log it) instead of leaving it blank. */
  private showError(where: string, e: unknown): void {
    void this.plugin.logError("view " + where, e);
    const box = this.contentEl.createDiv({ cls: "bt-fatal" });
    box.createEl("h3", { text: "Flashcard Bank: error " + where });
    box.createEl("pre", { text: (e as Error)?.stack || String(e) });
    box.createEl("p", { text: "The details were saved to error.log in the plugin folder." });
  }

  private buildView(): void {
    const root = this.contentEl;
    root.empty();
    root.addClass("bt-root");

    const bar = root.createDiv({ cls: "bt-bar" });
    const search = bar.createEl("input", { type: "search", placeholder: "Search questions, answers and fields", cls: "bt-search" });
    search.addEventListener("input", () => { this.query = search.value; this.renderList(); });
    // Each filter dropdown gets a small caption above it.
    const filter = (label: string): HTMLSelectElement => {
      const wrap = bar.createEl("label", { cls: "bt-filter-wrap" });
      wrap.createSpan({ cls: "bt-filter-label", text: label });
      return wrap.createEl("select", { cls: "dropdown bt-filter" });
    };
    this.sourceSel = filter("Filter by source");
    this.sourceSel.addEventListener("change", () => { this.source = this.sourceSel.value; this.renderList(); });
    this.noteSel = filter("Filter by note");
    this.noteSel.addEventListener("change", () => { this.note = this.noteSel.value; this.renderList(); });
    this.mapBtn = bar.createEl("button", { cls: "bt-map-btn" });
    setIcon(this.mapBtn.createSpan(), "network");
    this.mapBtn.createSpan({ text: "Map" });
    this.mapBtn.addEventListener("click", () => this.toggleMap());
    const ab = bar.createEl("button", { cls: "bt-anki-btn", attr: { "aria-label": "Sync with Anki" } });
    setIcon(ab.createSpan(), "refresh-cw");
    ab.createSpan({ text: "Anki" });
    ab.addEventListener("click", () => { void this.plugin.syncAnki(); });
    const nb = bar.createEl("button", { cls: "mod-cta bt-new" });
    setIcon(nb.createSpan(), "plus");
    nb.createSpan({ text: "New card" });
    nb.addEventListener("click", () => this.startNew());

    this.bodyEl = root.createDiv({ cls: "bt-body" });
    const treeCol = this.bodyEl.createDiv({ cls: "bt-tree-col" });
    treeCol.createDiv({ cls: "bt-col-title", text: "Concepts" });
    this.conceptsEl = treeCol.createDiv({ cls: "bt-tree" });
    const listCol = this.bodyEl.createDiv({ cls: "bt-list-col" });
    this.countEl = listCol.createDiv({ cls: "bt-count" });
    this.listEl = listCol.createDiv({ cls: "bt-list" });
    this.mapEl = listCol.createDiv({ cls: "bt-map" });
    this.editorEl = this.bodyEl.createDiv({ cls: "bt-editor" });

    const ro = new ResizeObserver(() => this.bodyEl.toggleClass("bt-narrow", this.bodyEl.clientWidth < 760));
    ro.observe(this.bodyEl);
    this.register(() => ro.disconnect());

    this.unsubscribe = this.store.onChange(() => {
      try {
        this.onStoreChange();
      } catch (e) {
        this.showError("while updating", e);
      }
    });
    this.syncToolbar();
    this.renderAll();
  }

  async onClose() {
    this.unsubscribe?.();
  }

  private syncToolbar(): void {
    this.mapBtn.toggleClass("is-active", this.cfg.showMap);
    this.bodyEl.toggleClass("has-map", this.cfg.showMap);
    this.bodyEl.toggleClass("map-expanded", this.cfg.showMap && this.cfg.mapExpanded);
  }

  private toggleMap(): void {
    this.cfg.showMap = !this.cfg.showMap;
    if (!this.cfg.showMap) this.cfg.mapExpanded = false; // hiding the map brings the list back
    void this.plugin.saveSettings();
    this.syncToolbar();
    this.renderMap();
  }

  /** Open the editor on a new card, appended to the note it is created in. */
  startNew(): void {
    if (!this.confirmDiscard("new")) return;
    const path = this.original?.path || this.cfg.lastNote || this.firstNote();
    this.selKey = "new";
    this.original = null;
    this.newNote = path;
    this.plannedIds = new Map([["new", newId(new Set(this.idsIn(path)))]]);
    this.draft = { q: "", a: "", source: "", deck: "", conns: [] };
    this.dirty = false;
    this.renderList();
    this.renderEditor();
    this.editorEl.querySelector<HTMLElement>(".bt-q")?.focus();
  }

  private firstNote(): string {
    return Array.from(this.store.byPath.keys()).sort()[0] || "";
  }

  private idsIn(path: string): string[] {
    return (this.store.byPath.get(path) || []).map((c) => c.id).filter((x): x is string => !!x);
  }

  // ── Store updates ────────────────────────────────────────────────────────

  private onStoreChange(): void {
    if (this.selKey && this.selKey !== "new" && this.original) {
      if (!this.store.get(this.selKey)) {
        // The card may have just received an id: follow it by line.
        const o = this.original;
        const same = (this.store.byPath.get(o.path) || []).find((c) => c.line === o.line && c.q === o.q);
        if (same) this.selKey = cardKey(same);
      }
      const cur = this.store.get(this.selKey);
      if (cur && cur.raw !== this.original.raw && !this.dirty) this.openCard(cur, true);
      else if (cur && !this.dirty) this.original = cur;
    }
    this.renderAll(false);
  }

  private renderAll(withEditor = true): void {
    this.renderFilters();
    this.renderConcepts();
    this.renderList();
    if (withEditor) this.renderEditor();
    else this.renderEditorLive();
  }

  // ── Filters ──────────────────────────────────────────────────────────────

  private renderFilters(): void {
    const cards = this.store.all();
    const sources = new Set<string>();
    cards.forEach((c) => this.store.sourcesOf(c).forEach((s) => sources.add(s)));
    if (this.source && !sources.has(this.source)) this.source = "";
    fillSelect(this.sourceSel, "Any source", Array.from(sources).sort(), this.source, (v) => (v.length > 40 ? v.slice(0, 39) + "…" : v));
    const notes = Array.from(this.store.byPath.keys()).sort();
    if (this.note && !notes.includes(this.note)) this.note = "";
    fillSelect(this.noteSel, "Any note", notes, this.note, noteName);
  }

  private fieldOf(c: Card, name: string): string {
    const f = c.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? f.value.trim() : "";
  }

  private matches(c: Card): boolean {
    if (this.concept) {
      const ks = this.store.conceptsOf(c).map((k) => k.key);
      if (this.concept === NO_CONCEPT ? ks.length > 0 : !ks.includes(this.concept)) return false;
    }
    if (this.source && !this.store.sourcesOf(c).includes(this.source)) return false;
    if (this.note && c.path !== this.note) return false;
    const q = this.query.trim().toLowerCase();
    if (q) {
      const hay = (c.q + " " + c.a + " " + c.fields.map((f) => plainValue(f.value)).join(" ")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  private sorted(cards: Card[]): Card[] {
    return cards.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
  }

  // ── Concepts list ────────────────────────────────────────────────────────

  private renderConcepts(): void {
    const cards = this.store.all();
    const list = this.store.allConcepts().sort((x, y) => y.cards.length - x.cards.length || x.concept.name.localeCompare(y.concept.name));
    if (this.concept && this.concept !== NO_CONCEPT && !list.some((e) => e.concept.key === this.concept)) this.concept = "";
    const none = cards.filter((c) => !this.store.conceptsOf(c).length).length;
    this.conceptsEl.empty();
    this.conceptRow("", "All", cards.length, "");
    for (const e of list) {
      const row = this.conceptRow(e.concept.key, e.concept.name, e.cards.length, e.concept.exists ? "" : " is-ghost");
      row.setAttr("title", e.concept.name + (e.concept.exists ? "" : " · no note yet"));
    }
    if (none) this.conceptRow(NO_CONCEPT, "No concepts", none, " is-muted");
    if (!list.length && cards.length) {
      this.conceptsEl.createDiv({ cls: "bt-muted bt-concepts-hint", text: "Write [[links]] in a card's question or answer: each linked note becomes a concept." });
    }
  }

  private conceptRow(key: string, label: string, n: number, cls: string): HTMLElement {
    const row = this.conceptsEl.createDiv({ cls: "bt-tree-row" + (this.concept === key ? " is-active" : "") + cls });
    row.createSpan({ cls: "bt-tree-label", text: label });
    row.createSpan({ cls: "bt-tree-count", text: String(n) });
    row.addEventListener("click", () => this.setConcept(key));
    return row;
  }

  /** Filter the bank by a concept (clicking the active one again clears it). */
  private setConcept(key: string): void {
    this.concept = this.concept === key && key !== "" ? "" : key;
    this.renderConcepts();
    this.renderList();
  }

  // ── List ─────────────────────────────────────────────────────────────────

  private renderList(): void {
    const all = this.store.all();
    const hits = this.sorted(all.filter((c) => this.matches(c)));
    this.countEl.empty();
    this.countEl.createSpan({ text: hits.length + (hits.length === 1 ? " card" : " cards") });
    if (this.concept === NO_CONCEPT) this.countEl.createSpan({ text: " without concepts" });
    else if (this.concept) {
      const k = this.store.allConcepts().find((e) => e.concept.key === this.concept)?.concept;
      this.countEl.createSpan({ text: " mentioning " });
      this.countEl.createSpan({ cls: "bt-concept-link", text: k ? k.name : "" });
    }
    if (this.concept) {
      const clr = this.countEl.createEl("a", { cls: "bt-clear", text: "Clear" });
      clr.addEventListener("click", () => this.setConcept(""));
    }
    this.listEl.empty();
    if (!hits.length) {
      this.listEl.createDiv({ cls: "bt-empty", text: all.length ? "No cards match." : "No cards yet. List items tagged " + this.cfg.tag + " show up here." });
    } else {
      for (const c of hits) this.cardRow(this.listEl, c);
    }
    this.renderMap();
  }

  private cardRow(parent: HTMLElement, c: Card): void {
    const key = cardKey(c);
    const row = parent.createDiv({ cls: "bt-card" + (key === this.selKey ? " is-active" : "") });
    const main = row.createDiv({ cls: "bt-card-main" });
    this.richText(main.createDiv({ cls: "bt-card-q" }), c.q || "(no question)", c.path);
    if (c.a) this.richText(main.createDiv({ cls: "bt-card-a" }), c.a, c.path);
    const pills = main.createDiv({ cls: "bt-pills" });
    const src = plainValue(this.fieldOf(c, this.fieldNames.source));
    if (src) pill(pills, "book-open", src);
    const deck = plainValue(this.fieldOf(c, this.fieldNames.deck));
    if (deck) pill(pills, "layers", deck);
    const nr = this.store.linksOf(c).length;
    if (nr) pill(pills, "arrow-left-right", String(nr)).setAttr("title", nr + " in " + this.fieldNames.related);
    pill(pills, "file", noteName(c.path), "bt-pill-note");
    if (!c.id) pill(pills, "", "no id", "bt-pill-warn");
    const st = this.store.ankiStatus(c);
    if (st !== "none") {
      const label = { pending: "Anki: new", synced: "Anki ✓", changed: "Anki: changed", leaving: "Anki: will be deleted" }[st];
      pill(pills, "", label, "bt-pill-anki is-" + st);
    }
    row.addEventListener("click", () => this.selectCard(c));
  }

  /**
   * Card text with its links made usable: links to notes (concepts) filter
   * the bank, links to other cards open that card. Shown as they read, without brackets.
   */
  private richText(el: HTMLElement, text: string, path: string): void {
    const re = /(!?)\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g;
    let pos = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m.index > pos) el.appendChild(document.createTextNode(text.slice(pos, m.index)));
      pos = m.index + m[0].length;
      const embed = m[1] ?? "";
      const l = parseLinks(m[0].slice(embed.length))[0];
      if (embed || !l || !l.linkpath.trim()) {
        el.appendChild(document.createTextNode(m[0]));
        continue;
      }
      const shown = l.alias || (l.blockId ? l.linkpath : l.linkpath.split("#")[0]);
      if (l.blockId) {
        const target = this.store.resolve(l, path);
        const span = el.createSpan({ cls: "bt-card-link", text: shown });
        const card = target ? this.store.get(target) : undefined;
        if (card) {
          span.setAttr("title", "Open card: " + plainValue(card.q));
          span.addEventListener("click", (e) => { e.stopPropagation(); this.selectCard(card); });
        }
      } else {
        const k = this.store.conceptOf(l, path);
        const span = el.createSpan({ cls: "bt-concept-link" + (k.exists ? "" : " is-ghost") + (this.concept === k.key ? " is-active" : ""), text: shown });
        span.setAttr("title", "Show cards mentioning " + k.name + (k.exists ? "" : " (no note yet)"));
        span.addEventListener("click", (e) => { e.stopPropagation(); this.setConcept(k.key); });
      }
    }
    if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  }

  private selectCard(c: Card): void {
    const key = cardKey(c);
    if (key === this.selKey) return;
    if (!this.confirmDiscard(key)) return;
    this.openCard(c);
  }

  /** Returns false (and arms a second click) when there are unsaved changes. */
  private confirmDiscard(nextKey: string): boolean {
    if (!this.dirty || this.discardArmed === nextKey) {
      this.discardArmed = null;
      return true;
    }
    this.discardArmed = nextKey;
    new Notice("The open card has unsaved changes. Click again to discard them.");
    return false;
  }

  private openCard(c: Card, keepPlanned = false): void {
    this.selKey = cardKey(c);
    this.original = c;
    this.draft = this.store.draftOf(c);
    this.dirty = false;
    if (!keepPlanned) this.plannedIds = new Map();
    if (!c.id && !this.plannedIds.has(this.selKey)) this.plannedIds.set(this.selKey, newId(new Set(this.idsIn(c.path))));
    this.renderList();
    this.renderEditor();
  }

  // ── Concept map ──────────────────────────────────────────────────────────

  private renderMap(): void {
    if (!this.mapEl) return;
    this.mapEl.empty();
    if (!this.cfg.showMap) return;
    const focus = this.selKey === "new" ? null : this.original;
    drawConceptMap(this.mapEl, this.store, focus, (c) => this.selectCard(c), (k) => {
      if (this.concept !== k.key) this.setConcept(k.key);
    }, (tools) => {
      const exp = this.cfg.mapExpanded;
      const b = tools.createEl("button", { cls: "bt-map-expand", attr: { "aria-label": exp ? "Show the list again" : "Expand the map" } });
      setIcon(b.createSpan(), exp ? "minimize-2" : "maximize-2");
      b.createSpan({ text: exp ? "Back to list" : "Expand" });
      b.addEventListener("click", () => this.setMapExpanded(!exp));
    });
  }

  private setMapExpanded(on: boolean): void {
    this.cfg.mapExpanded = on;
    if (on) this.cfg.showMap = true;
    void this.plugin.saveSettings();
    this.syncToolbar();
    this.renderMap();
  }

  // ── Editor ───────────────────────────────────────────────────────────────

  /** Re-draws the parts of the open editor that depend on other cards (set by renderEditor). */
  private editorLive: (() => void) | null = null;

  private renderEditorLive(): void {
    this.editorLive?.();
  }

  private renderEditor(): void {
    const el = this.editorEl;
    el.empty();
    this.editorLive = null;
    this.bodyEl.toggleClass("has-editor", !!this.draft);
    const d = this.draft;
    if (!d) return;
    const isNew = this.selKey === "new";
    const c = this.original;
    const F = this.fieldNames;
    const pathNow = () => (isNew ? this.newNote : c ? c.path : "");

    const head = el.createDiv({ cls: "bt-ed-head" });
    head.createDiv({ cls: "bt-ed-title", text: isNew ? "New card" : "Edit card" });
    const close = head.createEl("button", { cls: "clickable-icon", attr: { "aria-label": "Close" } });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      if (!this.confirmDiscard("close")) return;
      this.closeEditor();
    });

    const meta = el.createDiv({ cls: "bt-ed-meta" });
    if (isNew) {
      meta.createSpan({ text: "Appended to the end of " });
      const wrap = meta.createDiv({ cls: "bt-note-pick" });
      const inp = wrap.createEl("input", { type: "text", value: this.newNote, placeholder: "Target note" });
      new InlineSuggest(inp, (q) => this.noteItems(q), (it) => { inp.value = it.value; this.setNewNote(it.value); }, true);
      inp.addEventListener("change", () => this.setNewNote(inp.value));
    } else if (c) {
      meta.createSpan({ text: noteName(c.path) });
      if (c.id) meta.createSpan({ cls: "bt-mono", text: " · ^" + c.id });
      else meta.createSpan({ cls: "bt-pill bt-pill-warn", text: "no id · gets ^" + this.plannedIds.get(this.selKey!) + " on save" });
    }

    const qIn = area(el, "Question", d.q, 2, "What does [[Tier 2 capital]] measure?", "bt-q");
    const qErr = el.createDiv({ cls: "bt-error" });
    const aIn = area(el, "Answer", d.a, 3, "A single line", "bt-a");

    // Concepts: links to notes in the question and answer, read live from the draft.
    el.createDiv({ cls: "bt-label", text: "Concepts · links in the question and answer" });
    const conceptsBox = el.createDiv({ cls: "bt-chips" });
    el.createDiv({ cls: "bt-label", text: "Related through concepts" });
    const viaBox = el.createDiv({ cls: "bt-via" });
    const drawConcepts = () => {
      const list = this.store.conceptsInText(d.q, d.a, pathNow());
      conceptsBox.empty();
      if (!list.length) conceptsBox.createSpan({ cls: "bt-muted", text: "None yet. Write [[a note]] in the question or answer to link this card to a concept." });
      for (const k of list) {
        const chip = conceptsBox.createDiv({ cls: "bt-chip bt-chip-concept is-clickable" + (k.exists ? "" : " is-ghost") });
        setIcon(chip.createSpan({ cls: "bt-chip-icon" }), k.exists ? "file-text" : "file-plus");
        chip.createSpan({ cls: "bt-chip-text", text: k.name });
        if (!k.exists) chip.createSpan({ cls: "bt-chip-note", text: "no note yet" });
        chip.setAttr("title", k.exists ? "Open the note" : "Create the note");
        chip.addEventListener("click", () => { void this.openConcept(k, pathNow()); });
        const f = chip.createSpan({ cls: "bt-chip-x", attr: { "aria-label": "Show cards mentioning it" } });
        setIcon(f, "filter");
        f.addEventListener("click", (e) => { e.stopPropagation(); this.setConcept(k.key); });
      }
      viaBox.empty();
      const groups = this.store.relatedByConcept(list, isNew ? null : this.selKey).filter((g) => g.cards.length);
      if (!groups.length) viaBox.createSpan({ cls: "bt-muted", text: list.length ? "No other card mentions these concepts yet." : "—" });
      for (const g of groups) {
        const grp = viaBox.createDiv({ cls: "bt-via-group" });
        const h = grp.createDiv({ cls: "bt-via-head" });
        const name = h.createSpan({ cls: "bt-concept-link" + (g.concept.exists ? "" : " is-ghost"), text: g.concept.name });
        name.setAttr("title", "Show cards mentioning " + g.concept.name);
        name.addEventListener("click", () => this.setConcept(g.concept.key));
        h.createSpan({ cls: "bt-tree-count", text: " " + g.cards.length });
        for (const o of g.cards) {
          const r = grp.createDiv({ cls: "bt-via-card", text: plainValue(o.q) || "(no question)" });
          r.addEventListener("click", () => this.selectCard(o));
        }
      }
    };

    const deckIn = input(el, F.deck, d.deck, "Anki deck name");
    deckIn.addClass("bt-deck");

    const sourceIn = input(el, F.source, d.source, "A vault file ([[…]]) or text");
    sourceIn.addClass("bt-source");
    new InlineSuggest(deckIn, (q) => this.valueItems(q, (x) => plainValue(this.fieldOf(x, F.deck))), (it) => { deckIn.value = it.value; sync(); });
    new InlineSuggest(sourceIn, (q) => this.fileItems(q), (it) => {
      const v = sourceIn.value;
      const k = v.lastIndexOf(",");
      sourceIn.value = (k >= 0 ? v.slice(0, k + 1) + " " : "") + it.value;
      sync();
    });

    // Related cards: only this card's own Related field. (Links from other cards show in the concept map.)
    el.createDiv({ cls: "bt-label", text: F.related });
    const chips = el.createDiv({ cls: "bt-chips" });
    const drawChips = () => {
      chips.empty();
      d.conns.forEach((conn, i) => {
        const t = conn.key.startsWith("?") ? null : this.store.get(conn.key);
        const chip = this.chip(chips, t ? plainValue(t.q) : plainValue(conn.raw || conn.key.slice(1)) + " (not a card)", t ? "" : "is-broken", t ? () => this.selectCard(t) : null);
        if (t && !t.id) chip.createSpan({ cls: "bt-chip-new", text: "+id" });
        const x = chip.createSpan({ cls: "bt-chip-x", attr: { "aria-label": "Remove" } });
        setIcon(x, "x");
        x.addEventListener("click", (e) => {
          e.stopPropagation();
          d.conns.splice(i, 1);
          drawChips();
          sync();
        });
      });
    };
    drawChips();
    const connWrap = el.createDiv();
    const connIn = connWrap.createEl("input", { type: "text", placeholder: "Relate to… (search by question)", cls: "bt-input" });
    new InlineSuggest(connIn, (q) => this.cardItems(q, d), (it) => {
      d.conns.push({ key: it.value });
      const t = this.store.get(it.value);
      if (t && !t.id && !this.plannedIds.has(it.value)) this.plannedIds.set(it.value, newId(new Set(this.idsIn(t.path))));
      connIn.value = "";
      drawChips();
      sync();
    });

    el.createDiv({ cls: "bt-label", text: "Line that will be written to the note" });
    const preview = el.createDiv({ cls: "bt-preview" });

    const actions = el.createDiv({ cls: "bt-actions" });
    if (!isNew && c) {
      const go = actions.createEl("button");
      setIcon(go.createSpan(), "arrow-up-right");
      go.createSpan({ text: "Open in note" });
      go.addEventListener("click", () => { void this.revealInNote(c); });
    }
    const saveBtn = actions.createEl("button", { cls: "mod-cta" });
    setIcon(saveBtn.createSpan(), "check");
    saveBtn.createSpan({ text: "Save" });

    const sync = () => {
      d.q = qIn.value.replace(/[\r\n]+/g, " ");
      d.a = aIn.value.replace(/[\r\n]+/g, " ");
      d.deck = deckIn.value;
      d.source = sourceIn.value;
      this.dirty = true;
      qErr.setText("");
      preview.setText(this.previewLine(d));
      drawConcepts();
    };
    for (const i of [qIn, aIn, deckIn, sourceIn]) i.addEventListener("input", sync);
    for (const i of [qIn, aIn]) i.addEventListener("keydown", (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) { k.preventDefault(); saveBtn.click(); }
      else if (k.key === "Enter") k.preventDefault();
    });
    preview.setText(this.previewLine(d));
    drawConcepts();
    this.editorLive = () => { drawConcepts(); drawChips(); };

    const doSave = async (): Promise<void> => {
      sync();
      if (!d.q.trim()) {
        qErr.setText("Write the question first.");
        qIn.focus();
        return;
      }
      if (isNew && !(this.app.vault.getAbstractFileByPath(this.newNote) instanceof TFile)) {
        new Notice("Pick a target note that exists.");
        return;
      }
      if (this.saving) return;
      this.saving = true;
      try {
        let key: string;
        if (isNew) {
          key = await this.store.create(this.newNote, d, this.plannedIds);
          this.cfg.lastNote = this.newNote;
          await this.plugin.saveSettings();
        } else {
          key = await this.store.save(c!, d, this.plannedIds);
        }
        new Notice(isNew ? "Card added" : "Card saved");
        this.dirty = false;
        this.selKey = key;
        await this.reloadAndOpen(key);
      } catch (err) {
        if (err instanceof SaveError) {
          new Notice(err.message, 8000);
          if (err.kind === "changed" && c) await this.reloadAndOpen(cardKey(c), c);
        } else {
          console.error("[flashcard-bank]", err);
          new Notice("Could not save: " + (err as Error).message);
        }
      } finally {
        this.saving = false;
      }
    };
    saveBtn.addEventListener("click", () => { void doSave(); });
    this.renderMap();
  }

  /** Open a concept's note in a new tab (Obsidian creates it if it doesn't exist yet). */
  private async openConcept(k: Concept, sourcePath: string): Promise<void> {
    await this.app.workspace.openLinkText(k.linkpath, sourcePath, "tab");
  }

  private chip(parent: HTMLElement, text: string, cls: string, onClick: (() => void) | null): HTMLElement {
    const chip = parent.createDiv({ cls: "bt-chip " + cls });
    chip.createSpan({ cls: "bt-chip-text", text });
    if (onClick) {
      chip.addClass("is-clickable");
      chip.addEventListener("click", onClick);
    }
    return chip;
  }

  private closeEditor(): void {
    this.selKey = null;
    this.original = null;
    this.draft = null;
    this.dirty = false;
    this.renderList();
    this.renderEditor();
  }

  private setNewNote(path: string): void {
    const p = path.trim() ? normalizePath(path.trim()) : "";
    if (p === this.newNote) return;
    this.newNote = p;
    this.plannedIds.set("new", newId(new Set(this.idsIn(this.newNote))));
    // Redraw after the current focus/blur events finish: redrawing removes the input that fired them.
    window.setTimeout(() => {
      if (this.selKey === "new") this.renderEditor();
    }, 0);
  }

  /** Re-read the note right away (not waiting for Obsidian's change event) and open the card. */
  private async reloadAndOpen(key: string, fallback?: Card): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(pathOfKey(key));
    if (f instanceof TFile) await this.store.updateFile(f, await this.app.vault.read(f));
    let c = this.store.get(key);
    if (!c && fallback) c = (this.store.byPath.get(fallback.path) || []).find((x) => x.line === fallback.line);
    if (c) this.openCard(c);
    else this.closeEditor();
    this.renderFilters();
    this.renderConcepts();
  }

  private previewLine(d: Draft): string {
    const F = this.fieldNames;
    const path = this.selKey === "new" ? this.newNote : this.original?.path || "";
    const related = d.conns
      .map((conn) => {
        if (conn.raw) return conn.raw;
        const t = this.store.get(conn.key);
        if (!t) return "";
        const id = t.id || this.plannedIds.get(conn.key) || "?";
        const f = this.app.vault.getAbstractFileByPath(t.path);
        const lt = f instanceof TFile ? this.app.metadataCache.fileToLinktext(f, path, true) : t.path;
        return "[[" + lt + "#^" + id + "|" + safeAlias(plainValue(t.q)) + "]]";
      })
      .filter(Boolean)
      .join(", ");
    if (this.selKey === "new") {
      return newCardLine(
        this.cfg.newPrefix, d.q, d.a,
        { [F.source]: d.source, [F.related]: related, [F.deck]: d.deck },
        this.store.order, this.cfg.tag, this.plannedIds.get("new") || "new"
      );
    }
    const c = this.original!;
    const fields: Record<string, string> = {};
    const has = (n: string) => c.fields.some((f) => f.name.toLowerCase() === n.toLowerCase());
    const put = (n: string, v: string) => { if (has(n) || v.trim()) fields[n] = v; };
    put(F.source, d.source);
    put(F.deck, d.deck);
    const before = this.store.linksOf(c).map((l) => l.raw);
    const unchanged = before.length === d.conns.length && d.conns.every((x, i) => x.raw === before[i]);
    if (!unchanged) put(F.related, related);
    return rewriteCard(c, { q: d.q, a: d.a, fields, order: this.store.order, newId: c.id ? undefined : this.plannedIds.get(this.selKey!) });
  }

  private async revealInNote(c: Card): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(c.path);
    if (!(f instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(f, { active: true, eState: { line: c.line } });
  }

  // ── Suggestion sources ───────────────────────────────────────────────────

  private valueItems(q: string, get: (c: Card) => string) {
    const s = q.trim().toLowerCase();
    const vals = new Set<string>();
    for (const c of this.store.all()) {
      const v = get(c);
      if (v) vals.add(v);
    }
    return Array.from(vals)
      .filter((v) => !s || v.toLowerCase().includes(s))
      .sort()
      .map((v) => ({ label: v, value: v }));
  }

  private fileItems(q: string) {
    const seg = q.slice(q.lastIndexOf(",") + 1).trim().replace(/^\[\[/, "").toLowerCase();
    if (seg.length < 2) return [];
    const src = this.selKey === "new" ? this.newNote : this.original?.path || "";
    return this.app.vault
      .getFiles()
      .filter((f) => f.name.toLowerCase().includes(seg))
      .slice(0, 8)
      .map((f) => ({ label: f.name, hint: f.parent?.path || "", value: "[[" + this.app.metadataCache.fileToLinktext(f, src, true) + "]]" }));
  }

  private noteItems(q: string) {
    const s = q.trim().toLowerCase();
    const withCards = new Set(this.store.byPath.keys());
    return this.app.vault
      .getMarkdownFiles()
      .filter((f) => !this.store.excluded(f.path) && (!s || f.path.toLowerCase().includes(s)))
      .sort((a, b) => Number(withCards.has(b.path)) - Number(withCards.has(a.path)) || a.path.localeCompare(b.path))
      .slice(0, 8)
      .map((f) => ({ label: f.basename, hint: withCards.has(f.path) ? "has cards" : f.parent?.path || "", value: f.path }));
  }

  private cardItems(q: string, d: Draft) {
    const s = q.trim().toLowerCase();
    if (s.length < 2) return [];
    const taken = new Set(d.conns.map((x) => x.key));
    if (this.selKey) taken.add(this.selKey);
    return this.store
      .all()
      .filter((c) => !taken.has(cardKey(c)) && c.q.toLowerCase().includes(s))
      .slice(0, 8)
      .map((c) => ({ label: plainValue(c.q), hint: (c.id ? "^" + c.id : "no id") + " · " + noteName(c.path), value: cardKey(c) }));
  }
}

// ── small DOM helpers ──────────────────────────────────────────────────────

export function noteName(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "");
}

function fillSelect(sel: HTMLSelectElement, allLabel: string, values: string[], current: string, show: (v: string) => string) {
  sel.empty();
  sel.createEl("option", { value: "", text: allLabel });
  for (const v of values) sel.createEl("option", { value: v, text: show(v) });
  sel.value = values.includes(current) ? current : "";
}

function pill(parent: HTMLElement, icon: string, text: string, cls = ""): HTMLElement {
  const p = parent.createSpan({ cls: "bt-pill " + cls });
  if (icon) setIcon(p.createSpan({ cls: "bt-pill-icon" }), icon);
  p.createSpan({ text });
  return p;
}

function area(parent: HTMLElement, label: string, value: string, rows: number, ph: string, cls: string): HTMLTextAreaElement {
  parent.createDiv({ cls: "bt-label", text: label });
  const wrap = parent.createDiv();
  const t = wrap.createEl("textarea", { cls: "bt-input " + cls, placeholder: ph });
  t.rows = rows;
  t.value = value;
  return t;
}

function input(parent: HTMLElement, label: string, value: string, ph: string): HTMLInputElement {
  const box = parent.createDiv();
  box.createDiv({ cls: "bt-label", text: label });
  const wrap = box.createDiv();
  const i = wrap.createEl("input", { type: "text", cls: "bt-input", placeholder: ph });
  i.value = value;
  return i;
}
