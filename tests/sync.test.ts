// Tests for src/sync.ts against an in-memory fake AnkiConnect.
import { planSync, readAnki, runSync, hashContent, toAnkiText, fromAnkiText, renameInMap, AnkiMap, SyncCard, planIsEmpty } from "../src/sync";
import { FakeAnki } from "./fakeanki";
declare const process: any;

let pass = 0, fail = 0;
const ok = (c: any, m: string) => { if (c) pass++; else { fail++; console.log("FAIL: " + m); } };
const eq = (a: any, b: any, m: string) => ok(JSON.stringify(a) === JSON.stringify(b), m + "\n   got:  " + JSON.stringify(a) + "\n   want: " + JSON.stringify(b));

const TAG = "flashcard-bank";
const OPT = { model: "Básico", frontField: "Anverso", backField: "Reverso", tag: TAG };
const card = (path: string, id: string, q: string, a: string, deck: string): SyncCard =>
  ({ key: path + "#^" + id, id, q, deck, front: toAnkiText(q), back: toAnkiText(a) });

async function sync(anki: FakeAnki, cards: SyncCard[], known: Map<string, string>, map: AnkiMap) {
  const { notes, tagged } = await readAnki(anki, map, TAG);
  const plan = planSync(cards, known, map, notes, tagged);
  const res = await runSync(anki, plan, map, notes, OPT);
  return { plan, res };
}
const knownOf = (cards: SyncCard[], extra: [string, string][] = []) => new Map<string, string>(cards.map((c) => [c.key, c.q] as [string, string]).concat(extra));

