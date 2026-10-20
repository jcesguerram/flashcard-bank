// The "Flashcard Bank" tab: decks and concepts panel, card list, editor, concept map and concept pages.

import { ItemView, Notice, TFile, WorkspaceLeaf, normalizePath, setIcon } from "obsidian";
import { Card, SectionRef, headingsOf, rewriteCard, newCardLine, plainValue, safeAlias, newId, parseLinks } from "./card";
import { AnkiStatus, CardStore, Concept, Draft, SaveError, SectionState, cardKey, pathOfKey } from "./store";
import { InlineSuggest } from "./suggest";
import { drawConceptMap } from "./map";
import type FlashcardBankPlugin from "./main";

export const VIEW_TYPE = "flashcard-bank";
const NO_CONCEPT = "\u0000no-concept";
const NARROW = 760; // below this width the bank shows one panel at a time
const TINY = 520; // below this the concepts column becomes a strip above the list

const ANKI_LABEL: Record<Exclude<AnkiStatus, "none">, string> = {
  pending: "Anki: new",
  synced: "Synced with Anki",
  changed: "Anki: changed",
  leaving: "Anki: will be deleted",
};

interface ConceptEntry {
  concept: Concept;
  cards: Card[];
}

export class BankView extends ItemView {
  private store: CardStore;
  private unsubscribe: (() => void) | null = null;

  // filters
  private query = "";
  private concept = ""; // concept key, NO_CONCEPT, or "" for all
  private deck: string | null = null; // a deck (with its sub-decks), "" for cards without a deck, or null for all
  private source = "";
  private note = "";
  private filtersOpen = false;

  // concept page
  private pageKey: string | null = null;
  private pageTab: "overview" | "connections" = "overview";
  private pageOpen = new Set<string>(); // cards whose answer is shown on the page (by place and card)

  // editor state
  private selKey: string | null = null; // card being edited, or "new"
  private original: Card | null = null; // snapshot of the card when opened
  private draft: Draft | null = null;
  private dirty = false;
  private discardArmed: string | null = null;
  private newNote = "";
  private newSection: SectionRef | null = null; // where in the note a new card goes (null: the end)
  private plannedIds = new Map<string, string>();
  private saving = false;

  // list state
  private hitKeys: string[] = [];
  private listScroll = 0;

  // elements
  private crumbsEl!: HTMLElement;
  private conceptsEl!: HTMLElement;
  private sideEl!: HTMLElement;
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private mapEl!: HTMLElement;
  private editorEl!: HTMLElement;
  private pageEl!: HTMLElement;
  private filterPanel!: HTMLElement;
  private filterBtn!: HTMLElement;
  private sourceSel!: HTMLSelectElement;
  private noteSel!: HTMLSelectElement;
  private bodyEl!: HTMLElement;
  private mapBtn!: HTMLElement;
  private ankiBtn!: HTMLButtonElement;
  private segBtns: HTMLElement[] = [];

  constructor(leaf: WorkspaceLeaf, private plugin: FlashcardBankPlugin) {
    super(leaf);
    this.store = plugin.store;
  }

  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Flashcard bank"; }
  getIcon() { return "layers"; }

  private get cfg() { return this.plugin.settings; }
  private get fieldNames() { return this.store.f; }
  private get narrow() { return this.bodyEl.hasClass("bt-narrow"); }

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

    // Header: where you are, plus the map and Anki tools.
    const head = root.createDiv({ cls: "bt-head" });
    this.crumbsEl = head.createDiv({ cls: "bt-crumbs" });
    const tools = head.createDiv({ cls: "bt-head-tools" });
    this.mapBtn = tools.createEl("button", { cls: "clickable-icon bt-map-btn", attr: { "aria-label": "Concept map" } });
    setIcon(this.mapBtn, "network");
    this.mapBtn.addEventListener("click", () => this.toggleMap());
    this.ankiBtn = tools.createEl("button", { cls: "clickable-icon bt-anki-btn", attr: { "aria-label": "Sync with Anki" } });
    setIcon(this.ankiBtn, "refresh-cw");
    this.ankiBtn.addEventListener("click", () => { void this.plugin.syncAnki(); });
    this.setSyncBusy(this.plugin.syncing);

    // Search, filters, new card.
    const bar = root.createDiv({ cls: "bt-bar" });
    const sw = bar.createDiv({ cls: "bt-search-wrap" });
    setIcon(sw.createSpan({ cls: "bt-search-icon" }), "search");
    const search = sw.createEl("input", { type: "search", placeholder: "Search your cards…", cls: "bt-search" });
    search.addEventListener("input", () => {
      this.query = search.value;
      if (this.pageKey) this.closePage();
      else {
        this.renderConcepts(); // the counts follow the search
        this.renderList();
      }
    });
    this.filterBtn = bar.createEl("button", { cls: "bt-filter-btn" });
    this.filterBtn.addEventListener("click", () => {
      this.filtersOpen = !this.filtersOpen;
      this.renderFilterButton();
    });
    const nb = bar.createEl("button", { cls: "bt-new" });
    setIcon(nb.createSpan(), "plus");
    nb.createSpan({ text: "New card" });
    nb.addEventListener("click", () => this.startNew());

    this.filterPanel = root.createDiv({ cls: "bt-filter-panel" });
    const filter = (label: string): HTMLSelectElement => {
      const wrap = this.filterPanel.createEl("label", { cls: "bt-filter-wrap" });
      wrap.createSpan({ cls: "bt-filter-label", text: label });
      return wrap.createEl("select", { cls: "dropdown bt-filter" });
    };
    this.sourceSel = filter("Source");
    this.sourceSel.addEventListener("change", () => this.setFilter("source", this.sourceSel.value));
    this.noteSel = filter("Note");
    this.noteSel.addEventListener("change", () => this.setFilter("note", this.noteSel.value));
    const clr = this.filterPanel.createEl("button", { cls: "bt-filter-clear", text: "Clear filters" });
    clr.addEventListener("click", () => {
      this.source = "";
      this.note = "";
      this.renderFilters();
      this.renderConcepts();
      this.renderList();
    });

