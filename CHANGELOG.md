# Changelog

All notable changes to Flashcard Bank are recorded here. Versions follow [Semantic Versioning](https://semver.org/).

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
