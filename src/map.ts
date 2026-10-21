// Concept map: the open card on the left, the concepts it links to in the
// middle, and the other cards that mention each concept on the right. A card
// sharing several concepts is drawn once, with a line from each. Related cards
// (the Related field, or a card link in the text, in either direction) get a
// dashed line straight from the open card.

import type { Card } from "./card";
import { CardStore, Concept, cardKey } from "./store";

const NS = "http://www.w3.org/2000/svg";
const FW = 190; // open card width
const CW = 200; // concept width
const CH = 30; // concept height
const RW = 220; // card width (right column)
const GAP = 56; // horizontal gap between columns
const VG = 8; // vertical gap between boxes
const LINE = 14; // text line height
const MAX_PER_CONCEPT = 8;

function svg<K extends keyof SVGElementTagNameMap>(parent: Element, tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  parent.appendChild(el);
  return el;
}

/** Word-wrap to at most `max` lines of about `n` characters. */
function wrap(s: string, n: number, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(" ")) {
    if (cur && (cur + " " + w).length > n) {
      out.push(cur);
      cur = w;
    } else cur = cur ? cur + " " + w : w;
  }
  if (cur) out.push(cur);
  if (out.length > max) {
    out.length = max;
    const last = out[max - 1] ?? "";
    out[max - 1] = (last.length > n - 1 ? last.slice(0, n - 1) : last) + "…";
  }
  return out;
}

/** Card text without link brackets, as it reads. */
function plain(s: string): string {
  return s.replace(/!?\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g, (_m, t: string, al?: string) => al || (t.split("#")[0] ?? ""));
}

interface Box { x: number; y: number; w: number; h: number }

