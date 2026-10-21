# Changelog

All notable changes to Flashcard Bank are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

## 1.4.0 — 2026-10-21

### New

- **Notes that mention a concept.** A concept page now lists, under its sources, the other notes that link to the concept outside their cards, and the line under the title counts them. Click one to open it. Links are matched like concepts (display names and headings lead to the same note), and the concept's own note and excluded folders are left out.
- **Unanswered cards stand out.** A card without an answer shows *No answer yet* in the list, and on concept pages with an **Answer it** link that opens it in the editor, ready to type the answer.
- **Unanswered filter.** In the left panel, right under *All cards*, with how many cards are left to answer. It combines with the deck, concept and other filters.
- **Anki warning for cards without an answer.** They're still synced (with an empty back), but the sync summary lists them under **No answer yet**, so you can answer them before syncing if you prefer.

### Fixed

- **A card's source and note are told apart.** On concept pages and in the Expanded list, a card's details showed as plain names in a row, so a card citing `[[Kaput]]` and written in the note *Kaput* read "Kaput · Kaput". Each detail now has its icon (source, deck, note). A source that's a `[[link]]` opens its note when clicked, and the note's name opens the note at the card.
- **Filtering with the map expanded shows the result.** The expanded concept map hides the list, so choosing a deck or concept, searching, or clicking a source or **Show in bank** on a concept page seemed to do nothing. These now bring the list back.

### Changed

- In the concept map, clicking the open card (on the left) takes you back to it in the list.

## 1.3.1 — 2026-10-20

### Fixed

- **A dash inside a link no longer splits the card.** A card like `What is [[Basel III|Basel III – overview]]? – A capital standard` was split at the dash inside the link, cutting the link in two: the question became `What is [[Basel III|Basel III` and the rest went to the answer (and to the back of the Anki card). Dashes inside `[[links]]` and embeds are now ignored when looking for the question/answer split. Cards that already split correctly are read exactly as before.

## 1.3.0 — 2026-10-20

### New

- **Decks in the left panel.** Above the concepts, a **Decks** section lists every Anki deck your cards use, with sub-decks indented under their parent. Click a deck to show its cards (sub-decks included); *No deck* shows the cards that aren't synced with Anki.
- **Deck and concept filters combine.** For example, the *Regulatory capital* cards in *Finance::Banking*. A concept's name still opens its page; the filter icon next to it filters the list instead.
- **Filter chips.** The active filters (deck, concept, source, note) show above the list, each with its own × to remove it.
- **Counts that follow the filters.** The numbers next to each deck and concept count the cards the other filters (and the search) leave; the ones with none are dimmed.

### Changed

- The **Decks** and **Concepts** sections have icons and can be folded; the plugin remembers which are open.
- The three panels (decks and concepts, list, editor) are separated by a small gap, with rounded corners. In a narrow pane they join again.

## 1.2.1 — 2026-10-19

### Fixed

- **The Deck and Source fields no longer fill themselves in.** Their suggestions start with nothing highlighted: Tab keeps what you typed (or leaves the field empty) and moves on, and Enter only accepts a suggestion you picked with ↓/↑. Before, tabbing past an empty Deck wrote the first deck in the list into the card, which opted it into Anki; typing a new deck name or a plain-text source could be replaced by a suggestion the same way. The note and related-card pickers work as before.
- **Only one Anki sync at a time.** While a sync runs (from reading Anki until the result), the sync button shows it's busy and ignores clicks, and the command says a sync is already running. Before, a second click could start a second sync and create every new card twice in Anki.
- **Renaming or moving a note (or a folder) keeps its cards paired with their Anki notes.** Before, editing a card in a renamed note before the next sync made the sync delete its Anki note, review history included, and create a new one; the cards also showed *Anki: new* until then.
- After you confirm the summary, the plugin reads Anki and your notes again before changing anything, so a summary left open for a while can't act on stale information. (Deletions are still limited to the ones you confirmed.)

### Changed

- The sync shows its progress in a notice (*reading your collection*, then *syncing… 12 of 37*).
- The summary lists **every** card that will be created and every one that will be deleted, in a scrolling box, each with its note. Cards no longer in Obsidian are listed by their question as it is in Anki, instead of *(card deleted in Obsidian)*.
- When some cards fail to sync, a window lists each one with the reason, with a **Copy** button, and the details are added to `error.log`. Before, they only went to the developer console.

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
