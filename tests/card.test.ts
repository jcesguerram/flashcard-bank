// Tests for src/card.ts. Run with: npm test [path/to/a/note.md ...]
// Any notes passed on the command line get a round-trip check: every card
// parsed from them must come back identical when rewritten without changes.

import {
  parseCards, rewriteCard, replaceCard, appendCard, newCardLine, idsInText, newId,
  parseLinks, fieldValue, plainValue, hasTag, textLinks,
} from "../src/card";

declare const require: any;
declare const process: any;
const fs = require("fs");

let pass = 0;
let fail = 0;
function ok(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL: " + msg);
  }
}
function eq(a: any, b: any, msg: string) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  ok(sa === sb, msg + "\n   got:  " + sa + "\n   want: " + sb);
}

const ORDER = ["Fuente", "Conexiones", "Tema", "Deck"];
const same = (c: any) => ({ q: c.q, a: c.a, fields: {}, order: ORDER });

// ── Parsing ────────────────────────────────────────────────────────────────
const sample = [
  "---",
  "tags: [x]",
  "---",
  "Intro text #flashcard not a list item",
  "",
  "- [?] ¿Qué es X? – Es Y [Fuente:: [[Libro.pdf]]] [Conexiones:: [[Nota#^abc123|¿Padre?]], [[Nota#^def456|¿Otro?]]] [Tema:: Riesgos/Crédito] #flashcard ^aaa111",
  "",
  "- [?] Sin respuesta [Fuente:: ] [Conexiones:: ] [Tema:: ] #flashcard",
  "",
  "```js",
  "- [?] dentro de código #flashcard ^zzz999",
  "```",
  "- [?] Id abajo – resp [Fuente:: ] [Conexiones:: ] [Tema:: ] #flashcard",
  " ^loolup",
  "- [?] otra – cosa [Tema:: A] #flashcards",
  "- normal list item",
  "- [?] Con guion - respuesta #flashcard #otra ^bbb222",
].join("\n");

const cards = parseCards(sample, "Nota.md");
eq(cards.length, 4, "finds 4 cards (skips frontmatter text, code, #flashcards, plain items)");
const c0 = cards[0];
eq([c0.q, c0.a, c0.id, c0.line], ["¿Qué es X?", "Es Y", "aaa111", 5], "card 0 basic parts");
eq(fieldValue(c0, "fuente"), "[[Libro.pdf]]", "field lookup is case-insensitive");
eq(fieldValue(c0, "Tema"), "Riesgos/Crédito", "tema value");
const links = parseLinks(fieldValue(c0, "Conexiones"));
eq(links.map((l) => [l.linkpath, l.blockId, l.alias]), [["Nota", "abc123", "¿Padre?"], ["Nota", "def456", "¿Otro?"]], "conexiones links");
eq(plainValue("[[Libro.pdf]], Capítulo 1"), "Libro.pdf, Capítulo 1", "plain value");
eq([cards[1].q, cards[1].a, cards[1].id], ["Sin respuesta", "", null], "card without answer or id");
eq([cards[2].id, cards[2].line, cards[2].endLine], ["loolup", 12, 13], "id on continuation line belongs to the card");
eq([cards[3].q, cards[3].a, cards[3].sep, cards[3].tags], ["Con guion", "respuesta", "-", ["#flashcard", "#otra"]], "hyphen separator and extra tags");
ok(!hasTag("[Conexiones:: [[A#flashcard]]]", "#flashcard"), "tag inside a field doesn't count");

// ── Round trip ─────────────────────────────────────────────────────────────
for (const c of cards) eq(rewriteCard(c, same(c)), c.raw, "unchanged rewrite is identical: line " + c.line);

