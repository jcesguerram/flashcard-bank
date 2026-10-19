import { App, Notice, Plugin, PluginSettingTab, Setting, TAbstractFile, TFile } from "obsidian";
import { CardStore, DEFAULT_ANKI, DEFAULT_FIELDS, DEFAULT_OPEN, DEFAULT_SETTINGS, FieldNames, Settings } from "./store";
import { BankView, VIEW_TYPE } from "./view";
import { AnkiConnect } from "./anki";
import { syncWithAnki } from "./ankiui";
import { renameInMap } from "./sync";

export default class FlashcardBankPlugin extends Plugin {
  settings: Settings = { ...DEFAULT_SETTINGS };
  store!: CardStore;
  anki = new AnkiConnect(() => this.settings.anki.url);
  ankiModels: Record<string, string[]> | null = null; // read from Anki by the settings tab
  syncing = false; // a sync is under way (from the first read of Anki to the result)

  async onload() {
    await this.loadSettings();
    this.store = new CardStore(this.app, () => this.settings);

    this.registerView(VIEW_TYPE, (leaf) => new BankView(leaf, this));
    this.addRibbonIcon("layers", "Open flashcard bank", () => { void this.openView(); });
    this.addCommand({ id: "open", name: "Open bank", callback: () => { void this.openView(); } });
    this.addCommand({
      id: "new-card",
      name: "New card",
      callback: async () => { (await this.openView())?.startNew(); },
    });
    this.addCommand({ id: "sync-anki", name: "Sync with Anki", callback: () => { void this.syncAnki(); } });
    this.addSettingTab(new BankSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      this.store.rebuild().catch((e) => { void this.logError("rebuild", e); });
      this.registerEvent(this.app.metadataCache.on("changed", (file: TFile, data: string) => { void this.store.updateFile(file, data); }));
      // Concept links resolve to notes, so creating, renaming or deleting any note can change them.
      this.registerEvent(this.app.vault.on("create", () => this.store.linksMayHaveChanged()));
      this.registerEvent(this.app.vault.on("delete", (file: TAbstractFile) => {
        this.store.removePath(file.path);
        this.store.linksMayHaveChanged();
      }));
      this.registerEvent(this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
        // Keep synced cards paired with their Anki notes when a note or folder moves.
        if (renameInMap(this.settings.ankiMap, oldPath, file.path)) void this.saveSettings();
        this.store.removePath(oldPath);
        if (file instanceof TFile) void this.store.updateFile(file);
        this.store.linksMayHaveChanged();
      }));
    });
  }

  async openView(): Promise<BankView | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing || this.app.workspace.getLeaf("tab");
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof BankView ? leaf.view : null;
  }

  /** Record an unexpected error in error.log inside the plugin folder, so it can be diagnosed. */
  async logError(where: string, err: unknown): Promise<void> {
    const e = err as Error;
    const line = `[${new Date().toISOString()}] ${where}: ${e && e.stack ? e.stack : String(err)}\n`;
    console.error("[flashcard-bank] " + where, err);
    try {
      const dir = this.manifest.dir || this.app.vault.configDir + "/plugins/" + this.manifest.id;
      await this.app.vault.adapter.append(dir + "/error.log", line);
    } catch {
      /* logging must never throw */
    }
  }

  /** Append lines to error.log in the plugin folder (never throws). */
  async appendLog(where: string, lines: string[]): Promise<void> {
    const text = `[${new Date().toISOString()}] ${where}:\n` + lines.map((l) => "  " + l).join("\n") + "\n";
    try {
      const dir = this.manifest.dir || this.app.vault.configDir + "/plugins/" + this.manifest.id;
      await this.app.vault.adapter.append(dir + "/error.log", text);
    } catch {
      /* logging must never throw */
    }
  }

  /** Sync with Anki, one sync at a time. */
  async syncAnki(): Promise<void> {
    if (this.syncing) {
      new Notice("A sync with Anki is already running.");
      return;
    }
    this.setSyncing(true);
    try {
      const wrote = await syncWithAnki(this);
      // The register changed: let the bank redraw its Anki status labels.
      if (wrote) this.store.linksMayHaveChanged();
    } catch (e) {
      void this.logError("sync", e);
      new Notice("The sync with Anki failed: " + (e as Error).message, 8000);
    } finally {
      this.setSyncing(false);
    }
  }

  private setSyncing(on: boolean): void {
    this.syncing = on;
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view instanceof BankView) leaf.view.setSyncBusy(on);
    }
  }

  /** Re-render open bank tabs after a settings change. */
  refreshViews(): void {
    this.store.rebuild().catch((e) => { void this.logError("rebuild", e); });
  }

  async loadSettings() {
    type Stored = Partial<Omit<Settings, "fields">> & {
      fields?: Partial<FieldNames> & { topic?: string };
      inheritTopic?: unknown;
      mode?: unknown;
    };
    const data = ((await this.loadData()) ?? {}) as Stored;
    // Settings of features that no longer exist (topics, nesting, outline mode).
    delete data.inheritTopic;
    delete data.mode;
    const fields = { ...(data.fields || {}) };
    delete fields.topic;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...data,
      fields: { ...DEFAULT_FIELDS, ...fields },
      anki: { ...DEFAULT_ANKI, ...(data.anki || {}) },
      ankiMap: data.ankiMap || {},
      density: data.density === "expanded" ? "expanded" : "compact",
      open: { ...DEFAULT_OPEN, ...(data.open || {}) },
      lastSection: { ...(data.lastSection || {}) },
    };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

class BankSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: FlashcardBankPlugin) {
    super(app, plugin);
  }

  display(): void {
    const el = this.containerEl;
    el.empty();
    const s = this.plugin.settings;
    const changed = async () => {
      await this.plugin.saveSettings();
      await this.plugin.store.rebuild();
    };

    new Setting(el)
      .setName("Card tag")
      .setDesc("List items carrying this tag are cards.")
      .addText((t) => t.setValue(s.tag).onChange(async (v) => {
        s.tag = v.trim() ? (v.trim().startsWith("#") ? v.trim() : "#" + v.trim()) : DEFAULT_SETTINGS.tag;
        await changed();
      }));

    new Setting(el)
      .setName("Excluded folders")
      .setDesc("One per line. Cards inside them are ignored (for example, templates).")
      .addTextArea((t) => t.setValue(s.exclude.join("\n")).onChange(async (v) => {
        s.exclude = v.split("\n").map((x) => x.trim()).filter(Boolean);
        await changed();
      }));

    new Setting(el)
      .setName("New card prefix")
      .setDesc("What goes before the question on cards created from the bank, e.g. \"- \" or \"- [?] \".")
      .addText((t) => t.setValue(s.newPrefix).onChange(async (v) => {
        s.newPrefix = v || DEFAULT_SETTINGS.newPrefix;
        if (!s.newPrefix.endsWith(" ")) s.newPrefix += " ";
        await this.plugin.saveSettings();
      }));

    new Setting(el).setName("Field names").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "How the inline fields on your card lines are named. Changing a name here doesn't rename anything in your notes: it only tells the plugin which field to read and write.",
    });
    const rows: [keyof FieldNames, string, string][] = [
      ["source", "Source", "Where the card comes from."],
      ["related", "Related", "Direct links to other cards."],
      ["deck", "Deck", "Anki deck. Only cards that have one are synced."],
    ];
    for (const [key, label, desc] of rows) {
      new Setting(el)
        .setName(label)
        .setDesc(desc + " Default: " + DEFAULT_FIELDS[key] + ".")
        .addText((t) => t.setValue(s.fields[key]).onChange(async (v) => {
          s.fields[key] = v.trim() || DEFAULT_FIELDS[key];
          await this.plugin.saveSettings();
          this.plugin.refreshViews();
        }));
    }

    this.ankiSection(el);
  }

  private ankiSection(el: HTMLElement): void {
    const a = this.plugin.settings.anki;
    const save = async () => { await this.plugin.saveSettings(); };
    new Setting(el).setName("Anki").setHeading();
    el.createEl("p", {
      cls: "setting-item-description",
      text: "One-way sync (Obsidian → Anki) through the AnkiConnect add-on. Anki must be open. Only cards with a " + this.plugin.store.f.deck + " are synced.",
    });
    new Setting(el)
      .setName("Connection address")
      .setDesc("Where AnkiConnect listens. Default: " + DEFAULT_ANKI.url)
      .addText((t) => t.setValue(a.url).onChange(async (v) => { a.url = v.trim() || DEFAULT_ANKI.url; await save(); }));
    const status = el.createEl("p", { cls: "setting-item-description" });
    new Setting(el)
      .setName("Test connection")
      .setDesc("Reads the note types and their fields from Anki so you can pick them below.")
      .addButton((b) => b.setButtonText("Connect").onClick(async () => {
        status.setText("Connecting…");
        try {
          const names: string[] = await this.plugin.anki.call("modelNames");
          const models: Record<string, string[]> = {};
          for (const n of names) models[n] = await this.plugin.anki.call("modelFieldNames", { modelName: n });
          this.plugin.ankiModels = models;
          this.display();
        } catch (e) {
          status.setText((e as Error).message);
        }
      }));
    const models = this.plugin.ankiModels;
    if (models) {
      const names = Object.keys(models);
      new Setting(el).setName("Note type").addDropdown((d) => {
        for (const n of names) d.addOption(n, n);
        if (!names.includes(a.model)) d.addOption(a.model, a.model + " (not in Anki)");
        d.setValue(a.model).onChange((v) => {
          a.model = v;
          const f = models[v] || [];
          if (!f.includes(a.frontField)) a.frontField = f[0] || a.frontField;
          if (!f.includes(a.backField)) a.backField = f[1] || a.backField;
          void save().then(() => this.display());
        });
      });
      const fields = models[a.model] || [];
      for (const [key, label] of [["frontField", "Question field"], ["backField", "Answer field"]] as const) {
        new Setting(el).setName(label).addDropdown((d) => {
          for (const f of fields) d.addOption(f, f);
          if (!fields.includes(a[key])) d.addOption(a[key], a[key] + " (doesn't exist)");
          d.setValue(a[key]).onChange((v) => { a[key] = v; void save(); });
        });
      }
    } else {
      new Setting(el).setName("Note type").setDesc("Connect to pick from a list.").addText((t) => t.setValue(a.model).onChange(async (v) => { a.model = v.trim() || DEFAULT_ANKI.model; await save(); }));
      new Setting(el).setName("Question field").addText((t) => t.setValue(a.frontField).onChange(async (v) => { a.frontField = v.trim() || DEFAULT_ANKI.frontField; await save(); }));
      new Setting(el).setName("Answer field").addText((t) => t.setValue(a.backField).onChange(async (v) => { a.backField = v.trim() || DEFAULT_ANKI.backField; await save(); }));
    }
    new Setting(el)
      .setName("Anki tag")
      .setDesc("Marks the notes the plugin creates. Only notes that carry it and that the plugin remembers creating are ever updated or deleted. Change it only if you know what you're doing: notes with the old tag would become protected (left untouched).")
      .addText((t) => t.setValue(a.tag).onChange(async (v) => { a.tag = v.trim().replace(/\s+/g, "-") || DEFAULT_ANKI.tag; await save(); }));
    const n = Object.keys(this.plugin.settings.ankiMap).length;
    el.createEl("p", { cls: "setting-item-description", text: n + (n === 1 ? " card paired" : " cards paired") + " with Anki notes." });
  }
}