    this.bodyEl = root.createDiv({ cls: "bt-body" });
    this.sideEl = this.bodyEl.createDiv({ cls: "bt-tree-col" });
    const listCol = this.bodyEl.createDiv({ cls: "bt-list-col" });
    const listHead = listCol.createDiv({ cls: "bt-list-head" });
    this.countEl = listHead.createDiv({ cls: "bt-count" });
    const seg = listHead.createDiv({ cls: "bt-seg" });
    for (const [mode, label] of [["compact", "Compact"], ["expanded", "Expanded"]] as const) {
      const b = seg.createEl("button", { text: label, attr: { "data-density": mode } });
      b.addEventListener("click", () => this.setDensity(mode));
      this.segBtns.push(b);
    }
    this.listEl = listCol.createDiv({ cls: "bt-list" });
    this.mapEl = listCol.createDiv({ cls: "bt-map" });
    this.editorEl = this.bodyEl.createDiv({ cls: "bt-editor" });
    this.pageEl = this.bodyEl.createDiv({ cls: "bt-page" });

    const ro = new ResizeObserver(() => {
      const w = this.bodyEl.clientWidth;
      if (!w) return;
      this.bodyEl.toggleClass("bt-narrow", w < NARROW);
      this.bodyEl.toggleClass("bt-tiny", w < TINY);
    });
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

  /** Show the Anki button as busy (and ignore clicks) while a sync runs. */
  setSyncBusy(on: boolean): void {
    if (!this.ankiBtn) return;
    this.ankiBtn.toggleClass("is-busy", on);
    this.ankiBtn.disabled = on;
    this.ankiBtn.setAttr("aria-label", on ? "Syncing with Anki…" : "Sync with Anki");
  }

  async onClose() {
    this.unsubscribe?.();
  }

  private syncToolbar(): void {
    this.mapBtn.toggleClass("is-active", this.cfg.showMap);
    this.bodyEl.toggleClass("has-map", this.cfg.showMap);
    this.bodyEl.toggleClass("map-expanded", this.cfg.showMap && this.cfg.mapExpanded);
    this.listEl.toggleClass("is-expanded", this.cfg.density === "expanded");
    for (const b of this.segBtns) b.toggleClass("is-active", b.getAttr("data-density") === this.cfg.density);
  }

  private setDensity(mode: "compact" | "expanded"): void {
    if (this.cfg.density === mode) return;
    this.cfg.density = mode;
    void this.plugin.saveSettings();
    this.syncToolbar();
    this.renderList();
  }

  private toggleMap(): void {
    // On a concept page the map button brings back the bank with the map showing.
    this.cfg.showMap = this.pageKey ? true : !this.cfg.showMap;
    if (!this.cfg.showMap) this.cfg.mapExpanded = false; // hiding the map brings the list back
    void this.plugin.saveSettings();
    if (this.pageKey && this.cfg.showMap) this.closePage();
    this.syncToolbar();
    this.renderMap();
  }

  /** Open the editor on a new card, appended to the note it is created in. */
  startNew(): void {
    if (!this.confirmDiscard("new")) return;
    const path = this.original?.path || this.cfg.lastNote || this.firstNote();
    this.rememberScroll();
    this.selKey = "new";
    this.original = null;
    this.newNote = path;
    this.newSection = this.cfg.lastSection[path] ?? null;
    this.plannedIds = new Map([["new", newId(new Set(this.idsIn(path)))]]);
    this.draft = { q: "", a: "", source: "", deck: "", conns: [] };
    this.dirty = false;
    if (this.pageKey) this.closePage(false);
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
    this.renderPage();
  }

  // ── Header and filters ───────────────────────────────────────────────────

  private conceptName(key: string): string {
    if (key === NO_CONCEPT) return "No concepts";
    return this.store.allConcepts().find((e) => e.concept.key === key)?.concept.name || "";
  }

  private renderCrumbs(): void {
    const el = this.crumbsEl;
    el.empty();
    setIcon(el.createSpan({ cls: "bt-crumbs-icon" }), "layers");
    const home = el.createSpan({ cls: "bt-crumbs-home", text: "Flashcard bank" });
    const here = this.pageKey
      ? this.conceptName(this.pageKey)
      : [this.deck === null ? "" : this.deckName(this.deck), this.concept ? this.conceptName(this.concept) : ""].filter(Boolean).join(" · ") || "All cards";
    if (this.pageKey) {
      home.addClass("is-link");
      home.addEventListener("click", () => this.closePage());
    }
    el.createSpan({ cls: "bt-crumbs-sep", text: "/" });
    el.createSpan({ cls: "bt-crumbs-here", text: here });
  }

  private renderFilterButton(): void {
    const n = (this.source ? 1 : 0) + (this.note ? 1 : 0);
    this.filterBtn.empty();
    setIcon(this.filterBtn.createSpan(), "sliders-horizontal");
    this.filterBtn.createSpan({ text: n ? "Filter · " + n : "Filter" });
    this.filterBtn.toggleClass("is-active", n > 0 || this.filtersOpen);
    this.filterPanel.toggleClass("is-open", this.filtersOpen);
  }

  private renderFilters(): void {
    const cards = this.store.all();
    const sources = new Set<string>();
    cards.forEach((c) => this.store.sourcesOf(c).forEach((s) => sources.add(s)));
    if (this.source && !sources.has(this.source)) this.source = "";
    fillSelect(this.sourceSel, "Any source", Array.from(sources).sort(), this.source, (v) => (v.length > 40 ? v.slice(0, 39) + "…" : v));
    const notes = Array.from(this.store.byPath.keys()).sort();
    if (this.note && !notes.includes(this.note)) this.note = "";
    fillSelect(this.noteSel, "Any note", notes, this.note, noteName);
    this.renderFilterButton();
  }

  private setFilter(which: "source" | "note", value: string): void {
    this[which] = value;
    if (this.pageKey) this.closePage(false);
    (which === "source" ? this.sourceSel : this.noteSel).value = value;
    this.renderFilterButton();
    this.renderConcepts();
    this.renderList();
  }