export function drawConceptMap(
  el: HTMLElement,
  store: CardStore,
  focus: Card | null | undefined,
  onCard: (c: Card) => void,
  onConcept: (k: Concept) => void,
  onFocus: () => void,
  addTools?: (tools: HTMLElement) => void
): void {
  const head = el.createDiv({ cls: "bt-map-head" });
  head.createSpan({ text: focus ? "Concept map" : "Concept map · select a card" });
  const tools = head.createSpan({ cls: "bt-map-tools" });
  if (focus) {
    const legend = tools.createSpan({ cls: "bt-map-legend" });
    legend.createSpan({ cls: "bt-map-solid", text: "shares a concept" });
    legend.createSpan({ cls: "bt-map-dashed", text: "related" });
    legend.createSpan({ text: "↔ also related" });
  }
  addTools?.(tools);
  if (!focus) return;

  const fk = cardKey(focus);
  const concepts = store.conceptsOf(focus);
  const groups = store.relatedByConcept(concepts, fk);
  const related = store.relatedOf(focus).filter((r) => r.card).map((r) => r.card!);

  if (!concepts.length && !related.length) {
    el.createDiv({ cls: "bt-map-empty", text: "This card doesn't link to any concept or related card yet. Write [[links]] in its question or answer to connect it." });
    return;
  }

  // Right column: one box per card, in the order of the first concept it appears under.
  const cardBox = new Map<string, Box & { card: Card; dashed: boolean }>();
  const conceptBox = new Map<string, Box & { concept: Concept; more: number; moreY: number; empty: boolean }>();
  const edges: { from: string; to: string }[] = []; // concept key → card key
  const rx = FW + GAP + CW + GAP;
  let y = 0;
  const addCard = (c: Card, dashed: boolean): Box => {
    const k = cardKey(c);
    const have = cardBox.get(k);
    if (have) return have;
    const lines = wrap(plain(c.q) || "(no question)", 34, 2);
    const b = { x: rx, y, w: RW, h: lines.length * LINE + 14, card: c, dashed };
    cardBox.set(k, b);
    y += b.h + VG;
    return b;
  };

  for (const g of groups) {
    const startY = y;
    const shown = g.cards.slice(0, MAX_PER_CONCEPT);
    const tops: number[] = [];
    for (const c of shown) {
      const b = addCard(c, false);
      tops.push(b.y + b.h / 2);
      edges.push({ from: g.concept.key, to: cardKey(c) });
    }
    const more = g.cards.length - shown.length;
    const moreY = y;
    if (more > 0) y += LINE + VG;
    const empty = !shown.length;
    if (empty) y += CH + VG;
    // Center the concept on the cards it connects to (or on its own slot).
    const mid = tops.length ? (Math.min(...tops) + Math.max(...tops)) / 2 : startY + CH / 2;
    conceptBox.set(g.concept.key, { x: FW + GAP, y: mid - CH / 2, w: CW, h: CH, concept: g.concept, more, moreY, empty });
  }

  // Related cards already on the map get a ↔ mark; the others go at the bottom, with a dashed line.
  const alsoRelated = new Set(related.map(cardKey).filter((k) => cardBox.has(k)));
  const onlyRelated = related.filter((c) => !cardBox.has(cardKey(c)));
  if (onlyRelated.length) y += VG;
  for (const c of onlyRelated) addCard(c, true);

  // Concepts must not overlap: push down where needed, keeping order.
  let floor = -Infinity;
  for (const b of conceptBox.values()) {
    if (b.y < floor) b.y = floor;
    floor = b.y + b.h + VG;
  }

  const bottoms = [y - VG, ...Array.from(conceptBox.values()).map((b) => b.y + b.h)];
  const H = Math.max(...bottoms, 0);
  const fLines = wrap(plain(focus.q) || "(no question)", 26, 5);
  const fh = fLines.length * LINE + 16;
  const focusBox: Box = { x: 0, y: Math.max(0, H / 2 - fh / 2), w: FW, h: fh };
  const W = rx + RW;
  const totalH = Math.max(H, focusBox.y + fh) + 4;

  // Scales down to fit the column, never up past its natural size.
  const s = svg(el, "svg", { width: "100%", viewBox: `-2 -2 ${W + 4} ${totalH + 4}`, class: "bt-map-svg" });
  s.style.maxWidth = W + 4 + "px";

  const curve = (ax: number, ay: number, bx: number, by: number, cls: string) => {
    const mx = (ax + bx) / 2;
    svg(s, "path", { d: `M${ax} ${ay} C${mx} ${ay} ${mx} ${by} ${bx} ${by}`, class: cls });
  };
  const fy = focusBox.y + fh / 2;
  for (const b of conceptBox.values()) curve(FW, fy, b.x, b.y + CH / 2, "bt-edge-concept");
  for (const e of edges) {
    const a = conceptBox.get(e.from)!, b = cardBox.get(e.to)!;
    curve(a.x + CW, a.y + CH / 2, b.x, b.y + b.h / 2, "bt-edge-concept");
  }
  for (const c of onlyRelated) {
    const b = cardBox.get(cardKey(c))!;
    // Dashed line from the open card, routed below the concept column.
    const by = b.y + b.h / 2;
    svg(s, "path", { d: `M${FW / 2} ${focusBox.y + fh} C${FW / 2} ${by} ${rx - GAP} ${by} ${rx} ${by}`, class: "bt-edge-rel" });
  }

  const text = (g: Element, lines: string[], x: number, y0: number) =>
    lines.forEach((l, i) => {
      const t = svg(g, "text", { x, y: y0 + 4 + LINE * (i + 0.5) + 3 });
      t.textContent = l;
    });

  // Open card
  const fg = svg(s, "g", { class: "bt-node is-active" });
  svg(fg, "title", {}).textContent = plain(focus.q) + " · click to go back to this card in the list";
  fg.addEventListener("click", onFocus);
  svg(fg, "rect", { x: 0, y: focusBox.y, width: FW, height: fh, rx: 6 });
  text(fg, fLines, 10, focusBox.y + 4);

  // Concepts
  for (const b of conceptBox.values()) {
    const g = svg(s, "g", { class: "bt-concept" + (b.concept.exists ? "" : " is-ghost") });
    svg(g, "title", {}).textContent = b.concept.name + (b.concept.exists ? "" : " (no note yet)") + " · click to filter the bank";
    svg(g, "rect", { x: b.x, y: b.y, width: CW, height: CH, rx: 6 });
    const t = svg(g, "text", { x: b.x + 10, y: b.y + CH / 2 + 4 });
    t.textContent = wrap(b.concept.name, 28, 1)[0] || "";
    g.addEventListener("click", () => onConcept(b.concept));
    if (b.empty) {
      const n = svg(s, "text", { x: rx, y: b.y + CH / 2 + 4, class: "bt-map-note" });
      n.textContent = "No other cards yet";
    } else if (b.more > 0) {
      const n = svg(s, "text", { x: rx + 4, y: b.moreY + LINE - 2, class: "bt-map-note" });
      n.textContent = "+" + b.more + " more · click the concept to see them all";
    }
  }

  // Cards
  for (const b of cardBox.values()) {
    const k = cardKey(b.card);
    const g = svg(s, "g", { class: "bt-node" + (b.dashed ? " is-ghost" : "") });
    svg(g, "title", {}).textContent = plain(b.card.q) + (alsoRelated.has(k) ? " · also related directly" : "") + " · click to center the map on it";
    svg(g, "rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 6 });
    text(g, wrap(plain(b.card.q) || "(no question)", alsoRelated.has(k) ? 31 : 34, 2), b.x + 10, b.y + 3);
    if (alsoRelated.has(k)) {
      const t = svg(g, "text", { x: b.x + b.w - 8, y: b.y + 17, "text-anchor": "end", class: "bt-map-rel-mark" });
      t.textContent = "↔";
    }
    g.addEventListener("click", () => onCard(b.card));
  }
}
