# Changelog

All notable changes to Flashcard Bank are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.2.0 — 2026-10-15

### New

- **Choose the section for a new card.** Below the note, a **Section** list shows the note's headings. The card goes at the end of that heading's own content, before the next heading; **End of note** is still there. The section you last used for each note is selected next time.

### Changed

- A new card added right after a list (other cards, for example) now joins that list instead of being set off by a blank line. After anything else it still gets a blank line before it.
- If the chosen section is no longer in the note when you save, nothing is written and you're asked to pick another place.

## 1.1.0 — 2026-10-15

### New

- **Concept pages.** Clicking a concept opens a page that brings together everything your cards say about it. **Overview** lists its cards (click one to see the answer), the concepts that share cards with it, with how many, and the sources the cards cite. **Connections** shows, for each neighboring concept, the cards that link the two. From a page you can filter the bank by the concept, open its note, or edit any of its cards.
- **Compact and expanded list.** Compact shows one line of question and answer plus the Anki status; expanded shows everything, with source, deck and note. The choice is remembered.
- **Narrow screens and phones** show one panel at a time: opening a card replaces the list with the editor, and **Cards** brings you back with the same search, filters and scroll position.

### Changed

- **A cleaner look** that uses your theme's accent color only for what's selected or active. The concepts column has a tinted background, the list shows cards as plain text with a single status line instead of rows of tags, and the source and note filters moved behind a **Filter** button.
- **The editor is reorganized**: question and answer first, then **Source and deck**, **Connections** (concepts and related cards) and **Advanced details** (the exact line that will be written, the block id and the Anki status). Each section can be folded, and the plugin remembers which are open.
- Clicking a concept (in the concepts column, the editor or the concept map) opens its page instead of filtering the list. **Show in bank** on the page, or the concept's name above the list, filters as before.
- The deck field lists the decks already in use as soon as you click it.
- Anki status in the list reads *Synced with Anki* instead of *Anki ✓*.

## 1.0.1 — 2026-10-14

- Links to other cards are underlined in a way that works on every supported Obsidian version.
- The bank's tab spacing is set without `!important`, so themes and snippets can override it.
- A donation link (Ko-fi) appears on the plugin's page in Obsidian.

## 1.0.0 — 2026-10-14

First public release.

- **Bank tab** listing every list item tagged `#flashcard` (configurable) across the vault, with search and filters by source and by note.
- **Concepts**: `[[links]]` to notes in a card's question or answer group cards by concept. A concepts list filters the bank, and the editor shows the other cards that share each concept.
- **Concept map** of the open card, its concepts and the cards around them, with an expanded mode that takes the whole middle column.
- **Editor** that writes each change back into the card's own line, touching only what changed, with conflict protection when the line was edited in the meantime.
- **Related cards** through block links in a configurable field, or in the question or answer.
- **Automatic block ids** for cards that need one.
- **Configurable field names**, so existing cards written in any language work as they are.
- **One-way Anki sync** through AnkiConnect, opt-in per card with a deck field, with a summary before any change and ringfencing: only notes the plugin created and that still carry its tag are ever updated or deleted.