// ── Edits ──────────────────────────────────────────────────────────────────
{
  const out = rewriteCard(c0, { q: c0.q, a: c0.a, fields: { Tema: "Riesgos/Contraparte" }, order: ORDER });
  eq(out, c0.raw.replace("[Tema:: Riesgos/Crédito]", "[Tema:: Riesgos/Contraparte]"), "change one field in place");
}
{
  const out = rewriteCard(c0, { q: c0.q, a: c0.a, fields: { Deck: "Riesgos" }, order: ORDER });
  eq(out, c0.raw.replace("[Tema:: Riesgos/Crédito]", "[Tema:: Riesgos/Crédito] [Deck:: Riesgos]"), "missing field appended after last field");
}
{
  const out = rewriteCard(c0, { q: "¿Qué es X de verdad?", a: "Es Z", fields: {}, order: ORDER });
  eq(out, c0.raw.replace("¿Qué es X? – Es Y", "¿Qué es X de verdad? – Es Z"), "question and answer rewritten, rest kept");
}
{
  const c = cards[1];
  const out = rewriteCard(c, { q: c.q, a: "Ahora sí", fields: {}, order: ORDER, newId: "new001" });
  eq(out, "- [?] Sin respuesta – Ahora sí [Fuente:: ] [Conexiones:: ] [Tema:: ] #flashcard ^new001", "answer added and id assigned");
}
{
  const c = cards[2];
  const out = rewriteCard(c, { q: c.q, a: "nueva", fields: { Tema: "T" }, order: ORDER });
  eq(out, "- [?] Id abajo – nueva [Fuente:: ] [Conexiones:: ] [Tema:: T] #flashcard\n ^loolup", "multi-line card keeps its id line");
  ok(rewriteCard(c, { q: c.q, a: c.a, fields: {}, order: ORDER, newId: "x" }) === c.raw, "card with id never gets a second one");
}
{
  const bare = parseCards("- [?] Pregunta – Resp #flashcard", "N.md")[0];
  const out = rewriteCard(bare, { q: bare.q, a: bare.a, fields: { Tema: "A/B" }, order: ORDER, newId: "q1w2e3" });
  eq(out, "- [?] Pregunta – Resp [Tema:: A/B] #flashcard ^q1w2e3", "card with no fields gets them before the tag");
}
{
  const out = rewriteCard(c0, { q: c0.q, a: "línea\ncon salto", fields: { Fuente: "a\nb" }, order: ORDER });
  ok(!out.includes("\n"), "newlines in edits are flattened to one line");
}

// ── Replace in file, conflicts ─────────────────────────────────────────────
{
  const repl = rewriteCard(c0, { q: c0.q, a: c0.a, fields: { Tema: "X" }, order: ORDER });
  const r = replaceCard(sample, c0, c0.raw, repl, "#flashcard");
  ok(r.ok && r.text.split("\n")[5] === repl, "replaceCard writes the new line");
  ok(r.ok && r.text.split("\n").length === sample.split("\n").length, "line count unchanged");
  const moved = "nueva línea arriba\n" + sample;
  const r2 = replaceCard(moved, c0, c0.raw, repl, "#flashcard");
  ok(r2.ok && r2.text.split("\n")[6] === repl, "card found by id after lines shift");
  const edited = sample.replace("Es Y", "Es Y editado a mano");
  const r3 = replaceCard(edited, c0, c0.raw, repl, "#flashcard");
  ok(!r3.ok && r3.reason === "changed", "conflict detected when the line changed in the note");
  const r4 = replaceCard(sample.replace("^aaa111", ""), c0, c0.raw, repl, "#flashcard");
  ok(!r4.ok && r4.reason === "missing", "missing card detected");
  const crlf = sample.replace(/\n/g, "\r\n");
  const c0b = parseCards(crlf, "Nota.md")[0];
  const r5 = replaceCard(crlf, c0b, c0b.raw, repl, "#flashcard");
  ok(r5.ok && r5.text.includes("\r\n") && !/[^\r]\n/.test(r5.text), "CRLF line endings preserved");
}

