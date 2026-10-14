// A small dropdown of suggestions under an input. Kept in-house (rather than
// Obsidian's AbstractInputSuggest) so it renders inside the editor panel and
// behaves the same on every Obsidian version.

export interface SuggestItem {
  label: string;
  hint?: string;
  value: string;
}

export class InlineSuggest {
  private box: HTMLDivElement;
  private items: SuggestItem[] = [];
  private active = -1;

  constructor(
    private input: HTMLInputElement | HTMLTextAreaElement,
    private source: (query: string) => SuggestItem[],
    private pick: (item: SuggestItem) => void,
    private showEmpty = false
  ) {
    const wrap = input.parentElement as HTMLElement;
    wrap.addClass("bt-suggest-wrap");
    this.box = wrap.createDiv({ cls: "bt-suggest" });
    this.box.hide();
    input.addEventListener("input", () => this.refresh());
    input.addEventListener("focus", () => this.refresh());
    input.addEventListener("blur", () => window.setTimeout(() => this.close(), 150));
    input.addEventListener("keydown", (e: Event) => this.key(e as KeyboardEvent));
  }

  refresh(): void {
    const q = this.input.value;
    if (!q.trim() && !this.showEmpty) return this.close();
    this.items = this.source(q).slice(0, 8);
    this.active = this.items.length ? 0 : -1;
    this.render();
  }

  close(): void {
    this.items = [];
    this.box.hide();
  }

  private render(): void {
    this.box.empty();
    if (!this.items.length) return this.close();
    this.items.forEach((it, i) => {
      const row = this.box.createDiv({ cls: "bt-suggest-item" + (i === this.active ? " is-active" : "") });
      row.createSpan({ text: it.label });
      if (it.hint) row.createSpan({ cls: "bt-suggest-hint", text: it.hint });
      row.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.choose(i);
      });
    });
    this.box.show();
  }

  private choose(i: number): void {
    const it = this.items[i];
    this.close();
    if (it) this.pick(it);
  }

  private key(e: KeyboardEvent): void {
    if (!this.items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = this.items.length;
      this.active = (this.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      this.render();
    } else if (e.key === "Enter" || e.key === "Tab") {
      if (this.active >= 0) {
        e.preventDefault();
        this.choose(this.active);
      }
    } else if (e.key === "Escape") {
      e.stopPropagation();
      this.close();
    }
  }
}