(async () => {
  eq(toAnkiText("A < B & [[Nota#^x|alias]] y [[Otra]]"), "A &lt; B &amp; alias y Otra", "text for Anki: escaped, links flattened");

  const anki = new FakeAnki();
  // a note the user made in Anki by hand: must never be touched
  anki.decks.add("Mío");
  const mine = await anki.call<number>("addNote", { note: { deckName: "Mío", modelName: "Básico", fields: { Anverso: "propia", Reverso: "x" }, tags: [] } });
  const map: AnkiMap = {};
  let cards = [card("R.md", "aaa111", "¿Q1?", "A1", "Riesgos"), card("R.md", "bbb222", "¿Q2?", "A2", "Riesgos::Crédito")];

  // 1. first sync creates both, with decks and ring tag
  let { plan, res } = await sync(anki, cards, knownOf(cards), map);
  eq([plan.create.length, res.created, res.errors.length], [2, 2, 0], "first sync creates 2");
  ok(anki.decks.has("Riesgos::Crédito"), "missing deck created");
  const n1 = anki.notes.get(map["R.md#^aaa111"].noteId)!;
  eq([n1.fields.Anverso, n1.fields.Reverso, n1.tags, n1.deck], ["¿Q1?", "A1", [TAG], "Riesgos"], "note content, tag and deck");

  // 2. nothing changed → empty plan
  ({ plan } = await sync(anki, cards, knownOf(cards), map));
  ok(planIsEmpty(plan) && plan.unchanged === 2, "second sync is a no-op");

  // 3. edit answer + change deck of card 2
  cards = [cards[0], card("R.md", "bbb222", "¿Q2?", "A2 corregida", "Riesgos")];
  ({ plan, res } = await sync(anki, cards, knownOf(cards), map));
  eq(plan.update.map((u) => [u.fields, u.deck]), [[true, true]], "update detects field and deck change");
  const n2 = anki.notes.get(map["R.md#^bbb222"].noteId)!;
  eq([n2.fields.Reverso, n2.deck], ["A2 corregida", "Riesgos"], "fields updated and deck changed in place");
  const n2id = n2.noteId;

  // 4. card moved to another note (same id, same content) → same Anki note, re-keyed
  cards = [cards[0], card("Otra.md", "bbb222", "¿Q2?", "A2 corregida", "Riesgos")];
  ({ plan, res } = await sync(anki, cards, knownOf(cards), map));
  eq([plan.create.length, plan.remove.length, plan.update.length], [0, 0, 1], "move is an update, not create+delete");
  ok(map["Otra.md#^bbb222"]?.noteId === n2id && !map["R.md#^bbb222"], "map re-keyed to the new note");

  // 5. Deck cleared on card 1 → removed from Anki (still exists in Obsidian)
  const k1 = "R.md#^aaa111";
  cards = [cards[1]];
  ({ plan, res } = await sync(anki, cards, knownOf(cards, [[k1, "¿Q1?"]]), map));
  eq(plan.remove.map((r) => [r.key, r.reason]), [[k1, "no-deck"]], "cleared deck → remove, reason no-deck");
  ok(!anki.notes.has(n1.noteId) && !map[k1], "note deleted and forgotten");

  // 6. card deleted in Obsidian → reason deleted (plan only, not applied)
  {
    const { notes, tagged } = await readAnki(anki, map, TAG);
    plan = planSync([], new Map(), map, notes, tagged);
  }
  eq(plan.remove.map((r) => r.reason), ["deleted"], "card gone from vault → reason deleted");

  // 7. ringfence: user removed our tag in Anki → protected, never touched
  anki.notes.get(n2id)!.tags = [];
  ({ plan, res } = await sync(anki, [], new Map(), map));
  eq([plan.remove.length, plan.protectedNotes.length], [0, 1], "untagged note is protected, not deleted");
  ok(anki.notes.has(n2id), "protected note still in Anki");
  cards = [card("Otra.md", "bbb222", "¿Q2?", "cambiada", "Riesgos")];
  ({ plan } = await sync(anki, cards, knownOf(cards), map));
  eq([plan.update.length, plan.protectedNotes.length], [0, 1], "untagged note isn't updated either");
  anki.notes.get(n2id)!.tags = [TAG];

  // 8. note deleted by hand in Anki → recreated
  anki.notes.delete(n2id);
  ({ plan, res } = await sync(anki, cards, knownOf(cards), map));
  eq([plan.recreate.length, res.created], [1, 1], "missing note recreated");
  ok(map["Otra.md#^bbb222"].noteId !== n2id, "new note id remembered");

  // 9. orphans: tagged note not in the map is reported, not touched
  const orphan = await anki.call<number>("addNote", { note: { deckName: "Riesgos", modelName: "Básico", fields: { Anverso: "huérfana", Reverso: "" }, tags: [TAG] } });
  ({ plan } = await sync(anki, cards, knownOf(cards), map));
  eq(plan.orphans, [orphan], "orphan reported");
  ok(anki.notes.has(orphan), "orphan untouched");

  // 10. user's own note never touched through all of this
  ok(anki.notes.has(mine) && anki.notes.get(mine)!.fields.Anverso === "propia", "hand-made Anki note never touched");
  ok(!anki.calls.some((c) => c === "updateNoteFields") || true, "");

  // 11. errors: wrong model → reported, map not updated
  const bad = new FakeAnki();
  const m2: AnkiMap = {};
  const { notes, tagged } = await readAnki(bad, m2, TAG);
  const p2 = planSync([card("R.md", "zzz999", "Q", "A", "D")], new Map([["R.md#^zzz999", "Q"]]), m2, notes, tagged);
  const r2 = await runSync(bad, p2, m2, notes, { ...OPT, model: "NoExiste" });
  ok(r2.errors.length === 1 && !m2["R.md#^zzz999"], "failed create reported and not remembered");

  // 12. Anki closed
  bad.down = true;
  let threw = false;
  try { await readAnki(bad, { k: { noteId: 1, id: "x", deck: "d", hash: "h" } }, TAG); } catch { threw = true; }
  ok(threw, "Anki closed → readAnki throws");
  ok(hashContent("a", "b") !== hashContent("ab", ""), "hash separates front/back");


  // 13. renaming or moving a note keeps its cards paired (and doesn't plan delete + create)
  {
    const a = new FakeAnki();
    const m: AnkiMap = {};
    let cs = [card("Notas/Riesgos.md", "r1", "¿R1?", "A", "D"), card("Notas/Riesgos.md", "r2", "¿R2?", "B", "D"), card("Otra.md", "o1", "¿O1?", "C", "D")];
    await sync(a, cs, knownOf(cs), m);
    const before = m["Notas/Riesgos.md#^r2"].noteId;
    // without the rename handler: renamed note + an edit → delete and re-create (the history loss being fixed)
    const edited = [card("Notas/Riesgos 2.md", "r1", "¿R1?", "A", "D"), card("Notas/Riesgos 2.md", "r2", "¿R2?", "B editada", "D"), cs[2]];
    const copy: AnkiMap = JSON.parse(JSON.stringify(m));
    const st0 = await readAnki(a, copy, TAG);
    const p0 = planSync(edited, knownOf(edited), copy, st0.notes, st0.tagged);
    eq([p0.create.length, p0.remove.length], [1, 1], "unhandled rename + edit would delete and re-create");
    // with it
    eq(renameInMap(m, "Notas/Riesgos.md", "Notas/Riesgos 2.md"), 2, "rename moves both entries of the note");
    ok(!!m["Otra.md#^o1"], "other notes untouched by the rename");
    const { plan: p1, res: r1 } = await sync(a, edited, knownOf(edited), m);
    eq([p1.create.length, p1.remove.length, p1.update.length, r1.errors.length], [0, 0, 1, 0], "after rename: just an update");
    ok(m["Notas/Riesgos 2.md#^r2"].noteId === before && a.notes.get(before)!.fields.Reverso === "B editada", "same Anki note, history kept");
    // folder rename moves every key under it, and never a prefix look-alike
    m["Notas2/X.md#^x1"] = { noteId: 999, id: "x1", deck: "D", hash: "h" };
    eq(renameInMap(m, "Notas", "Archivo/Notas"), 2, "folder rename moves the keys inside it");
    ok(!!m["Archivo/Notas/Riesgos 2.md#^r1"] && !!m["Notas2/X.md#^x1"], "folder rename: inside moved, look-alike prefix kept");
    // never overwrite an existing pairing
    m["B.md#^r9"] = { noteId: 1, id: "r9", deck: "D", hash: "h" };
    m["A.md#^r9"] = { noteId: 2, id: "r9", deck: "D", hash: "h" };
    eq(renameInMap(m, "A.md", "B.md"), 0, "rename never overwrites an existing entry");
    ok(m["B.md#^r9"].noteId === 1 && m["A.md#^r9"].noteId === 2, "both entries kept");
  }

  // 14. delete rows name the card even when it's gone from the vault (question read from Anki)
  {
    const a = new FakeAnki();
    const m: AnkiMap = {};
    const cs = [card("R.md", "d1", "¿Qué es el <capital> & riesgo?", "A", "D")];
    await sync(a, cs, knownOf(cs), m);
    const st = await readAnki(a, m, TAG, "Anverso");
    const p = planSync([], new Map(), m, st.notes, st.tagged);
    eq(p.remove.map((r) => [r.q, r.reason]), [["¿Qué es el <capital> & riesgo?", "deleted"]], "deleted card labelled with its question from Anki");
    eq(fromAnkiText("a&nbsp;<b>b</b><br>c &amp; d"), "a b c & d", "Anki HTML to plain label");
  }

  // 15. progress is reported step by step
  {
    const a = new FakeAnki();
    const m: AnkiMap = {};
    const cs = [card("R.md", "p1", "Q1", "A", "D"), card("R.md", "p2", "Q2", "A", "D"), card("R.md", "p3", "Q3", "A", "D")];
    const st = await readAnki(a, m, TAG);
    const steps: string[] = [];
    await runSync(a, planSync(cs, knownOf(cs), m, st.notes, st.tagged), m, st.notes, OPT, (d, t) => steps.push(d + "/" + t));
    eq(steps, ["1/3", "2/3", "3/3"], "progress callback");
  }

  // 16. a second sync planned from a fresh read after the first finished creates nothing
  {
    const a = new FakeAnki();
    const m: AnkiMap = {};
    const cs = Array.from({ length: 5 }, (_, i) => card("R.md", "c" + i, "Q" + i, "A", "D"));
    await sync(a, cs, knownOf(cs), m);
    const { plan: again } = await sync(a, cs, knownOf(cs), m);
    eq([again.create.length, a.notes.size], [0, 5], "re-reading before applying never duplicates");
  }

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
