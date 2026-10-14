# Flashcard Bank

An Obsidian plugin for flashcards written as list items in your notes. It gathers them into a bank where you can:

- browse them by the concepts they link to
- search and filter them
- edit them in a form instead of in the raw line
- see how they hang together, card by card, on a concept map
- sync the ones you choose to Anki

Your notes stay the only source of truth. The plugin keeps no copy of the cards: it reads them from the notes every time and writes edits straight back into each card's own line.

## Installation

From Obsidian: Settings → Community plugins → Browse, search for **Flashcard Bank**, install it, then enable it.

Manually: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/flashcard-bank/`, then enable **Flashcard Bank** in Settings → Community plugins.

It requires Obsidian 1.7.2 or later.

## Network use

The plugin makes no network requests except for the optional Anki sync. When you sync, it talks to the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on running inside Anki on your own computer (by default `http://127.0.0.1:8765`). Nothing is sent anywhere else, and there's no telemetry.

## Opening it

- The **layers** icon in the ribbon (*Open flashcard bank*), or
- Command palette → **Flashcard Bank: Open bank**
- Command palette → **Flashcard Bank: New card** opens the bank with an empty card form.

## What counts as a card

Any list item that carries the card tag (`#flashcard` by default):

```markdown
- What does [[Tier 2 capital]] measure? – Losses once the bank is no longer a going concern [Source:: [[Book.pdf]]] [Related:: ] [Deck:: Finance] #flashcard ^e57187
```