// ── New cards, ids ─────────────────────────────────────────────────────────
{
  const line = newCardLine("- [?] ", "¿Q?", "A", { Fuente: "", Conexiones: "", Tema: "T", Deck: "" }, ORDER, "#flashcard", "abc999");
  eq(line, "- [?] ¿Q? – A [Fuente:: ] [Conexiones:: ] [Tema:: T] [Deck:: ] #flashcard ^abc999", "new card line");
  const p = parseCards(line, "N.md")[0];
  eq([p.q, p.a, p.id, fieldValue(p, "Tema")], ["¿Q?", "A", "abc999", "T"], "new card parses back");
  eq(appendCard("a\n", "L"), "a\n\nL\n", "append after text ending in newline");
  eq(appendCard("a", "L"), "a\n\nL\n", "append after text without final newline");
  eq(appendCard("a\n\n", "L"), "a\n\nL\n", "append after blank line");
  eq(appendCard("", "L"), "L\n", "append to empty note");
  const used = idsInText(sample);
  ok(used.has("aaa111") && used.has("loolup") && used.has("bbb222"), "ids collected, including one on its own line");
  let seq = 0;
  const fake = () => [0, 0, 0, 0, 0, 0, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5][seq++ % 12];
  const taken = new Set(["000000"]);
  eq(newId(taken, fake), "iiiiii", "newId skips an id already used");
  for (let i = 0; i < 200; i++) ok(/^[a-z0-9]{6}$/.test(newId(new Set())), "id format");
}

// ── Indentation carries no meaning ─────────────────────────────────────────
{
  const nested = [
    "- [?] Padre – a #flashcard ^p00001",
    "    - [?] Hija 1 – b #flashcard ^h00001",
    "        - [?] Nieta – c #flashcard ^n00001",
    "    - nota normal, no tarjeta",
    "        - [?] Bajo nota normal – d #flashcard ^x00001",
    "\t- [?] Con tab – e #flashcard ^t00001",
    "",
    "Párrafo.",
    "    - [?] Indentada tras párrafo – g #flashcard ^z00001",
  ].join("\n");
  const cs = parseCards(nested, "N.md");
  eq(cs.map((c) => c.id).join(","), "p00001,h00001,n00001,x00001,t00001,z00001", "indented cards are found like any other");
  eq(cs[2].q, "Nieta", "deeply indented card reads normally");
  eq(cs[2].prefix, "        - [?] ", "prefix keeps its indentation");
  ok(!("parentLine" in cs[1]), "no parent is recorded");
  for (const c of cs) eq(rewriteCard(c, same(c)), c.raw, "indented round trip line " + c.line);
  const r = replaceCard(nested, cs[2], cs[2].raw, rewriteCard(cs[2], { ...same(cs[2]), a: "otra" }), "#flashcard");
  ok(r.ok && r.text.split("\n")[2] === "        - [?] Nieta – otra #flashcard ^n00001", "editing an indented card keeps its indentation");
}

// ── Links in the text: concepts and card links ────────────────────────────
{
  const c = parseCards("- [?] ¿Qué mide el [[Capital de Nivel 2]]? – Lo que [[Riesgos#^abc123|absorbe pérdidas]] en [[Basilea#Pilar 1|liquidación]] ![[img.png]] [[ ]] [Fuente:: [[Libro]]] [Conexiones:: [[R#^zzz]]] #flashcard ^q00001", "C.md")[0];
  const t = textLinks(c);
  eq(t.concepts.map((l) => l.linkpath).join("|"), "Capital de Nivel 2|Basilea", "concepts: note links in question and answer only (heading links point to the note)");
  eq(t.cards.map((l) => l.linkpath + "#" + l.blockId).join("|"), "Riesgos#abc123", "card links in the text");
  eq(t.concepts[1].alias, "liquidación", "alias kept");
  eq(parseLinks("![[a.png]] [[b]]").map((l) => l.linkpath).join(","), "b", "embeds are not links");
  eq(textLinks({ q: "sin enlaces", a: "" }).concepts.length, 0, "no links, no concepts");
}

// ── Real notes from the command line ───────────────────────────────────────
for (const file of process.argv.slice(2)) {
  const text = fs.readFileSync(file, "utf8");
  const found = parseCards(text, file);
  console.log(`${file}: ${found.length} cards`);
  for (const c of found) {
    eq(rewriteCard(c, same(c)), c.raw, `round trip ${file}:${c.line + 1}`);
    const r = replaceCard(text, c, c.raw, c.raw, "#flashcard");
    ok(r.ok && r.text === text, `no-op replace leaves the note identical ${file}:${c.line + 1}`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
