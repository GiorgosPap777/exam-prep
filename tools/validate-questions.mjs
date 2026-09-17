#!/usr/bin/env node
// Integrity check for the question bank. No dependencies.
// Whole bank:      node tools/validate-questions.mjs
// A single file:   node tools/validate-questions.mjs data/physics.json
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const single = process.argv[2] || null;

const GREEK = ['α','β','γ','δ','ε','στ','ζ','η','θ','ι','κ','λ'];
const ROMAN = ['i','ii','iii','iv','v','vi','vii','viii','ix','x'];

const errors = [];
const warnings = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.error(`Δεν διαβάζεται το ${path}: ${e.message}`);
    process.exit(1);
  }
}

/* ── Which subjects to check ───────────────────────────── */

let subjects;   // [{ id, title, file, data }]

if (single) {
  const data = readJSON(single);
  subjects = [{ id: data.id || basename(single, '.json'), title: data.title || '?',
                file: single, data }];
} else {
  const indexPath = join(root, 'data', 'index.json');
  if (!existsSync(indexPath)) {
    console.error('Λείπει το data/index.json');
    process.exit(1);
  }
  const index = readJSON(indexPath);
  if (!Array.isArray(index.subjects) || !index.subjects.length) {
    console.error('Το data/index.json δεν έχει subjects');
    process.exit(1);
  }

  const seenSubjects = new Set();
  subjects = [];
  for (const entry of index.subjects) {
    const w = `index → ${entry.id || '?'}`;
    if (!entry.id) { err('index', 'μάθημα χωρίς id'); continue; }
    if (seenSubjects.has(entry.id)) err('index', `διπλό subject id "${entry.id}"`);
    seenSubjects.add(entry.id);
    if (!entry.title) warn(w, 'λείπει το title');
    if (!entry.file) { err(w, 'λείπει το file'); continue; }

    const path = join(root, entry.file);
    if (!existsSync(path)) { err(w, `δεν βρέθηκε το αρχείο ${entry.file}`); continue; }
    const data = readJSON(path);
    // The id lives in both places so a subject file is self-describing; they must agree
    // or the card ids in localStorage would not match what the index says.
    if (data.id && data.id !== entry.id) {
      err(w, `το id μέσα στο ${entry.file} είναι "${data.id}", ο κατάλογος λέει "${entry.id}"`);
    }
    subjects.push({ id: entry.id, title: entry.title || data.title || entry.id,
                    file: entry.file, data });
  }
}

/* ── Per-subject checks ────────────────────────────────── */

const labelsOf = (obj) => (Array.isArray(obj) ? obj.map((x) => x.label) : Object.keys(obj || {}));

const checkLabelSet = (where, labels) => {
  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
  if (dupes.length) err(where, `διπλά labels: ${[...new Set(dupes)].join(', ')}`);
  const odd = labels.filter((l) => !GREEK.includes(l) && !ROMAN.includes(l) && !/^[Α-Ω]\d+$/.test(l));
  if (odd.length) warn(where, `άγνωστα labels: ${odd.join(', ')}`);
};

let totalCards = 0;
let totalExercises = 0;
let totalChapters = 0;
let totalPlaceholders = 0;
const perSubject = [];

for (const subject of subjects) {
  // Accept a bare single-chapter object too, so a half-written file still validates.
  const chapters = subject.data.chapters ? subject.data.chapters : [subject.data];
  // Exercise ids only have to be unique inside a subject — Χημεία 1.87 and Φυσική 1.87
  // are different cards because the card id carries the subject prefix.
  const seenIds = new Map();
  let cards = 0;
  let placeholders = 0;

  for (const ch of chapters) {
    const chId = ch.id || ch.chapter || '?';
    const cw = `${subject.id}/${chId}`;
    if (!ch.title && !ch.chapter) warn(`chapter ${cw}`, 'λείπει το title');

    for (const q of ch.questions || []) {
      const w = `${subject.id}/${q.id}`;
      if (!q.id) { err(`chapter ${cw}`, 'άσκηση χωρίς id'); continue; }
      if (seenIds.has(q.id)) err(w, `διπλό id (υπάρχει ήδη στο κεφάλαιο ${seenIds.get(q.id)})`);
      seenIds.set(q.id, chId);

      const placeholder = q.needs_question_text === true;
      if (placeholder) placeholders++;

      if (q.type === 'single_choice_set') {
        if (!Array.isArray(q.items) || !q.items.length) { err(w, 'κενό items'); continue; }
        // A one-part question needs no label: its α/β/γ/δ are the options, and the
        // card id is the bare exercise key. Two or more parts must be labelled.
        if (q.items.length > 1 || q.items[0].label != null) {
          const labels = q.items.map((it) => it.label);
          if (labels.some((l) => l == null)) err(w, 'άσκηση με πολλά items χωρίς label');
          else checkLabelSet(w, labels);
        }
        for (const it of q.items) {
          const iw = it.label ? `${w}:${it.label}` : w;
          if (!it.correct) { err(iw, 'λείπει το correct'); continue; }
          if (placeholder && it.options == null) continue;
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
          if (!it.text) err(`${w}:${it.label}`, 'λείπει το text');
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

  perSubject.push({ title: subject.title, chapters: chapters.length,
                    exercises: seenIds.size, cards, placeholders });
  totalChapters += chapters.length;
  totalExercises += seenIds.size;
  totalCards += cards;
  totalPlaceholders += placeholders;
}

/* ── Report ────────────────────────────────────────────── */

for (const wmsg of warnings) console.log(`  ⚠  ${wmsg}`);
for (const e of errors) console.log(`  ✗  ${e}`);

console.log('');
const pad = Math.max(12, ...perSubject.map((s) => s.title.length + 1));
for (const s of perSubject) {
  console.log(`${(s.title + ':').padEnd(pad)} ${String(s.cards).padStart(4)} κάρτες  ` +
              `(${s.chapters} κεφ., ${s.exercises} ασκ.` +
              `${s.placeholders ? `, ${s.placeholders} placeholders` : ''})`);
}
if (perSubject.length > 1) {
  console.log(`${'ΣΥΝΟΛΟ:'.padEnd(pad)} ${String(totalCards).padStart(4)} κάρτες  ` +
              `(${totalChapters} κεφ., ${totalExercises} ασκ.` +
              `${totalPlaceholders ? `, ${totalPlaceholders} placeholders` : ''})`);
}
console.log('');
console.log(`Σφάλματα: ${errors.length}   Προειδοποιήσεις: ${warnings.length}`);

process.exit(errors.length ? 1 : 0);