  private fieldOf(c: Card, name: string): string {
    const f = c.fields.find((x) => x.name.toLowerCase() === name.toLowerCase());
    return f ? f.value.trim() : "";
  }

  /** Does the card pass the filters? `skip` leaves out one of them (to count cards for its own list). */
  private matches(c: Card, skip?: "deck" | "concept"): boolean {
    if (this.concept && skip !== "concept" && !this.inConcept(c, this.concept)) return false;
    if (this.deck !== null && skip !== "deck" && !this.inDeck(c, this.deck)) return false;
    if (this.source && !this.store.sourcesOf(c).includes(this.source)) return false;
    if (this.note && c.path !== this.note) return false;
    const q = this.query.trim().toLowerCase();
    if (q) {
      const hay = (c.q + " " + c.a + " " + c.fields.map((f) => plainValue(f.value)).join(" ")).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  private inConcept(c: Card, key: string): boolean {
    const ks = this.store.conceptsOf(c).map((k) => k.key);
    return key === NO_CONCEPT ? ks.length === 0 : ks.includes(key);
  }

  /** In this deck or one of its sub-decks ("" means cards without a deck). */
  private inDeck(c: Card, deck: string): boolean {
    const d = this.store.deckOf(c);
    return deck === "" ? !d : d === deck || d.startsWith(deck + "::");
  }

  private deckName(deck: string): string {
    return deck === "" ? "No deck" : deck;
  }

  private sorted(cards: Card[]): Card[] {
    return cards.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)));
  }

  // ── Concepts column ──────────────────────────────────────────────────────

  /**
   * The key a concept has now. A concept without a note ("?name") gets the note's
   * path as its key once the note is created: follow it so the page or filter stays.
   */
  private currentKey(key: string): string | null {
    const list = this.store.allConcepts();
    if (list.some((e) => e.concept.key === key)) return key;
    if (!key.startsWith("?")) return null;
    const name = key.slice(1);
    return list.find((e) => e.concept.name.toLowerCase() === name)?.concept.key ?? null;
  }

  /** The left panel: All cards, then the Decks and Concepts sections. Counts follow the other filters. */
  private renderConcepts(): void {
    const cards = this.store.all();
    const list = this.store.allConcepts().sort((x, y) => y.cards.length - x.cards.length || x.concept.name.localeCompare(y.concept.name));
    if (this.concept && this.concept !== NO_CONCEPT) this.concept = this.currentKey(this.concept) ?? "";
    if (this.pageKey) this.pageKey = this.currentKey(this.pageKey) ?? this.pageKey;
    const decks = new Set<string>();
    let noDeck = 0;
    for (const c of cards) {
      const d = this.store.deckOf(c);
      if (!d) noDeck++;
      // Each parent of a sub-deck is a deck too: Finance::Banking → Finance.
      else d.split("::").forEach((_, i, parts) => decks.add(parts.slice(0, i + 1).join("::")));
    }
    if (this.deck && !decks.has(this.deck)) this.deck = null;
    if (this.deck === "" && !noDeck) this.deck = null;

    const side = this.sideEl;
    side.empty();
    const all = side.createDiv({ cls: "bt-tree bt-tree-all" });
    this.conceptsEl = all;
    this.conceptRow("", "All cards", cards.length, "", !this.pageKey && !this.concept && this.deck === null, () => this.showAll());

    // Decks (only when some card has one).
    if (decks.size) {
      const body = this.sideSection(side, "decks", "Decks", "folder-tree");
      const forDeck = cards.filter((c) => this.matches(c, "deck"));
      const sortedDecks = Array.from(decks).sort((a, b) => a.localeCompare(b));
      for (const d of sortedDecks) {
        const depth = d.split("::").length - 1;
        const n = forDeck.filter((c) => this.inDeck(c, d)).length;
        const row = this.treeRow(body, d.split("::").pop() || d, n, "bt-deck-row bt-depth-" + Math.min(depth, 4) + (n ? "" : " is-empty"), this.deck === d, () => this.setDeck(d));
        row.setAttr("data-deck", d);
        row.setAttr("title", d);
      }
      if (noDeck) {
        const n = forDeck.filter((c) => this.inDeck(c, "")).length;
        const row = this.treeRow(body, "No deck", n, "bt-deck-row is-muted" + (n ? "" : " is-empty"), this.deck === "", () => this.setDeck(""));
        row.setAttr("data-deck", "");
        row.setAttr("title", "Cards that aren't synced with Anki");
      }
    }

    // Concepts: the name opens the concept page, the filter icon filters the list.
    const body = this.sideSection(side, "concepts", "Concepts", "share-2");
    this.conceptsEl = body;
    const forConcept = cards.filter((c) => this.matches(c, "concept"));
    const counts = new Map<string, number>();
    for (const c of forConcept) for (const k of this.store.conceptsOf(c)) counts.set(k.key, (counts.get(k.key) || 0) + 1);
    for (const e of list) {
      const k = e.concept;
      const n = counts.get(k.key) || 0;
      const filtered = this.concept === k.key;
      const row = this.conceptRow(k.key, k.name, n, (k.exists ? "" : " is-ghost") + (n || filtered ? "" : " is-empty"), filtered || this.pageKey === k.key, () => this.openPage(k.key));
      row.setAttr("title", k.name + (k.exists ? "" : " · no note yet") + " · click to open its page");
      const f = row.createSpan({ cls: "bt-tree-filter" + (filtered ? " is-on" : ""), attr: { "aria-label": filtered ? "Stop filtering by this concept" : "Filter the cards by this concept" } });
      setIcon(f, "filter");
      f.addEventListener("click", (ev) => { ev.stopPropagation(); this.setConcept(k.key); });
      row.insertBefore(f, row.querySelector(".bt-tree-count")); // keep the counts aligned with the decks'
    }
    const none = forConcept.filter((c) => !this.store.conceptsOf(c).length).length;
    if (cards.some((c) => !this.store.conceptsOf(c).length)) {
      this.conceptRow(NO_CONCEPT, "No concepts", none, " is-muted" + (none ? "" : " is-empty"), this.concept === NO_CONCEPT, () => this.setConcept(NO_CONCEPT));
    }
    if (!list.length && cards.length) {
      body.createDiv({ cls: "bt-muted bt-concepts-hint", text: "Write [[links]] in a card's question or answer: each linked note becomes a concept." });
    }
    this.renderCrumbs();
  }

  /** A foldable section of the left panel; its open state is remembered. Returns the body. */
  private sideSection(parent: HTMLElement, id: "decks" | "concepts", title: string, icon: string): HTMLElement {
    const sec = parent.createDiv({ cls: "bt-side-sec" + (this.cfg.open[id] ? " is-open" : ""), attr: { "data-section": id } });
    const head = sec.createDiv({ cls: "bt-col-title" });
    setIcon(head.createSpan({ cls: "bt-col-icon" }), icon);
    head.createSpan({ text: title });
    setIcon(head.createSpan({ cls: "bt-col-chev" }), "chevron-right");
    head.addEventListener("click", () => {
      this.cfg.open[id] = !this.cfg.open[id];
      sec.toggleClass("is-open", this.cfg.open[id]);
      void this.plugin.saveSettings();
    });
    return sec.createDiv({ cls: "bt-tree" });
  }

  private conceptRow(key: string, label: string, n: number, cls: string, active: boolean, onClick: () => void): HTMLElement {
    const row = this.treeRow(this.conceptsEl, label, n, cls, active, onClick);
    row.setAttr("data-key", key);
    return row;
  }

  private treeRow(parent: HTMLElement, label: string, n: number, cls: string, active: boolean, onClick: () => void): HTMLElement {
    const row = parent.createDiv({ cls: "bt-tree-row" + (active ? " is-active" : "") + (cls ? " " + cls.trim() : "") });
    row.createSpan({ cls: "bt-tree-label", text: label });
    row.createSpan({ cls: "bt-tree-count", text: String(n) });
    row.addEventListener("click", onClick);
    return row;
  }

  /** Back to every card: no deck or concept filter, no concept page. */
  private showAll(): void {
    this.concept = "";
    this.deck = null;
    if (this.pageKey) this.closePage();
    else {
      this.renderConcepts();
      this.renderList();
    }
  }

  /** Filter the bank by a concept (clicking the active one again clears it). Combines with the deck filter. */
  private setConcept(key: string): void {
    this.concept = this.concept === key && key !== "" ? "" : key;
    if (this.pageKey) this.closePage(false);
    this.renderConcepts();
    this.renderList();
  }

  /** Filter the bank by a deck and its sub-decks (clicking the active one again clears it). Combines with the concept filter. */
  private setDeck(deck: string | null): void {
    this.deck = this.deck === deck ? null : deck;
    if (this.pageKey) this.closePage(false);
    this.renderConcepts();
    this.renderList();
  }

  // ── List ─────────────────────────────────────────────────────────────────

  private renderList(): void {
    const all = this.store.all();
    const hits = this.sorted(all.filter((c) => this.matches(c)));
    this.hitKeys = hits.map(cardKey);
    this.countEl.empty();
    this.countEl.createSpan({ cls: "bt-count-n", text: hits.length + (hits.length === 1 ? " card" : " cards") });
    // The active filters, each with its own ×.
    const chip = (icon: string, text: string, clear: () => void, open?: () => void) => {
      const c = this.countEl.createSpan({ cls: "bt-filter-chip" });
      setIcon(c.createSpan({ cls: "bt-filter-chip-icon" }), icon);
      const t = c.createSpan({ cls: "bt-filter-chip-text", text });
      if (open) {
        t.addClass("is-link");
        t.setAttr("title", "Open the concept page");
        t.addEventListener("click", open);
      }
      const x = c.createSpan({ cls: "bt-filter-chip-x", attr: { "aria-label": "Remove this filter" } });
      setIcon(x, "x");
      x.addEventListener("click", clear);
    };
    if (this.deck !== null) chip("folder-tree", this.deckName(this.deck), () => this.setDeck(null));
    if (this.concept) {
      const key = this.concept;
      chip("share-2", this.conceptName(key), () => this.setConcept(""), key === NO_CONCEPT ? undefined : () => this.openPage(key));
    }
    if (this.source) chip("book-open", this.source, () => this.setFilter("source", ""));
    if (this.note) chip("file-text", noteName(this.note), () => this.setFilter("note", ""));
    this.listEl.empty();
    if (!hits.length) {
      this.listEl.createDiv({ cls: "bt-empty", text: all.length ? "No cards match." : "No cards yet. List items tagged " + this.cfg.tag + " show up here." });
    } else {
      for (const c of hits) this.cardRow(this.listEl, c);
    }
    this.renderCrumbs();
    this.renderMap();
  }

  private cardRow(parent: HTMLElement, c: Card): void {
    const key = cardKey(c);
    const row = parent.createDiv({ cls: "bt-card" + (key === this.selKey ? " is-active" : "") });
    row.createDiv({ cls: "bt-card-q", text: readable(c.q) || "(no question)" });
    if (c.a) row.createDiv({ cls: "bt-card-a", text: readable(c.a) });
    if (this.cfg.density === "expanded") {
      const meta: string[] = [];
      const src = plainValue(this.fieldOf(c, this.fieldNames.source));
      if (src) meta.push(src);
      meta.push(this.store.deckOf(c) || "no deck");
      meta.push(noteName(c.path));
      const nr = this.store.linksOf(c).length;
      if (nr) meta.push(nr + " related");
      const m = row.createDiv({ cls: "bt-card-meta", text: meta.join(" · ") });
      if (!c.id) m.createSpan({ cls: "bt-warn", text: " · no id" });
    }
    const st = this.store.ankiStatus(c);
    if (st !== "none") row.createDiv({ cls: "bt-card-status is-" + st, text: ANKI_LABEL[st] });
    row.addEventListener("click", () => this.selectCard(c));
  }

  /**
   * Card text with its links made usable: links to notes (concepts) open the
   * concept's page, links to other cards open that card. Shown as they read, without brackets.
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
          span.addEventListener("click", (e) => { e.stopPropagation(); this.editFromPage(card); });
        }
      } else {
        const k = this.store.conceptOf(l, path);
        const span = el.createSpan({ cls: "bt-concept-link" + (k.exists ? "" : " is-ghost"), text: shown });
        span.setAttr("title", "Open the page of " + k.name);
        span.addEventListener("click", (e) => { e.stopPropagation(); this.openPage(k.key); });
      }
    }
    if (pos < text.length) el.appendChild(document.createTextNode(text.slice(pos)));
  }

  private selectCard(c: Card): void {
    const key = cardKey(c);
    if (key === this.selKey) return;
    if (!this.confirmDiscard(key)) return;
    this.rememberScroll();
    this.openCard(c);
  }

  /** On narrow screens the list hides while the editor is open: remember where it was. */
  private rememberScroll(): void {
    if (this.narrow && !this.draft) this.listScroll = this.listEl.scrollTop;
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
    drawConceptMap(this.mapEl, this.store, focus, (c) => this.selectCard(c), (k) => this.openPage(k.key), (tools) => {
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

  // ── Concept page ─────────────────────────────────────────────────────────

  /** Open a concept's page in place of the list and editor (the editor keeps its state). */
  openPage(key: string): void {
    if (!this.store.allConcepts().some((e) => e.concept.key === key)) return;
    if (this.pageKey !== key) {
      this.pageKey = key;
      this.pageTab = "overview";
      this.pageOpen = new Set();
    }
    this.renderConcepts();
    this.renderPage();
    this.pageEl.scrollTop = 0;
  }

  private closePage(render = true): void {
    this.pageKey = null;
    this.bodyEl.removeClass("has-page");
    this.pageEl.empty();
    if (render) {
      this.renderConcepts();
      this.renderList();
    }
  }

  /** Leave the page and open a card in the editor, with the list showing the page's concept. */
  private editFromPage(c: Card): void {
    if (this.pageKey) {
      this.concept = this.pageKey;
      if (this.deck !== null && !this.inDeck(c, this.deck)) this.deck = null; // keep the card in sight
      this.closePage();
    }
    this.selectCard(c);
  }

  private conceptCards(key: string): Card[] {
    const e = this.store.allConcepts().find((x) => x.concept.key === key);
    return e ? this.sorted(e.cards.map((k) => this.store.get(k)).filter((x): x is Card => !!x)) : [];
  }

  /** The other concepts that share cards with this one, most shared first. */
  private nearby(key: string, cards: Card[]): ConceptEntry[] {
    const near = new Map<string, ConceptEntry>();
    for (const c of cards) {
      for (const o of this.store.conceptsOf(c)) {
        if (o.key === key) continue;
        const e = near.get(o.key) || { concept: o, cards: [] };
        if (!e.cards.includes(c)) e.cards.push(c);
        near.set(o.key, e);
      }
    }
    return Array.from(near.values()).sort((a, b) => b.cards.length - a.cards.length || a.concept.name.localeCompare(b.concept.name));
  }

  private renderPage(): void {
    const el = this.pageEl;
    if (!el) return;
    const keep = el.scrollTop;
    el.empty();
    if (this.pageKey) this.pageKey = this.currentKey(this.pageKey) ?? this.pageKey;
    const entry = this.pageKey ? this.store.allConcepts().find((e) => e.concept.key === this.pageKey) : undefined;
    if (this.pageKey && !entry) {
      // The concept is gone (its last card changed): back to the bank.
      this.closePage();
      return;
    }
    this.bodyEl.toggleClass("has-page", !!entry);
    if (!entry) return;
    const k = entry.concept;
    const cards = this.conceptCards(k.key);
    const near = this.nearby(k.key, cards);
    const sources = new Map<string, number>();
    for (const c of cards) for (const s of new Set(this.store.sourcesOf(c))) sources.set(s, (sources.get(s) || 0) + 1);

    const head = el.createDiv({ cls: "bt-page-head" });
    const titles = head.createDiv();
    titles.createDiv({ cls: "bt-page-kicker", text: "Concept overview" });
    const h = titles.createDiv({ cls: "bt-page-title", text: k.name });
    if (!k.exists) h.createSpan({ cls: "bt-page-ghost", text: "no note yet" });
    titles.createDiv({
      cls: "bt-page-stats",
      text: [plural(cards.length, "card"), plural(sources.size, "source"), plural(near.length, "connected concept")].join(" · "),
    });
    const acts = head.createDiv({ cls: "bt-page-actions" });
    const show = acts.createEl("button");
    setIcon(show.createSpan(), "filter");
    show.createSpan({ text: "Show in bank" });
    show.addEventListener("click", () => {
      this.concept = k.key;
      this.closePage();
    });
    const note = acts.createEl("button");
    setIcon(note.createSpan(), k.exists ? "file-text" : "file-plus");
    note.createSpan({ text: k.exists ? "Open note" : "Create note" });
    note.addEventListener("click", () => { void this.openConceptNote(k, cards[0]?.path || ""); });

    const tabs = el.createDiv({ cls: "bt-tabs" });
    for (const [id, label] of [["overview", "Overview"], ["connections", "Connections"]] as const) {
      const t = tabs.createEl("button", { cls: "bt-tab" + (this.pageTab === id ? " is-active" : ""), text: label });
      t.addEventListener("click", () => {
        this.pageTab = id;
        this.renderPage();
      });
    }

    if (this.pageTab === "overview") {
      const grid = el.createDiv({ cls: "bt-page-grid" });
      const main = grid.createDiv({ cls: "bt-page-main" });
      main.createDiv({ cls: "bt-page-h", text: "What you've captured" });
      for (const c of cards) this.pageCard(main, c, "", "overview");
      const side = grid.createDiv({ cls: "bt-page-side" });
      side.createDiv({ cls: "bt-page-h", text: "Explore nearby" });
      if (!near.length) side.createDiv({ cls: "bt-muted", text: "No card links this concept to another one yet." });
      for (const n of near) {
        const tile = side.createDiv({ cls: "bt-near" + (n.concept.exists ? "" : " is-ghost") });
        tile.createDiv({ cls: "bt-near-name", text: n.concept.name });
        tile.createDiv({ cls: "bt-near-count", text: plural(n.cards.length, "shared card") + " →" });
        tile.addEventListener("click", () => this.openPage(n.concept.key));
      }
      side.createDiv({ cls: "bt-page-h bt-page-h-gap", text: "Sources in these cards" });
      if (!sources.size) side.createDiv({ cls: "bt-muted", text: "These cards don't name a source." });
      for (const [s, n] of Array.from(sources.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
        const row = side.createDiv({ cls: "bt-page-source" });
        row.createSpan({ text: s });
        row.createSpan({ cls: "bt-tree-count", text: " " + n });
        row.setAttr("title", "Show these cards from " + s);
        row.addEventListener("click", () => {
          this.concept = k.key;
          this.source = s;
          this.closePage(false);
          this.renderFilters();
          this.renderConcepts();
          this.renderList();
        });
      }
    } else {
      const box = el.createDiv({ cls: "bt-conns" });
      box.createDiv({ cls: "bt-muted bt-conns-hint", text: "Cards that link " + k.name + " to another concept. Open a card to read its answer, or click a concept to go to its page." });
      if (!near.length) box.createDiv({ cls: "bt-empty", text: "No card links " + k.name + " to another concept yet." });
      for (const n of near) {
        const g = box.createDiv({ cls: "bt-conn-group" });
        const gh = g.createDiv({ cls: "bt-conn-head" });
        gh.createSpan({ text: k.name });
        setIcon(gh.createSpan({ cls: "bt-conn-arrow" }), "arrow-left-right");
        const other = gh.createSpan({ cls: "bt-concept-link" + (n.concept.exists ? "" : " is-ghost"), text: n.concept.name });
        other.addEventListener("click", () => this.openPage(n.concept.key));
        gh.createSpan({ cls: "bt-tree-count", text: plural(n.cards.length, "card") });
        for (const c of n.cards) this.pageCard(g, c, "↳", n.concept.key);
      }
    }
    el.scrollTop = keep;
  }

  /** A card on the concept page: the question, with the answer and its details shown on click. */
  private pageCard(parent: HTMLElement, c: Card, mark: string, where: string): void {
    const key = where + "\n" + cardKey(c); // the same card can show in several places, each opens on its own
    const item = parent.createDiv({ cls: "bt-pc" + (this.pageOpen.has(key) ? " is-open" : "") });
    const head = item.createDiv({ cls: "bt-pc-head" });
    if (mark) head.createSpan({ cls: "bt-pc-mark", text: mark });
    head.createSpan({ cls: "bt-pc-q", text: readable(c.q) || "(no question)" });
    const tog = head.createSpan({ cls: "bt-pc-toggle" });
    const body = item.createDiv({ cls: "bt-pc-body" });
    this.richText(body.createDiv({ cls: "bt-pc-a" }), c.a || "(no answer)", c.path);
    const meta = body.createDiv({ cls: "bt-pc-meta" });
    const src = plainValue(this.fieldOf(c, this.fieldNames.source));
    meta.createSpan({ text: (src ? src + " · " : "") + noteName(c.path) + " · " });
    const edit = meta.createSpan({ cls: "bt-pc-edit", text: "Edit card" });
    edit.addEventListener("click", (e) => { e.stopPropagation(); this.editFromPage(c); });
    const draw = () => setIcon(tog, item.hasClass("is-open") ? "minus" : "plus");
    draw();
    head.addEventListener("click", () => {
      item.toggleClass("is-open", !item.hasClass("is-open"));
      if (item.hasClass("is-open")) this.pageOpen.add(key);
      else this.pageOpen.delete(key);
      draw();
    });
  }

  // ── Editor ───────────────────────────────────────────────────────────────

  /** Re-draws the parts of the open editor that depend on other cards (set by renderEditor). */
  private editorLive: (() => void) | null = null;

  private renderEditorLive(): void {
    this.editorLive?.();
  }

  /** A collapsible editor section whose open/closed state is remembered. */
  private section(parent: HTMLElement, id: keyof SectionState, title: string): { body: HTMLElement; setSummary: (s: string) => void } {
    const sec = parent.createDiv({ cls: "bt-sec" + (this.cfg.open[id] ? " is-open" : ""), attr: { "data-section": id } });
    const head = sec.createDiv({ cls: "bt-sec-head" });
    setIcon(head.createSpan({ cls: "bt-sec-chev" }), "chevron-right");
    head.createSpan({ cls: "bt-sec-title", text: title });
    const sum = head.createSpan({ cls: "bt-sec-sum" });
    const body = sec.createDiv({ cls: "bt-sec-body" });
    head.addEventListener("click", () => {
      this.cfg.open[id] = !this.cfg.open[id];
      sec.toggleClass("is-open", this.cfg.open[id]);
      void this.plugin.saveSettings();
    });
    return { body, setSummary: (s) => sum.setText(s) };
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

    // Back to the list (narrow screens only).
    const nav = el.createDiv({ cls: "bt-ed-nav" });
    const back = nav.createEl("button", { cls: "bt-ed-back" });
    setIcon(back.createSpan(), "chevron-left");
    back.createSpan({ text: "Cards" });
    back.addEventListener("click", () => {
      if (!this.confirmDiscard("close")) return;
      this.closeEditor();
    });
    const pos = this.selKey ? this.hitKeys.indexOf(this.selKey) : -1;
    if (pos >= 0) nav.createSpan({ cls: "bt-muted", text: pos + 1 + " of " + this.hitKeys.length });

    const head = el.createDiv({ cls: "bt-ed-head" });
    head.createDiv({ cls: "bt-ed-title", text: isNew ? "New card" : "Edit card" });
    if (c && !isNew) head.createDiv({ cls: "bt-ed-note", text: noteName(c.path) });
    const close = head.createEl("button", { cls: "clickable-icon bt-ed-close", attr: { "aria-label": "Close" } });
    setIcon(close, "x");
    close.addEventListener("click", () => {
      if (!this.confirmDiscard("close")) return;
      this.closeEditor();
    });

    if (isNew) {
      // Where the card goes: a note, and a section of it (or its end).
      const where = el.createDiv({ cls: "bt-ed-where" });
      where.createSpan({ cls: "bt-ed-where-label", text: "Note" });
      const wrap = where.createDiv({ cls: "bt-note-pick" });
      const inp = wrap.createEl("input", { type: "text", value: this.newNote, placeholder: "Target note" });
      new InlineSuggest(inp, (q) => this.noteItems(q), (it) => { inp.value = it.value; this.setNewNote(it.value); }, true);
      inp.addEventListener("change", () => this.setNewNote(inp.value));
      where.createSpan({ cls: "bt-ed-where-label", text: "Section" });
      const sel = where.createEl("select", { cls: "dropdown bt-section" });
      sel.createEl("option", { value: "", text: "End of note" });
      sel.addEventListener("change", () => {
        this.newSection = sel.value ? (JSON.parse(sel.value) as SectionRef) : null;
      });
      void this.fillSections(sel, this.newNote);
    }

    // 1. Question and answer
    const qIn = area(el, "Question", d.q, 2, "What does [[Tier 2 capital]] measure?", "bt-q");
    const qErr = el.createDiv({ cls: "bt-error" });
    const aIn = area(el, "Answer", d.a, 3, "A single line", "bt-a");

    // 2. Source and deck
    const sd = this.section(el, "sourceDeck", "Source and deck");
    const sourceIn = input(sd.body, F.source, d.source, "A vault file ([[…]]) or text");
    sourceIn.addClass("bt-source");
    const deckIn = input(sd.body, F.deck, d.deck, "Anki deck name");
    deckIn.addClass("bt-deck");
    setIcon(deckIn.parentElement!.createSpan({ cls: "bt-select-icon" }), "chevrons-up-down");
    sd.body.createDiv({ cls: "bt-muted bt-hint", text: "Only cards with a deck are synced with Anki." });
    new InlineSuggest(deckIn, (q) => this.valueItems(q, (x) => this.store.deckOf(x)), (it) => { deckIn.value = it.value; sync(); }, true, true);
    new InlineSuggest(sourceIn, (q) => this.fileItems(q), (it) => {
      const v = sourceIn.value;
      const k = v.lastIndexOf(",");
      sourceIn.value = (k >= 0 ? v.slice(0, k + 1) + " " : "") + it.value;
      sync();
    }, false, true);

    // 3. Concepts and related cards
    const cn = this.section(el, "connections", "Connections");
    cn.body.createDiv({ cls: "bt-label", text: "Concepts · links in the question and answer" });
    const conceptsBox = cn.body.createDiv({ cls: "bt-chips" });
    cn.body.createDiv({ cls: "bt-label", text: F.related });
    const chips = cn.body.createDiv({ cls: "bt-chips" });
    const connWrap = cn.body.createDiv();
    const connIn = connWrap.createEl("input", { type: "text", placeholder: "Relate to… (search by question)", cls: "bt-input" });
    const viaLine = cn.body.createDiv({ cls: "bt-via-line" });
    const viaBox = cn.body.createDiv({ cls: "bt-via" });
    let conceptCount = 0;
    const summarize = () => cn.setSummary(plural(conceptCount, "concept") + (d.conns.length ? " · " + d.conns.length + " related" : ""));

    const drawConcepts = () => {
      const list = this.store.conceptsInText(d.q, d.a, pathNow());
      conceptCount = list.length;
      summarize();
      conceptsBox.empty();
      if (!list.length) conceptsBox.createSpan({ cls: "bt-muted", text: "None yet. Write [[a note]] in the question or answer to link this card to a concept." });
      const indexed = new Set(this.store.allConcepts().map((e) => e.concept.key));
      for (const k of list) {
        const chip = conceptsBox.createDiv({ cls: "bt-chip bt-chip-concept is-clickable" + (k.exists ? "" : " is-ghost") });
        chip.createSpan({ cls: "bt-chip-text", text: k.name });
        if (!k.exists) chip.createSpan({ cls: "bt-chip-note", text: "no note yet" });
        const hasPage = indexed.has(k.key);
        chip.setAttr("title", hasPage ? "Open the concept page" : k.exists ? "Open the note" : "Create the note");
        chip.addEventListener("click", () => {
          if (hasPage) this.openPage(k.key);
          else void this.openConceptNote(k, pathNow());
        });
        const f = chip.createSpan({ cls: "bt-chip-x", attr: { "aria-label": k.exists ? "Open the note" : "Create the note" } });
        setIcon(f, k.exists ? "file-text" : "file-plus");
        f.addEventListener("click", (e) => { e.stopPropagation(); void this.openConceptNote(k, pathNow()); });
      }
      const groups = this.store.relatedByConcept(list, isNew ? null : this.selKey).filter((g) => g.cards.length);
      const others = new Set(groups.flatMap((g) => g.cards.map(cardKey)));
      viaLine.empty();
      viaBox.empty();
      if (!list.length) return;
      if (!others.size) {
        viaLine.createSpan({ text: "No other card mentions these concepts yet." });
      } else {
        viaLine.createSpan({ text: plural(others.size, "other card") + " share these concepts · " });
        const t = viaLine.createSpan({ cls: "bt-link", text: this.cfg.open.via ? "Hide" : "Show" });
        t.addEventListener("click", () => {
          this.cfg.open.via = !this.cfg.open.via;
          void this.plugin.saveSettings();
          drawConcepts();
        });
      }
      viaLine.createSpan({ text: " · " });
      const mapLink = viaLine.createSpan({ cls: "bt-link", text: this.cfg.showMap ? "Hide concept map" : "Concept map" });
      mapLink.addEventListener("click", () => { this.toggleMap(); drawConcepts(); });
      if (!this.cfg.open.via) return;
      for (const g of groups) {
        const grp = viaBox.createDiv({ cls: "bt-via-group" });
        const h = grp.createDiv({ cls: "bt-via-head" });
        const name = h.createSpan({ cls: "bt-concept-link" + (g.concept.exists ? "" : " is-ghost"), text: g.concept.name });
        name.setAttr("title", "Open the concept page");
        name.addEventListener("click", () => this.openPage(g.concept.key));
        h.createSpan({ cls: "bt-tree-count", text: " " + g.cards.length });
        for (const o of g.cards) {
          const r = grp.createDiv({ cls: "bt-via-card", text: plainValue(o.q) || "(no question)" });
          r.addEventListener("click", () => this.selectCard(o));
        }
      }
    };

    // Related cards: only this card's own Related field. (Links from other cards show in the concept map.)
    const drawChips = () => {
      chips.empty();
      summarize();
      if (!d.conns.length) chips.createSpan({ cls: "bt-muted", text: "None." });
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
    new InlineSuggest(connIn, (q) => this.cardItems(q, d), (it) => {
      d.conns.push({ key: it.value });
      const t = this.store.get(it.value);
      if (t && !t.id && !this.plannedIds.has(it.value)) this.plannedIds.set(it.value, newId(new Set(this.idsIn(t.path))));
      connIn.value = "";
      drawChips();
      sync();
    });

    // 4. Advanced details
    const adv = this.section(el, "advanced", "Advanced details");
    adv.setSummary("Markdown, id");
    adv.body.createDiv({ cls: "bt-label", text: "Line that will be written to the note" });
    const preview = adv.body.createDiv({ cls: "bt-preview" });
    const facts = adv.body.createDiv({ cls: "bt-facts" });
    const fact = (label: string, value: string, cls = "") => {
      const r = facts.createDiv({ cls: "bt-fact" });
      r.createSpan({ cls: "bt-fact-label", text: label });
      r.createSpan({ cls: "bt-fact-value " + cls, text: value });
    };
    if (isNew) fact("Card id", "^" + (this.plannedIds.get("new") || ""), "bt-mono");
    else if (c) {
      fact("Note", c.path + ", line " + (c.line + 1));
      if (c.id) fact("Card id", "^" + c.id, "bt-mono");
      else fact("Card id", "none yet · gets ^" + this.plannedIds.get(this.selKey!) + " on save", "bt-warn");
      const st = this.store.ankiStatus(c);
      fact("Anki", st === "none" ? "Not synced (no deck)" : ANKI_LABEL[st]);
    }

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

    const summarizeSD = () => {
      const vals = [plainValue(d.source), d.deck.trim()].filter(Boolean);
      sd.setSummary(vals.length ? vals.join(" · ") : "Empty");
    };
    const sync = () => {
      d.q = qIn.value.replace(/[\r\n]+/g, " ");
      d.a = aIn.value.replace(/[\r\n]+/g, " ");
      d.deck = deckIn.value;
      d.source = sourceIn.value;
      this.dirty = true;
      qErr.setText("");
      preview.setText(this.previewLine(d));
      summarizeSD();
      drawConcepts();
    };
    for (const i of [qIn, aIn, deckIn, sourceIn]) i.addEventListener("input", sync);
    for (const i of [qIn, aIn]) i.addEventListener("keydown", (e: Event) => {
      const k = e as KeyboardEvent;
      if (k.key === "Enter" && (k.ctrlKey || k.metaKey)) { k.preventDefault(); saveBtn.click(); }
      else if (k.key === "Enter") k.preventDefault();
    });
    preview.setText(this.previewLine(d));
    summarizeSD();
    drawChips();
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
          key = await this.store.create(this.newNote, d, this.plannedIds, this.newSection);
          this.cfg.lastNote = this.newNote;
          if (this.newSection) this.cfg.lastSection[this.newNote] = this.newSection;
          else delete this.cfg.lastSection[this.newNote];
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
          if (isNew && err.kind === "missing") {
            // The chosen section is gone: show the note's current sections again.
            this.newSection = null;
            this.renderEditor();
          }
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
  private async openConceptNote(k: Concept, sourcePath: string): Promise<void> {
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
    if (this.narrow) this.listEl.scrollTop = this.listScroll;
  }

  private setNewNote(path: string): void {
    const p = path.trim() ? normalizePath(path.trim()) : "";
    if (p === this.newNote) return;
    this.newNote = p;
    this.newSection = this.cfg.lastSection[p] ?? null;
    this.plannedIds.set("new", newId(new Set(this.idsIn(this.newNote))));
    // Redraw after the current focus/blur events finish: redrawing removes the input that fired them.
    window.setTimeout(() => {
      if (this.selKey === "new") this.renderEditor();
    }, 0);
  }

  /** List a note's headings in the section dropdown, indented by level, and select the current one. */
  private async fillSections(sel: HTMLSelectElement, path: string): Promise<void> {
    const f = this.app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) {
      this.newSection = null;
      return;
    }
    const heads = headingsOf(await this.app.vault.cachedRead(f));
    if (path !== this.newNote || !sel.isConnected) return; // the note changed while reading
    const top = Math.min(...heads.map((h) => h.level));
    let found = false;
    for (const h of heads) {
      const ref: SectionRef = { level: h.level, text: h.text, nth: h.nth };
      const label = "\u00a0\u00a0\u00a0".repeat(h.level - top) + h.text + (h.nth ? " (" + (h.nth + 1) + ")" : "");
      const o = sel.createEl("option", { value: JSON.stringify(ref), text: label });
      const cur = this.newSection;
      if (cur && cur.level === h.level && cur.text === h.text && cur.nth === h.nth) {
        o.selected = true;
        found = true;
      }
    }
    if (!found) {
      this.newSection = null;
      sel.value = "";
    }
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

// ── small helpers ──────────────────────────────────────────────────────────

export function noteName(path: string): string {
  return path.split("/").pop()!.replace(/\.md$/, "");
}

/** Card text as it reads: links without brackets (embeds are left as they are). */
function readable(s: string): string {
  return s.replace(/(^|[^!])\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_m, pre: string, t: string, al?: string) => pre + (al || (t.split("#")[0] ?? ""))).trim();
}

function plural(n: number, word: string): string {
  return n + " " + word + (n === 1 ? "" : "s");
}

function fillSelect(sel: HTMLSelectElement, allLabel: string, values: string[], current: string, show: (v: string) => string) {
  sel.empty();
  sel.createEl("option", { value: "", text: allLabel });
  for (const v of values) sel.createEl("option", { value: v, text: show(v) });
  sel.value = values.includes(current) ? current : "";
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
