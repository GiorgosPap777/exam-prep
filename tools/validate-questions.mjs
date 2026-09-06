#!/usr/bin/env node
// Integrity check for questions.json. No dependencies.
// Run after every batch of transcribed photos:  node tools/validate-questions.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.argv[2] ? process.argv[2] : join(root, 'questions.json');

const GREEK = ['α','β','γ','δ','ε','στ','ζ','η','θ','ι','κ','λ'];
const ROMAN = ['i','ii','iii','iv','v','vi','vii','viii','ix','x'];

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

let raw;
try {
  raw = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`Δεν διαβάζεται το ${file}: ${e.message}`);
  process.exit(1);
}

// Accept both the wrapped shape and a bare single-chapter object.
const chapters = raw.chapters ? raw.chapters : [raw];

const seenIds = new Map();
let cards = 0;
let placeholders = 0;

const labelsOf = (obj) => (Array.isArray(obj) ? obj.map((x) => x.label) : Object.keys(obj || {}));

const checkLabelSet = (where, labels) => {
  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (dupes.length) err(where, `διπλά labels: ${[...new Set(dupes)].join(', ')}`);
  const known = labels.every((l) => GREEK.includes(l) || ROMAN.includes(l) || /^[Α-Ω]\d+$/.test(l));
  if (!known) warn(where, `άγνωστα labels: ${labels.filter((l) => !GREEK.includes(l) && !ROMAN.includes(l) && !/^[Α-Ω]\d+$/.test(l)).join(', ')}`);
};

for (const ch of chapters) {
  const chId = ch.id || ch.chapter || '?';
  if (!ch.title && !ch.chapter) warn(`chapter ${chId}`, 'λείπει το title');
  for (const q of ch.questions || []) {
    const w = `${q.id}`;
    if (!q.id) { err(`chapter ${chId}`, 'άσκηση χωρίς id'); continue; }
    if (seenIds.has(q.id)) err(w, `διπλό id (υπάρχει ήδη στο κεφάλαιο ${seenIds.get(q.id)})`);
    seenIds.set(q.id, chId);

    const placeholder = q.needs_question_text === true;
    if (placeholder) placeholders++;

    if (q.type === 'single_choice_set') {
      if (!Array.isArray(q.items) || !q.items.length) { err(w, 'κενό items'); continue; }
      checkLabelSet(w, q.items.map((it) => it.label));
      for (const it of q.items) {
        const iw = `${q.id}:${it.label}`;
        if (!it.correct) { err(iw, 'λείπει το correct'); continue; }
        if (placeholder && it.options == null) { cards += 0; continue; }
        if (!it.stem) err(iw, 'λείπει το stem');
        if (!it.options) { err(iw, 'λείπουν options'); continue; }
        const opts = Object.keys(it.options);
        checkLabelSet(iw, opts);
        if (!opts.includes(it.correct)) err(iw, `το correct "${it.correct}" δεν υπάρχει στα options (${opts.join(', ')})`);
        if (opts.length < 2) err(iw, 'λιγότερα από 2 options');
        cards++;
      }
    } else if (q.type === 'true_false_set') {
      if (!Array.isArray(q.correct_labels)) { err(w, 'λείπει το correct_labels'); continue; }
      if (!Array.isArray(q.items)) {
        if (!placeholder) err(w, 'λείπει το items (και δεν είναι placeholder)');
        continue;
      }
      const labels = q.items.map((it) => it.label);
      checkLabelSet(w, labels);
      for (const it of q.items) {
        if (!it.text) err(`${q.id}:${it.label}`, 'λείπει το text');
        else cards++;
      }
      for (const l of q.correct_labels) {
        if (!labels.includes(l)) err(w, `το correct_labels περιέχει "${l}" που δεν υπάρχει στα items`);
      }
      if (q.correct_labels.length === labels.length) warn(w, 'όλες οι προτάσεις είναι σωστές — σίγουρα;');
    } else if (q.type === 'matching') {
      if (!q.correct || typeof q.correct !== 'object') { err(w, 'λείπει το correct'); continue; }
      if (!Array.isArray(q.left) || !Array.isArray(q.right)) {
        if (!placeholder) err(w, 'λείπουν left/right (και δεν είναι placeholder)');
        continue;
      }
      const L = labelsOf(q.left), R = labelsOf(q.right);
      checkLabelSet(`${w} (left)`, L);
      checkLabelSet(`${w} (right)`, R);
      for (const [k, v] of Object.entries(q.correct)) {
        if (!L.includes(k)) err(w, `το correct αναφέρει left "${k}" που δεν υπάρχει`);
        if (!R.includes(v)) err(w, `το correct αναφέρει right "${v}" που δεν υπάρχει`);
      }
      for (const l of L) {
        if (!(l in q.correct)) err(w, `το left "${l}" δεν έχει αντιστοίχιση στο correct`);
      }
      cards++;   // a matching exercise is drilled as a single whole card
      const targets = Object.values(q.correct);
      const dup = targets.filter((t, i) => targets.indexOf(t) !== i);
      if (dup.length) warn(w, `το ίδιο right χρησιμοποιείται πολλές φορές: ${[...new Set(dup)].join(', ')} (εντάξει αν δεν είναι αμφιμονοσήμαντη)`);
    } else {
      err(w, `άγνωστος type "${q.type}"`);
    }
  }
}

for (const wmsg of warnings) console.log(`  ⚠  ${wmsg}`);
for (const e of errors) console.log(`  ✗  ${e}`);

console.log('');
console.log(`Κεφάλαια:    ${chapters.length}`);
console.log(`Ασκήσεις:    ${seenIds.size}`);
console.log(`Κάρτες:      ${cards}`);
console.log(`Placeholders:${String(placeholders).padStart(2)}`);
console.log(`Σφάλματα:    ${errors.length}   Προειδοποιήσεις: ${warnings.length}`);

process.exit(errors.length ? 1 : 0);