- **Question and answer** are split on the first ` – `, ` — ` or ` - `.
- **Fields** are inline fields (`[Name:: value]`). The three the plugin uses (source, related, deck) have configurable names (see *Field names*). Any other inline field on the line is left untouched.
- **Block id**: the `^id` at the end of the card. A card whose id sits alone on the next line (no blank line in between) is read correctly too.
- **A list marker or checkbox** before the question (`- `, `- [ ] `, `- [?] `…) is kept as is.
- **Indentation** doesn't mean anything: a card indented under another card is read exactly like any other card.
- **Skipped**: folders listed under *Excluded folders*, fenced code blocks, frontmatter, and list items without the tag (`#flashcards` doesn't count).

## How cards connect

| Connection | How you write it | Meaning |
|------------|------------------|---------|
| **Concepts** | `[[links]]` to notes in the question or answer | The card is about that concept. Every card that mentions the same concept is grouped around it, without you having to know which cards exist. |
| **Related** | Block links (`[[Note#^id]]`) in the *Related* field, or in the question or answer | A direct link to one specific card. It's written on one card; the concept map shows it from both sides. |

### Concepts

A concept is a note linked from a card's question or answer. Links in fields (the source, for example) don't count, and neither do embeds (`![[image.png]]`).

- **Matched through Obsidian.** Links are resolved like any other link, so different spellings that lead to the same note (its aliases, a different capitalization, a link to one of its headings) are the same concept.
- **The note doesn't have to exist.** A link to a note you haven't created yet is still a concept, shown dashed, with "no note yet". It's matched by name, ignoring capitalization. Once you create the note, it becomes a normal concept.
- **Specific is better.** A concept mentioned by every card doesn't tell you anything; links work best on precise ideas.

Since they're ordinary links, concepts also work outside the plugin: a concept note's backlinks list every card that mentions it, and the graph view shows the notes your cards live in connected to their concepts.

## The bank

| Area | What it does |
|------|--------------|
| **Concepts** (left) | Every concept, with how many cards mention it, most-used first. Click one to show only its cards; *No concepts* collects cards that don't link to any. |
| **List** (middle) | Every matching card with its answer. Concept links are highlighted: click one to filter by it. A link to another card opens that card. |
| **Pills** | Source, deck, ↔ number of links in the card's *Related* field, the note, **no id** when the card has no block id, and the Anki status. |
| **Toolbar** | Search across questions, answers and every field, a source filter (each linked file, plus any plain-text source), a note filter, **Map**, **Anki** and **New card**. |
| **Map** | The concept map of the open card, under the list. The card is on the left, its concepts in the middle, and the other cards that mention each concept on the right. A card sharing several concepts is drawn once with a line from each, so the cards that bridge concepts stand out. Related cards get ↔, or a dashed line when they share no concept. Clicking a card centers the map on it; clicking a concept filters the bank. The map shrinks to fit the column; **Expand** in its header hides the list so the map gets the whole middle column, and **Back to list** restores it. |
| **Editor** (right) | Opens when you click a card. In a narrow pane it moves below the list. |

## The editor

- **Question / Answer**: single line each. Enter doesn't add line breaks (Ctrl/Cmd+Enter saves).
- **Concepts**: the concepts linked in the question and answer, updated as you type. Click one to open its note (or create it, if it doesn't exist yet); the filter icon shows every card that mentions it.
- **Related through concepts**: the other cards that mention the same concepts, grouped by concept. Click a card to open it.
- **Deck**: the Anki deck. Suggests decks already in use.
- **Source**: free text, or type part of a file name and pick it to insert `[[file]]`. Separate several sources with commas.
- **Related**: the links in this card's own *Related* field (× removes one). Type in the search box to add a link. Links written on other cards to this one aren't listed here; they show in the concept map.
- **Line that will be written to the note** shows exactly what Save will write.
- **Open in note** opens the note at the card's line in a new tab.

### Creating cards

**New card** opens an empty form. The **Appended to the end of** note picker defaults to the note of the card you had open, or the last note you added to. The card is appended at the end of that note after a blank line.

New cards start with the *New card prefix* from the settings, the source and related fields (empty ones as `[Field:: ]`), the deck if you gave one, the card tag, and a fresh block id.

## What the plugin writes, and when

The plugin only writes when you click **Save** (or confirm a sync), and only these things:

1. **The edited card's line, rewritten in place.** Only the parts you changed are replaced; everything else on the line stays byte-for-byte the same, including indentation, other fields, tags, spacing and an id on its own line. A field the card doesn't have yet (for example the deck) is added after its last field, but only if you gave it a value.
2. **A block id**, when the card has none: 6 random lowercase letters and digits, checked against every `^id` already in that note.
3. **A block id on a related card**, when you link to a card that has none (the chip shows `+id`).
4. **New cards**, appended to the end of a note.

The plugin never moves existing lines.

### Conflict protection

When the editor opens a card, it remembers the card's exact text. On save, the plugin finds the card again (by block id, or by line if it has none) and checks that the text is unchanged. If the line was edited in the note in the meantime, **nothing is written**: you get a notice and the editor reloads with the current text.

The bank refreshes on its own when you edit a note directly. An open card without unsaved changes reloads automatically.

### Undo

A save from the bank is a normal file write, so Ctrl/Cmd+Z inside the note doesn't undo it. Fix the card from the bank, or edit the line by hand.

## Anki sync

One-way sync, Obsidian → Anki, through the [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on. Obsidian always wins: edits made to these notes inside Anki are overwritten by the next sync.

### Setup

1. In Anki: Tools → Add-ons → Get Add-ons…, code `2055492159`, then restart Anki.
2. In the plugin settings, under **Anki**, click **Connect**. That reads your Anki's note types so you can pick the type and the fields that get the question and the answer. The defaults are `Basic` / `Front` / `Back`; on Anki in another language they're named differently (e.g. `Básico` / `Anverso` / `Reverso`).
3. Anki must be open whenever you sync.

### Which cards sync

Only cards with a **deck**. Writing `[Deck:: Finance::Risk]` on a card, or filling the Deck field in the editor, is what opts it in. Use Anki's `::` for subdecks. Missing decks are created.

Each card shows its state in the bank:

| Pill | Meaning |
|------|---------|
| `Anki: new` | Has a deck, not in Anki yet |
| `Anki ✓` | In Anki and up to date |
| `Anki: changed` | Question, answer or deck changed since the last sync |
| `Anki: will be deleted` | Was synced, but its deck was cleared; the next sync deletes it from Anki |

### Syncing

Click **Anki** in the toolbar, or run **Flashcard Bank: Sync with Anki**. The plugin reads Anki and shows a summary before changing anything:

- **Will be created**: new cards. Cards with a deck but no block id get one written into their note first, since the pairing needs it.
- **Will be updated**: content changed, deck changed (the note is moved to the new deck), or the card moved to another note. A card that keeps its block id and content when moved stays paired with the same Anki note and keeps its history.
- **Will be re-created**: synced cards whose Anki note was deleted by hand.
- **Will be deleted from Anki**: cards whose deck was cleared, or that were deleted from Obsidian. This also deletes their review history in Anki, so the button then reads **Sync and delete N**. Nothing outside this list is ever deleted.

Cancel and nothing happens. If everything is already in sync, you just get a notice.

### What goes into Anki

- **Front:** the question. **Back:** the answer.
- **Text:** plain text, HTML-escaped. Wikilinks become their alias, or the note name if they have no alias.
- **Tags:** each note gets the plugin's tag (default `flashcard-bank`), and no other tags.

### Ringfencing

The plugin only updates or deletes an Anki note when **both** of these are true:

- It's in the plugin's own register of notes it created. That register is stored in the plugin's `data.json` as `ankiMap`: card `note.md#^id` → Anki note id.
- It still carries the plugin's tag in Anki.

Everything else is never edited or deleted. That includes notes you made by hand, and notes from which you removed the tag; the latter are listed as *left untouched*. Notes that carry the tag but aren't in the register (for example after reinstalling the plugin) are only reported.

## Settings

| Setting | Default | Meaning |
|---------|---------|---------|
| Card tag | `#flashcard` | The tag that marks a list item as a card |
| Excluded folders | *(none)* | One folder per line; cards inside are ignored (e.g. your templates folder) |
| New card prefix | `- ` | Text before the question on new cards (e.g. `- [?] ` for a custom checkbox) |
| **Field names** | | |
| Source | `Source` | Field for where the card comes from |
| Related | `Related` | Field for direct links to other cards |
| Deck | `Deck` | Field for the Anki deck (cards without it don't sync) |
| **Anki** | | |
| Connection address | `http://127.0.0.1:8765` | Where AnkiConnect listens |
| Note type, fields | `Basic`, `Front`, `Back` | Note type and the fields for question and answer. **Connect** lists the real ones |
| Anki tag | `flashcard-bank` | The ringfence tag. Changing it leaves notes with the old tag protected (untouched) |

Field names let the plugin work with cards you've already written in any language, such as `[Fuente:: …] [Conexiones:: …]`. Changing a field name doesn't rename anything in your notes. It only tells the plugin which field to read and write.

## Troubleshooting

If something goes wrong while the bank is open, the error is shown inside the tab and appended to `error.log` in the plugin folder, with the time and the full stack trace.

## How it works

| File | Role |
|------|------|
| `src/card.ts` | Pure card logic, with no Obsidian imports: finding cards in a note, splitting a line into question/answer/fields/tags/id, links in the text, rewriting only changed parts, ids, conflict-checked replacement, appending. |
| `src/store.ts` | The index of all cards (rebuilt on load, then per note when Obsidian reports a change). Also: concepts (a cached index of concept → cards, rebuilt after any change and when notes are created, renamed or deleted), related cards in both directions (with a cached reverse index), and save/create, which use `vault.process` so each write is atomic. |
| `src/view.ts` | The bank tab: concepts list, card list, editor. |
| `src/map.ts` | The concept map (SVG). |
| `src/sync.ts` | Anki sync logic, with no Obsidian imports: `planSync` works out what a sync would do from the cards, the register and Anki's state; `runSync` applies it, updating the register step by step. |
| `src/anki.ts` | AnkiConnect client, using Obsidian's `requestUrl` (no CORS setup needed). |
| `src/ankiui.ts` | The sync flow: checks, summary modal, id assignment, apply, result notice. |
| `src/suggest.ts` | The suggestion dropdown used by the editor inputs. |
| `src/main.ts` | Plugin entry: view, ribbon icon, commands, settings tab, change listeners. |

The index only reads notes whose metadata cache contains the card tag, so large vaults stay fast.

## Development

Requires Node.js 20 or later.

```bash
npm install
npm run dev         # rebuild main.js on every change
npm run build       # typecheck, then a production build of main.js
npm run lint        # ESLint with Obsidian's plugin rules
npm test            # unit tests (tests/card.test.ts and tests/sync.test.ts, against an in-memory fake AnkiConnect)
npm test -- path/to/note.md   # also checks that every card in that note round-trips unchanged
```

Run `npm test` with a few of your own notes after changing the parser: every card in them must come back identical when rewritten without changes.

To release, run `npm version patch` (or `minor` / `major`), then `git push --follow-tags`. The release workflow builds the plugin and creates a draft GitHub release with `main.js`, `manifest.json` and `styles.css` attached; publish it from the repository's Releases page.

## License

[MIT](LICENSE) © 2026 Juan Carlos Esguerra
