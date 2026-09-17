/* Exam Prep — offline practice app. No dependencies. */
'use strict';

const STORAGE_KEY = 'examprep.v2';
// The v1 bank was chemistry-only and its card ids carried no subject prefix.
const LEGACY_KEY = 'chemquiz.v1';
const LEGACY_SUBJECT = 'chem';

const GREEK_SEQ = ['α','β','γ','δ','ε','στ','ζ','η','θ','ι','κ','λ'];
const ROMAN_SEQ = ['i','ii','iii','iv','v','vi','vii','viii','ix','x'];
const TYPE_NAMES = {
  single_choice_set: 'Πολλαπλής επιλογής',
  true_false_set: 'Σωστό / Λάθος',
  matching: 'Αντιστοίχιση'
};
// Used when a subject in data/index.json does not name its own colour.
const SUBJECT_COLORS = ['#6366F1', '#0EA5E9', '#F59E0B', '#EC4899', '#10B981', '#8B5CF6'];

let BANK = null;    // { subjects: [ { id, title, color, autoFormat, chapters } ] }
let CARDS = [];     // flat, one entry per drillable card
let TREE = null;    // subjects -> chapters -> exercises, with their cards
let state = null;
let freshState = false;

// Where in the picker the user currently is. Not persisted: every launch starts home.
let nav = { screen: 'home', subjectId: null, chapterKey: null };

/* ── Storage ───────────────────────────────────────────── */

function defaultState() {
  return {
    settings: { exercises: null, types: null,
                shuffle: true, onlyWrong: false, onlyUnseen: false,
                installDismissed: false,
                openSections: { settings: false } },
    stats: {},      // cardId -> { seen, correct, wrong, last }
    session: null   // { ids, i, answers, mode }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) { freshState = true; return defaultState(); }
    const parsed = JSON.parse(raw);
    const merged = Object.assign(defaultState(), parsed);
    // Settings gained keys over time — merge rather than replace wholesale.
    merged.settings = Object.assign(defaultState().settings, parsed.settings || {});
    merged.settings.openSections = Object.assign(
      { settings: false }, (parsed.settings || {}).openSections || {});
    return merged;
  } catch (e) {
    freshState = true;
    return defaultState();
  }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* full or blocked */ }
}

// One-time lift of the chemistry-only v1 progress into the namespaced v2 layout.
// Runs after the bank is loaded, because expanding an old chapter filter into
// exercise keys needs to know which exercises that chapter holds. The old key is
// deliberately left in place as a rollback path.
function migrateLegacy() {
  let raw = null;
  try { raw = localStorage.getItem(LEGACY_KEY); } catch (e) { return false; }
  if (!raw) return false;

  let old;
  try { old = JSON.parse(raw); } catch (e) { return false; }

  const P = (id) => LEGACY_SUBJECT + '/' + id;
  const oldSettings = old.settings || {};

  state.settings.shuffle = oldSettings.shuffle !== false;
  state.settings.onlyWrong = !!oldSettings.onlyWrong;
  state.settings.onlyUnseen = !!oldSettings.onlyUnseen;
  state.settings.installDismissed = !!oldSettings.installDismissed;
  state.settings.types = Array.isArray(oldSettings.types) ? oldSettings.types.slice() : null;

  for (const [k, v] of Object.entries(old.stats || {})) state.stats[P(k)] = v;

  if (old.session && Array.isArray(old.session.ids)) {
    const answers = {};
    for (const [k, v] of Object.entries(old.session.answers || {})) answers[P(k)] = v;
    state.session = {
      ids: old.session.ids.map(P),
      i: old.session.i || 0,
      answers,
      mode: old.session.mode || 'practice'
    };
  }

  // Old selection: `exercises` was a list of bare ids, `chapters` a list of chapter ids.
  let sel = null;
  if (Array.isArray(oldSettings.exercises)) sel = new Set(oldSettings.exercises.map(P));
  if (Array.isArray(oldSettings.chapters)) {
    const chapterKeys = new Set(oldSettings.chapters.map(P));
    const fromChapters = new Set(
      CARDS.filter((c) => chapterKeys.has(c.chapterKey)).map((c) => c.exKey));
    sel = sel ? new Set([...sel].filter((k) => fromChapters.has(k))) : fromChapters;
  }
  setSelection(sel ? allExerciseKeys().filter((k) => sel.has(k)) : null);

  saveState();
  return true;
}

/* ── Formula formatting ────────────────────────────────── */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Explicit markup, understood in every subject:  m/s^2  10^-3  v_0  a_{max}
// Only fires before "{…}" or a signed number, so a stray underscore in prose is safe.
function applyScripts(s) {
  s = s.replace(/\^\{([^{}]*)\}/g, '<sup>$1</sup>');
  s = s.replace(/_\{([^{}]*)\}/g, '<sub>$1</sub>');
  s = s.replace(/\^([+−-]?\d+)/g, '<sup>$1</sup>');
  s = s.replace(/_([+−-]?\d+)/g, '<sub>$1</sub>');
  return s;
}

// Chemistry writes formulas as plain ASCII, so the subscripts are inferred:
// CO2 -> CO₂, [Cu(NH3)4]2+ -> [Cu(NH₃)₄]²⁺, Mr -> M_r, H2O(s) -> H₂O₍s₎.
// Only fires on Latin-script runs, so Greek prose passes through untouched. This is
// wrong for physics (m/s2 is an exponent, not an index), so it is opt-in per subject.
function chemRules(s) {
  s = s.replace(/\](\d*)([+−-])/g, ']<sup>$1$2</sup>');           // ]2+
  s = s.replace(/([A-Za-z])(\d+)([+−])/g, '$1<sup>$2$3</sup>');   // Fe2+
  s = s.replace(/([A-Za-z)\]])(\d+)/g, '$1<sub>$2</sub>');        // CO2, (CH3)4
  s = s.replace(/\bMr\b/g, 'M<sub>r</sub>');
  s = s.replace(/\s?\((aq|s|g|l|ℓ)\)/g, '<sub>($1)</sub>');       // H2O(s)
  return s;
}

function formatSci(text, autoFormat) {
  const s = applyScripts(esc(text));
  return autoFormat === 'chemistry' ? chemRules(s) : s;
}

function lewisHTML(spec) {
  const dot = (n) => n > 0 ? '<span class="dots">' + '•'.repeat(n) + '</span>' : '<span></span>';
  return '<span class="lewis">' +
    '<span></span>' + dot(spec.top) + '<span></span>' +
    dot(spec.left) + '<span class="sym">' + esc(spec.symbol) + '</span>' + dot(spec.right) +
    '<span></span>' + dot(spec.bottom) + '<span></span>' +
    '</span>';
}

function optionHTML(value, autoFormat) {
  if (value && typeof value === 'object' && value.lewis) return lewisHTML(value.lewis);
  return formatSci(value, autoFormat);
}

function sortLabels(labels) {
  const seq = labels.every((l) => ROMAN_SEQ.includes(l)) ? ROMAN_SEQ
            : labels.every((l) => GREEK_SEQ.includes(l)) ? GREEK_SEQ
            : null;
  if (!seq) return labels.slice(); // e.g. Α1..Α6 — keep author order
  return labels.slice().sort((a, b) => seq.indexOf(a) - seq.indexOf(b));
}

// Colours come from a data file, but they are interpolated into a style attribute,
// so anything that is not a plain hex literal is dropped.
function safeColor(c) {
  return typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : null;
}

/* ── Progress rings & counters ─────────────────────────── */

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Circular progress ring; pct === null renders an empty ring.
function progressRing(pct, size, stroke, color) {
  const r = 50 - stroke / 2;
  const circ = 2 * Math.PI * r;
  const target = circ * (1 - (pct || 0) / 100);
  const tint = safeColor(color);
  return `<svg class="ring" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">` +
    `<circle class="ring-track" cx="50" cy="50" r="${r}" stroke-width="${stroke}"/>` +
    `<circle class="ring-bar" cx="50" cy="50" r="${r}" stroke-width="${stroke}" ` +
    `stroke-dasharray="${circ.toFixed(2)}" ` +
    `style="stroke-dashoffset:${circ.toFixed(2)}${tint ? ';stroke:' + tint : ''}" ` +
    `data-target="${target.toFixed(2)}"/></svg>`;
}

// Settles every ring and [data-count] inside `root`; tweens them when `animate`.
function animateStats(root, animate) {
  const tween = animate && !reducedMotion();

  for (const bar of root.querySelectorAll('.ring-bar')) {
    const to = bar.dataset.target;
    if (!tween) {
      bar.style.transition = 'none';
      bar.style.strokeDashoffset = to;
      void bar.getBoundingClientRect();
      bar.style.transition = '';
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => { bar.style.strokeDashoffset = to; }));
    }
  }

  for (const el of root.querySelectorAll('[data-count]')) {
    const to = Number(el.dataset.count);
    const suffix = el.dataset.suffix || '';
    if (!tween) { el.textContent = to + suffix; continue; }
    const t0 = performance.now(), dur = 800;
    const step = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      el.textContent = Math.round(to * (1 - Math.pow(1 - p, 3))) + suffix;
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

/* ── Bank -> cards ─────────────────────────────────────── */

function buildCards(bank) {
  const out = [];
  for (const subject of bank.subjects) {
    for (const ch of subject.chapters) {
      for (const q of ch.questions || []) {
        // Ids are namespaced by subject: Χημεία 1.87 and Φυσική 1.87 are different
        // cards, and the id is the localStorage key, so the prefix cannot be dropped.
        const base = {
          subjectId: subject.id, subjectTitle: subject.title, subjectColor: subject.color,
          autoFormat: subject.autoFormat,
          chapterKey: subject.id + '/' + ch.id, chapterTitle: ch.title,
          exId: q.id, exKey: subject.id + '/' + q.id,
          section: q.section || null, type: q.type,
          instructions: q.instructions || ''
        };
        if (q.needs_question_text) continue;

        if (q.type === 'single_choice_set') {
          for (const it of q.items || []) {
            if (!it.stem || !it.options) continue;
            out.push(Object.assign({}, base, {
              // A one-part question has no sub-label — its α/β/γ/δ are the options,
              // so the card is the exercise itself and the badge shows just "1.11".
              id: base.exKey + (it.label ? ':' + it.label : ''),
              label: it.label || null,
              stem: it.stem,
              options: sortLabels(Object.keys(it.options)).map((l) => ({ label: l, value: it.options[l] })),
              correct: it.correct,
              explanation: it.explanation || null
            }));
          }
        } else if (q.type === 'true_false_set') {
          const trueSet = new Set(q.correct_labels || []);
          for (const it of q.items || []) {
            if (!it.text) continue;
            out.push(Object.assign({}, base, {
              id: base.exKey + ':' + it.label,
              label: it.label,
              stem: it.text,
              twoUp: true,
              options: [
                { label: 'true', value: 'Σωστό' },
                { label: 'false', value: 'Λάθος' }
              ],
              correct: trueSet.has(it.label) ? 'true' : 'false',
              explanation: it.explanation || null
            }));
          }
        } else if (q.type === 'matching') {
          if (!Array.isArray(q.left) || !Array.isArray(q.right)) continue;
          // A matching exercise is solved as a whole — you pick each pair by comparing
          // it against the others and eliminating. Splitting it into one card per row
          // makes it unsolvable, so the whole exercise is a single card.
          const pairs = q.left
            .filter((l) => l.label in (q.correct || {}))
            .map((l) => ({ label: l.label, text: l.text,
                           correct: q.correct[l.label], explanation: l.explanation || null }));
          if (!pairs.length) continue;
          out.push(Object.assign({}, base, {
            id: base.exKey,
            label: null,
            matching: true,
            pairs,
            options: q.right.map((r) => ({ label: r.label, value: r.text }))
          }));
        }
      }
    }
  }
  return out;
}

// Subjects -> chapters -> exercises, carrying their cards. Only branches that
// actually produced cards survive, so nothing unselectable is ever drawn.
function buildTree(bank, cards) {
  const subjects = [];
  for (const s of bank.subjects) {
    const chapters = [];
    for (const ch of s.chapters) {
      const key = s.id + '/' + ch.id;
      const chCards = cards.filter((c) => c.chapterKey === key);
      if (!chCards.length) continue;

      const exercises = [];
      const byKey = new Map();
      for (const c of chCards) {
        let ex = byKey.get(c.exKey);
        if (!ex) {
          ex = { key: c.exKey, id: c.exId, cards: [] };
          byKey.set(c.exKey, ex);
          exercises.push(ex);
        }
        ex.cards.push(c);
      }
      chapters.push({ key, id: ch.id, title: ch.title || ch.id,
                      source: ch.source || null, cards: chCards, exercises });
    }
    if (!chapters.length) continue;
    subjects.push({ id: s.id, title: s.title, color: s.color,
                    chapters, cards: cards.filter((c) => c.subjectId === s.id) });
  }
  return { subjects };
}

function subjectById(id) { return TREE.subjects.find((s) => s.id === id) || null; }
function chapterByKey(key) {
  for (const s of TREE.subjects) {
    const ch = s.chapters.find((c) => c.key === key);
    if (ch) return { subject: s, chapter: ch };
  }
  return null;
}

function missingEntries(bank) {
  const out = [];
  for (const subject of bank.subjects) {
    for (const ch of subject.chapters) {
      for (const q of ch.questions || []) {
        if (q.needs_question_text) out.push({ subject, ch, q });
      }
    }
  }
  return out;
}

/* ── Selection ─────────────────────────────────────────── */

// The whole selection is one list of exercise keys; null means "everything".
// A chapter is selected exactly when all of its exercises are.
function allExerciseKeys() {
  const out = [];
  const seen = new Set();
  for (const c of CARDS) {
    if (seen.has(c.exKey)) continue;
    seen.add(c.exKey);
    out.push(c.exKey);
  }
  return out;
}

function setSelection(keys) {
  if (!keys) { state.settings.exercises = null; saveState(); return; }
  const all = allExerciseKeys();
  const set = new Set(keys);
  const next = all.filter((k) => set.has(k));   // canonical order, unknown keys dropped
  state.settings.exercises = (next.length === all.length) ? null : next;
  saveState();
}

function selectExercises(keys, on) {
  const all = allExerciseKeys();
  const set = new Set(state.settings.exercises || all);
  for (const k of keys) { if (on) set.add(k); else set.delete(k); }
  setSelection([...set]);
}

function isSelected(key) {
  const sel = state.settings.exercises;
  return !sel || sel.includes(key);
}

// 'all' | 'some' | 'none' over a list of exercise keys.
function selectionState(keys) {
  const n = keys.filter(isSelected).length;
  return n === 0 ? 'none' : n === keys.length ? 'all' : 'some';
}

function chapterKeysOf(chapter) { return chapter.exercises.map((e) => e.key); }
function subjectKeysOf(subject) {
  return subject.chapters.reduce((acc, ch) => acc.concat(chapterKeysOf(ch)), []);
}

/* ── Filtering ─────────────────────────────────────────── */

// `scope` narrows to where the user pressed Έναρξη: {subjectId} | {chapterKey}.
// It is never persisted — only the exercise selection and the settings are. There is
// no cross-subject scope: μια συνεδρία ζει πάντα μέσα σε ένα μάθημα. Ένα scope χωρίς
// μάθημα δεν επιστρέφει όλη την τράπεζα — επιστρέφει τίποτα, ώστε να μη γεννηθεί
// ποτέ ανάμεικτη συνεδρία από λάθος κλήση.
function activePool(scope) {
  const s = state.settings;
  const sc = scope || {};
  // A chapter key carries its subject ("phys/9"), so either form pins exactly one.
  const subjectId = sc.subjectId || (sc.chapterKey ? String(sc.chapterKey).split('/')[0] : null);
  if (!subjectId) return [];
  const exSet = s.exercises ? new Set(s.exercises) : null;
  const tySet = s.types ? new Set(s.types) : null;

  return CARDS.filter((c) => {
    if (c.subjectId !== subjectId) return false;
    if (sc.chapterKey && c.chapterKey !== sc.chapterKey) return false;
    if (exSet && !exSet.has(c.exKey)) return false;
    if (tySet && !tySet.has(c.type)) return false;
    const st = state.stats[c.id];
    if (s.onlyWrong && !(st && st.last === 'wrong')) return false;
    if (s.onlyUnseen && st && st.seen) return false;
    return true;
  });
}

function statsFor(cards) {
  let answered = 0, correct = 0, tries = 0, wrong = 0;
  for (const c of cards) {
    const st = state.stats[c.id];
    if (!st) continue;
    if (st.seen > 0) answered++;
    correct += st.correct || 0;
    tries += (st.correct || 0) + (st.wrong || 0);
    if (st.last === 'wrong') wrong++;
  }
  return { total: cards.length, answered, wrong,
           pct: tries ? Math.round(100 * correct / tries) : null };
}

function shuffled(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ── DOM helpers ───────────────────────────────────────── */

const $ = (id) => document.getElementById(id);

// Tolerate a missing element rather than aborting boot on a stale cached shell.
function on(id, ev, fn) {
  const el = $(id);
  if (el) el.addEventListener(ev, fn);
  else console.warn('missing element:', id);
}

function show(screenId) {
  for (const el of document.querySelectorAll('.screen')) el.hidden = (el.id !== screenId);
  window.scrollTo(0, 0);
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

function poolText(n) {
  return n ? plural(n, 'ερώτηση', 'ερωτήσεις') + ' στην επιλογή'
           : 'Καμία ερώτηση με αυτά τα φίλτρα';
}

function heroHTML(st, color) {
  return `<div class="ring-wrap">${progressRing(st.pct, 112, 9, color)}` +
      `<div class="ring-label">` +
        (st.pct === null ? '<b>—</b>' : `<b data-count="${st.pct}" data-suffix="%">0%</b>`) +
        `<span>επιτυχία</span></div></div>` +
    `<div class="hero-stats">` +
      `<div class="hero-stat"><b>${st.answered}</b><span>από ${st.total} απαντημένες</span></div>` +
      `<div class="hero-stat${st.wrong ? ' flag' : ''}"><b>${st.wrong}</b><span>για επανάληψη</span></div>` +
    `</div>`;
}

/* ── Navigation ────────────────────────────────────────── */

function goHome(animate) {
  nav = { screen: 'home', subjectId: null, chapterKey: null };
  renderHome(animate);
  show('screen-home');
}

function goSubject(subjectId, animate) {
  nav = { screen: 'subject', subjectId, chapterKey: null };
  renderSubject(animate);
  show('screen-subject');
}

function goChapter(chapterKey) {
  const found = chapterByKey(chapterKey);
  if (!found) return goHome(true);
  nav = { screen: 'chapter', subjectId: found.subject.id, chapterKey };
  renderChapter();
  show('screen-chapter');
}

// Return to wherever the picker was left — used by ‹ and by quitting a session.
function showCurrentNav() {
  if (nav.screen === 'chapter' && chapterByKey(nav.chapterKey)) return goChapter(nav.chapterKey);
  if (nav.screen === 'subject' && subjectById(nav.subjectId)) return goSubject(nav.subjectId, true);
  return goHome(true);
}

/* ── Home: subjects ────────────────────────────────────── */

function renderChips(container, items, isOn, onToggle) {
  container.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(isOn(it.value)));
    b.innerHTML = it.html;
    b.addEventListener('click', () => onToggle(it.value));
    container.appendChild(b);
  }
}

function renderHome(animate) {
  const s = state.settings;

  $('home-stats').innerHTML = heroHTML(statsFor(CARDS), null);
  animateStats($('home-stats'), animate);

  // Subject cards
  const list = $('subject-list');
  list.innerHTML = '';
  TREE.subjects.forEach((subject, i) => {
    const st = statsFor(subject.cards);
    const sel = selectionState(subjectKeysOf(subject));
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'row-card subject-card';
    b.style.setProperty('--i', i);
    b.innerHTML =
      `<span class="ring-wrap small">${progressRing(st.pct, 48, 7, subject.color)}` +
        `<span class="ring-mini">${st.pct === null ? '—' : st.pct + '%'}</span></span>` +
      `<span class="row-body">` +
        `<span class="row-title">${esc(subject.title)}</span>` +
        `<span class="row-sub">${plural(st.total, 'ερώτηση', 'ερωτήσεις')} · ` +
          `${plural(subject.chapters.length, 'κεφάλαιο', 'κεφάλαια')}` +
          (sel === 'all' ? '' : sel === 'none' ? ' · <em>εκτός επιλογής</em>' : ' · <em>μερική επιλογή</em>') +
        `</span>` +
      `</span>` +
      `<span class="row-chev" aria-hidden="true"></span>`;
    b.addEventListener('click', () => goSubject(subject.id, true));
    list.appendChild(b);
  });
  if (!TREE.subjects.length) {
    list.innerHTML = '<p class="empty">Καμία ερώτηση ακόμη.</p>';
  }
  animateStats(list, animate);

  // Settings
  $('opt-shuffle').checked = s.shuffle;
  $('opt-only-wrong').checked = s.onlyWrong;
  $('opt-only-unseen').checked = s.onlyUnseen;

  const types = [...new Set(CARDS.map((c) => c.type))];
  renderChips($('filter-types'),
    types.map((t) => ({ value: t, html: esc(TYPE_NAMES[t] || t) })),
    (t) => !s.types || s.types.includes(t),
    (t) => {
      const cur = s.types ? s.types.slice() : types.slice();
      const i = cur.indexOf(t);
      if (i >= 0) cur.splice(i, 1); else cur.push(t);
      s.types = (cur.length === types.length) ? null : cur;
      saveState(); renderHome();
    });

  const bits = [];
  if (s.shuffle) bits.push('Τυχαία σειρά');
  if (s.onlyWrong) bits.push('Μόνο λάθη');
  if (s.onlyUnseen) bits.push('Μόνο αναπάντητες');
  if (s.types) bits.push(plural(s.types.length, 'τύπος', 'τύποι'));
  $('sum-settings').textContent = bits.length ? bits.join(' · ') : 'Καμία';
  $('sec-settings').open = !!s.openSections.settings;

  // Bottom bar. Εξάσκηση ξεκινά πάντα μέσα σε ένα μάθημα, οπότε εδώ μένει μόνο το
  // «Συνέχεια» — και μαζί του κρύβεται ολόκληρη η μπάρα, αλλιώς μένει ένα κενό ταμπλό.
  const canResume = state.session && state.session.i < state.session.ids.length;
  $('home-actions').hidden = !canResume;
  $('btn-resume').hidden = !canResume;
  if (canResume) {
    $('btn-resume').textContent = `Συνέχεια (${state.session.i}/${state.session.ids.length})`;
  }

  const missing = missingEntries(BANK).length;
  $('btn-missing').textContent = missing ? `Λείπουν κείμενα (${missing})` : 'Λείπουν κείμενα';
}

/* ── Subject: chapters ─────────────────────────────────── */

// Tri-state box: all / some / none of the exercises underneath are selected.
function cboxHTML(sel) {
  return `<span class="cbox ${sel}" aria-hidden="true"></span>`;
}

function renderSubject(animate) {
  const subject = subjectById(nav.subjectId);
  if (!subject) return goHome(true);

  $('subject-title').textContent = subject.title;
  $('subject-stats').innerHTML = heroHTML(statsFor(subject.cards), subject.color);
  animateStats($('subject-stats'), animate);

  const list = $('chapter-list');
  list.innerHTML = '';
  subject.chapters.forEach((ch, i) => {
    const st = statsFor(ch.cards);
    const sel = selectionState(chapterKeysOf(ch));

    const row = document.createElement('div');
    row.className = 'row-card row-split';
    row.style.setProperty('--i', i);

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'row-main';
    main.setAttribute('aria-pressed', sel === 'all' ? 'true' : sel === 'some' ? 'mixed' : 'false');
    main.innerHTML = cboxHTML(sel) +
      `<span class="row-body">` +
        `<span class="row-title">${esc(ch.title)}</span>` +
        `<span class="row-sub">${plural(st.total, 'ερώτηση', 'ερωτήσεις')}` +
          (st.pct === null ? '' : ` · ${st.pct}% επιτυχία`) +
        `</span>` +
      `</span>`;
    main.addEventListener('click', () => {
      selectExercises(chapterKeysOf(ch), sel !== 'all');
      renderSubject();
    });

    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'row-more';
    more.setAttribute('aria-label', 'Ασκήσεις: ' + ch.title);
    more.innerHTML = '<span class="row-chev" aria-hidden="true"></span>';
    more.addEventListener('click', () => goChapter(ch.key));

    row.appendChild(main);
    row.appendChild(more);
    list.appendChild(row);
  });

  const allSel = selectionState(subjectKeysOf(subject));
  $('btn-toggle-all-ch').textContent = allSel === 'all' ? 'Κανένα' : 'Επιλογή όλων';
  $('btn-toggle-all-ch').onclick = () => {
    selectExercises(subjectKeysOf(subject), allSel !== 'all');
    renderSubject();
  };

  const pool = activePool({ subjectId: subject.id });
  $('subject-pool').textContent = poolText(pool.length);
  $('btn-start-subject').disabled = pool.length === 0;
}

/* ── Chapter: exercises ────────────────────────────────── */

function renderChapter() {
  const found = chapterByKey(nav.chapterKey);
  if (!found) return goHome(true);
  const { subject, chapter } = found;

  // The chapter id is only a storage key — two source books both number their
  // chapters from 1, so showing it would print "ox1" at the reader.
  $('chapter-title').textContent = chapter.title;
  // The chapter's source line usually opens with the subject name already
  // ("Χημεία, σελ. 56–62") — μην το γράψεις δύο φορές.
  const src = chapter.source || '';
  $('chapter-sub').textContent = src.indexOf(subject.title) === 0
    ? src
    : subject.title + (src ? ' · ' + src : '');

  renderChips($('filter-exercises'),
    chapter.exercises.map((e) => ({ value: e.key, html: esc(e.id) })),
    isSelected,
    (key) => { selectExercises([key], !isSelected(key)); renderChapter(); });

  const keys = chapterKeysOf(chapter);
  const sel = selectionState(keys);
  $('btn-toggle-all-ex').textContent = sel === 'all' ? 'Καμία' : 'Επιλογή όλων';
  $('btn-toggle-all-ex').onclick = () => {
    selectExercises(keys, sel !== 'all');
    renderChapter();
  };

  const pool = activePool({ chapterKey: chapter.key });
  $('chapter-pool').textContent = poolText(pool.length);
  $('btn-start-chapter').disabled = pool.length === 0;
}

/* ── Quiz ──────────────────────────────────────────────── */

function startSession(cards, mode) {
  if (!cards.length) return;
  const list = state.settings.shuffle ? shuffled(cards) : cards;
  state.session = { ids: list.map((c) => c.id), i: 0, answers: {}, mode: mode || 'practice' };
  saveState();
  show('screen-quiz');
  renderCard();
}

function cardById(id) { return CARDS.find((c) => c.id === id); }

function subjectChip(card) {
  const tint = safeColor(card.subjectColor);
  return `<span class="badge subject-chip"${tint ? ` style="background:${tint}"` : ''}>` +
         `${esc(card.subjectTitle)}</span>`;
}

function renderCard() {
  const sess = state.session;
  if (!sess || sess.i >= sess.ids.length) return renderResults();

  const card = cardById(sess.ids[sess.i]);
  if (!card) { sess.i++; return renderCard(); }

  const F = (t) => formatSci(t, card.autoFormat);

  const answeredCount = Object.keys(sess.answers).length;
  const correctCount = Object.values(sess.answers).filter((a) => a.ok).length;
  $('progress-fill').style.width = (100 * sess.i / sess.ids.length) + '%';
  $('score').textContent = `${correctCount}/${answeredCount}`;

  const badge = subjectChip(card) +
    `<span class="badge">${esc(card.exId)}${card.label ? ' · ' + esc(card.label) : ''}</span>` +
    (card.section ? `<span class="badge section-tag">${esc(card.section)}</span>` : '');

  const instr = card.instructions ? `<p class="instructions">${F(card.instructions)}</p>` : '';

  if (card.matching) return renderMatchCard(card, badge, instr);

  let stemHTML;
  if (card.twoUp) {
    stemHTML = `<p class="stem"><span class="sub-label">${esc(card.label)})</span>${F(card.stem)}</p>`;
  } else {
    stemHTML = `<p class="stem">${F(card.stem)}</p>`;
  }

  const optClass = card.twoUp ? 'options two-up' : 'options';
  const opts = card.options.map((o, i) =>
    `<button class="option" type="button" style="--i:${i}" data-label="${esc(o.label)}">` +
    `<span class="opt-label">${card.twoUp ? '' : esc(o.label) + ')'}</span>` +
    `<span class="opt-text">${optionHTML(o.value, card.autoFormat)}</span>` +
    `<span class="mark"></span></button>`
  ).join('');

  $('card-wrap').innerHTML = `<div class="badges">${badge}</div>` + instr + stemHTML +
    `<div class="${optClass}" id="options">${opts}</div><div id="feedback"></div>`;

  $('btn-next').hidden = true;
  $('btn-next').disabled = false;
  delete $('btn-next').dataset.mode;

  const prior = sess.answers[card.id];
  if (prior) {
    lockCard(card, prior.chosen);
  } else {
    for (const b of $('options').querySelectorAll('.option')) {
      b.addEventListener('click', () => answer(card, b.dataset.label));
    }
  }
}

/* ── Matching (whole exercise) ──────────────────────────── */

// Draft assignment for the matching card on screen: { leftLabel: rightLabel }.
function matchDraft(cardId) {
  const sess = state.session;
  if (!sess.draft || sess.draft.id !== cardId) sess.draft = { id: cardId, map: {} };
  return sess.draft.map;
}

function renderMatchCard(card, badge, instr) {
  const F = (t) => formatSci(t, card.autoFormat);
  const O = (v) => optionHTML(v, card.autoFormat);

  const rows = card.pairs.map((p, i) =>
    `<button class="mrow" type="button" style="--i:${i}" data-left="${esc(p.label)}">` +
      `<span class="mrow-main">` +
        `<span class="mrow-label">${esc(p.label)})</span>` +
        `<span class="mrow-text">${F(p.text)}</span>` +
        `<span class="mrow-slot"></span>` +
      `</span>` +
      `<span class="mrow-extra"></span>` +
    `</button>`).join('');

  const pool = card.options.map((o, i) =>
    `<button class="mopt" type="button" style="--i:${i}" data-right="${esc(o.label)}">` +
      `<span class="mopt-label">${esc(o.label)})</span>` +
      `<span class="mopt-text">${O(o.value)}</span>` +
    `</button>`).join('');

  $('card-wrap').innerHTML = `<div class="badges">${badge}</div>` + instr +
    `<div class="match">` +
      `<div class="match-rows" id="match-rows">${rows}</div>` +
      `<p class="match-hint" id="match-hint"></p>` +
      `<div class="match-pool" id="match-pool">${pool}</div>` +
    `</div><div id="feedback"></div>`;

  const prior = state.session.answers[card.id];
  if (prior) {
    lockMatchCard(card, prior.chosen, prior.detail);
    return;
  }

  const map = matchDraft(card.id);
  let active = null;

  const setActive = (label) => { active = label; paint(); };

  const nextUnassigned = () =>
    (card.pairs.find((p) => !map[p.label]) || {}).label || null;

  function paint() {
    if (active && map[active]) active = null;
    if (!active) active = nextUnassigned();

    for (const row of $('match-rows').querySelectorAll('.mrow')) {
      const l = row.dataset.left;
      const assigned = map[l];
      row.classList.toggle('active', l === active);
      row.classList.toggle('filled', !!assigned);
      const slot = row.querySelector('.mrow-slot');
      if (assigned) {
        const o = card.options.find((x) => x.label === assigned);
        slot.innerHTML = `<span class="slot-label">${esc(assigned)})</span> ${O(o.value)}`;
      } else {
        slot.textContent = l === active ? '…' : '';
      }
    }

    const used = new Set(Object.values(map));
    for (const opt of $('match-pool').querySelectorAll('.mopt')) {
      opt.classList.toggle('used', used.has(opt.dataset.right));
    }

    const left = card.pairs.length - Object.keys(map).length;
    $('match-hint').textContent = left === 0
      ? 'Όλα αντιστοιχίστηκαν — πάτα Έλεγχος.'
      : (Object.keys(map).length === 0
          ? 'Διάλεξε στοιχείο από τη στήλη Β για τη γραμμή που φωτίζεται.'
          : `Απομένουν ${left}. Πάτα μια γραμμή για να την αλλάξεις.`);

    $('btn-next').hidden = false;
    $('btn-next').textContent = 'Έλεγχος';
    $('btn-next').dataset.mode = 'check';
    $('btn-next').disabled = left !== 0;
    saveState();
  }

  for (const row of $('match-rows').querySelectorAll('.mrow')) {
    row.addEventListener('click', () => {
      const l = row.dataset.left;
      if (map[l]) delete map[l];      // tapping a filled row clears it
      setActive(l);
    });
  }
  for (const opt of $('match-pool').querySelectorAll('.mopt')) {
    opt.addEventListener('click', () => {
      const r = opt.dataset.right;
      if (Object.values(map).includes(r)) {
        // Move it: drop it from whichever row holds it, then reassign.
        for (const k of Object.keys(map)) if (map[k] === r) delete map[k];
      }
      if (active) map[active] = r;
      active = null;
      paint();
    });
  }

  paint();
}

function gradeMatch(card) {
  const sess = state.session;
  const map = matchDraft(card.id);
  const detail = {};
  let n = 0;
  for (const p of card.pairs) {
    detail[p.label] = map[p.label] === p.correct;
    if (detail[p.label]) n++;
  }
  const ok = n === card.pairs.length;
  sess.answers[card.id] = { chosen: Object.assign({}, map), ok, detail, score: n };
  sess.draft = null;

  const st = state.stats[card.id] || { seen: 0, correct: 0, wrong: 0, last: null };
  st.seen++;
  if (ok) st.correct++; else st.wrong++;
  st.last = ok ? 'correct' : 'wrong';
  state.stats[card.id] = st;
  saveState();

  lockMatchCard(card, sess.answers[card.id].chosen, detail);

  const answered = Object.keys(sess.answers).length;
  const right = Object.values(sess.answers).filter((a) => a.ok).length;
  $('score').textContent = `${right}/${answered}`;
}

function lockMatchCard(card, map, detail) {
  const F = (t) => formatSci(t, card.autoFormat);
  const O = (v) => optionHTML(v, card.autoFormat);

  const pool = $('match-pool');
  if (pool) pool.remove();
  const hint = $('match-hint');
  if (hint) hint.remove();

  let n = 0;
  for (const p of card.pairs) if (detail[p.label]) n++;

  for (const row of $('match-rows').querySelectorAll('.mrow')) {
    const l = row.dataset.left;
    const p = card.pairs.find((x) => x.label === l);
    const given = map[l];
    const good = detail[l];
    row.disabled = true;
    row.classList.remove('active');
    row.classList.add(good ? 'correct' : 'wrong');

    const givenOpt = card.options.find((o) => o.label === given);
    row.querySelector('.mrow-slot').innerHTML =
      (given ? `<span class="slot-label">${esc(given)})</span> ${O(givenOpt.value)} ` : '') +
      `<span class="slot-mark">${good ? '✓' : '✕'}</span>`;

    const rightOpt = card.options.find((o) => o.label === p.correct);
    row.querySelector('.mrow-extra').innerHTML =
      (good ? '' : `<span class="mrow-correct">Σωστό: <b>${esc(p.correct)})</b> ${O(rightOpt.value)}</span>`) +
      (p.explanation ? `<span class="mrow-why">${F(p.explanation)}</span>` : '');
  }

  const total = card.pairs.length;
  const ok = n === total;
  $('feedback').innerHTML =
    `<div class="feedback ${ok ? 'ok' : 'bad'}">` +
    `<div class="fb-head"><span class="fb-icon">${ok ? '✓' : '✕'}</span>` +
    `<h3>${ok ? 'Σωστά' : 'Λάθος'}</h3></div>` +
    `<p>${n} από ${total} σωστές αντιστοιχίσεις</p>` +
    `</div>`;

  const sess = state.session;
  $('btn-next').hidden = false;
  $('btn-next').disabled = false;
  delete $('btn-next').dataset.mode;
  $('btn-next').textContent = (sess.i + 1 >= sess.ids.length) ? 'Αποτελέσματα' : 'Επόμενη';
}

function answer(card, chosen) {
  const sess = state.session;
  const ok = chosen === card.correct;
  sess.answers[card.id] = { chosen, ok };

  const st = state.stats[card.id] || { seen: 0, correct: 0, wrong: 0, last: null };
  st.seen++;
  if (ok) st.correct++; else st.wrong++;
  st.last = ok ? 'correct' : 'wrong';
  state.stats[card.id] = st;
  saveState();

  lockCard(card, chosen);

  const answeredCount = Object.keys(sess.answers).length;
  const correctCount = Object.values(sess.answers).filter((a) => a.ok).length;
  $('score').textContent = `${correctCount}/${answeredCount}`;
}

function lockCard(card, chosen) {
  const ok = chosen === card.correct;
  for (const b of $('options').querySelectorAll('.option')) {
    const l = b.dataset.label;
    b.disabled = true;
    if (l === card.correct) {
      b.classList.add('correct');
      b.querySelector('.mark').textContent = '✓';
    } else if (l === chosen) {
      b.classList.add('wrong');
      b.querySelector('.mark').textContent = '✕';
    } else {
      b.classList.add('muted');
    }
  }

  const correctOpt = card.options.find((o) => o.label === card.correct);
  let answerLine;
  if (card.twoUp) {
    answerLine = `Σωστή απάντηση: <b>${card.correct === 'true' ? 'Σωστό' : 'Λάθος'}</b>`;
  } else {
    answerLine = `Σωστή απάντηση: <b>${esc(card.correct)})</b> ` +
                 optionHTML(correctOpt ? correctOpt.value : '', card.autoFormat);
  }

  $('feedback').innerHTML =
    `<div class="feedback ${ok ? 'ok' : 'bad'}">` +
    `<div class="fb-head"><span class="fb-icon">${ok ? '✓' : '✕'}</span>` +
    `<h3>${ok ? 'Σωστά' : 'Λάθος'}</h3></div>` +
    (ok ? '' : `<p>${answerLine}</p>`) +
    (card.explanation ? `<p class="why"><b>Αιτιολόγηση:</b> ${formatSci(card.explanation, card.autoFormat)}</p>` : '') +
    `</div>`;

  const sess = state.session;
  $('btn-next').hidden = false;
  $('btn-next').textContent = (sess.i + 1 >= sess.ids.length) ? 'Αποτελέσματα' : 'Επόμενη';
}

function nextCard() {
  if ($('btn-next').dataset.mode === 'check') {
    const card = cardById(state.session.ids[state.session.i]);
    if (card) return gradeMatch(card);
  }
  state.session.i++;
  saveState();
  renderCard();
}

/* ── Results ───────────────────────────────────────────── */

function renderResults() {
  const sess = state.session;
  const entries = Object.entries(sess.answers);
  const correct = entries.filter(([, a]) => a.ok).length;
  const total = entries.length;
  const pct = total ? Math.round(100 * correct / total) : 0;

  const missed = entries.filter(([, a]) => !a.ok)
    .map(([id, a]) => ({ card: cardById(id), ans: a }))
    .filter((m) => m.card);

  const title = !total ? 'Τίποτα ακόμη'
              : pct === 100 ? 'Τέλεια!'
              : pct >= 80 ? 'Πολύ καλά'
              : pct >= 50 ? 'Καλή προσπάθεια'
              : 'Χρειάζεται επανάληψη';

  let html = `<div class="result-hero${pct === 100 && total ? ' perfect' : ''}">` +
    `<div class="ring-wrap">${progressRing(total ? pct : null, 152, 10)}` +
      `<div class="ring-label">` +
        (total ? `<b data-count="${pct}" data-suffix="%">0%</b>` : '<b>—</b>') +
        `<span>σωστά</span></div></div>` +
    `<h2 class="result-title">${title}</h2>` +
    `<p class="result-sub">${correct} από ${total} ερωτήσεις</p></div>`;

  if (missed.length) {
    html += `<p class="list-head">${missed.length === 1 ? 'Το λάθος' : 'Τα λάθη'}</p>`;
    html += '<ul class="miss-list">' + missed.map(({ card: c, ans: a }) => {
      const F = (t) => formatSci(t, c.autoFormat);
      const O = (v) => optionHTML(v, c.autoFormat);
      const head = `<div class="miss-id">${esc(c.subjectTitle)} · ${esc(c.exId)}` +
                   `${c.label ? ' · ' + esc(c.label) : ''}</div>`;

      if (c.matching) {
        const bad = c.pairs.filter((p) => !(a.detail || {})[p.label]);
        const lines = bad.map((p) => {
          const co = c.options.find((o) => o.label === p.correct);
          return `<li>${F(p.text)} → <b>${esc(p.correct)})</b> ${O(co.value)}</li>`;
        }).join('');
        return `<li>${head}<p class="miss-q">Αντιστοίχιση — ${a.score} από ${c.pairs.length} σωστές</p>` +
               `<ul class="miss-pairs">${lines}</ul></li>`;
      }

      const co = c.options.find((o) => o.label === c.correct);
      const ansTxt = c.twoUp
        ? (c.correct === 'true' ? 'Σωστό' : 'Λάθος')
        : esc(c.correct) + ') ' + O(co ? co.value : '');
      return `<li>${head}` +
             `<p class="miss-q">${F(c.stem)}</p>` +
             `<p class="miss-a">Σωστή απάντηση: ${ansTxt}</p></li>`;
    }).join('') + '</ul>';
  } else if (total) {
    html += '<p class="empty">Καμία λάθος απάντηση.</p>';
  } else {
    html += '<p class="empty">Δεν απαντήθηκε καμία ερώτηση.</p>';
  }

  $('results-body').innerHTML = html;
  animateStats($('results-body'), true);
  $('btn-practice-wrong').hidden = missed.length === 0;
  $('btn-practice-wrong').onclick = () => startSession(missed.map((m) => m.card), 'review');

  state.session = null;
  saveState();
  show('screen-results');
}

/* ── Missing texts ─────────────────────────────────────── */

function renderMissing() {
  const list = missingEntries(BANK);
  $('missing-body').innerHTML = list.length
    ? '<ul class="miss-list">' + list.map(({ subject, ch, q }) =>
        `<li><div class="miss-id">${esc(subject.title)} · ${esc(q.id)}</div>` +
        `<p class="miss-q">${esc(ch.title || ch.id)} · ${esc(TYPE_NAMES[q.type] || q.type)}</p>` +
        (q.note ? `<p class="miss-a">${esc(q.note)}</p>` : '') + '</li>').join('') + '</ul>'
    : '<p class="empty">Καμία — όλες οι ασκήσεις έχουν εκφώνηση.</p>';
  show('screen-missing');
}

/* ── Install (PWA) ─────────────────────────────────────── */

// Chromium fires beforeinstallprompt when the app is installable; the event is
// the only way to open the native dialog, so it gets stashed until the user taps.
let deferredPrompt = null;

function isStandalone() {
  return (window.matchMedia && (window.matchMedia('(display-mode: standalone)').matches ||
                                window.matchMedia('(display-mode: fullscreen)').matches)) ||
         window.navigator.standalone === true;
}

// iPadOS 13+ reports as MacIntel, so touch points are the reliable tell.
function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) ||
         (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function shouldShowInstall() {
  return !isStandalone() && !state.settings.installDismissed;
}

const SHARE_ICON =
  '<svg class="step-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<path d="M7 10H5v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9h-2"/>' +
  '<path d="M12 15V4"/><path d="M8.5 7.5 12 4l3.5 3.5"/></svg>';

const ADD_ICON =
  '<svg class="step-icon" viewBox="0 0 24 24" aria-hidden="true">' +
  '<rect x="4" y="4" width="16" height="16" rx="4"/>' +
  '<path d="M12 9v6M9 12h6"/></svg>';

function iosStepsHTML() {
  return '<p class="install-note">Στο iPhone και στο iPad η εγκατάσταση γίνεται από το Safari, ' +
         'σε δύο βήματα:</p>' +
         '<ol class="install-steps">' +
           '<li><span class="step-n">1</span>' +
             '<span class="step-txt">Πάτα το <b>Κοινή χρήση</b> στη μπάρα του Safari</span>' +
             SHARE_ICON + '</li>' +
           '<li><span class="step-n">2</span>' +
             '<span class="step-txt">Διάλεξε <b>«Πρόσθεση στην αρχική οθόνη»</b></span>' +
             ADD_ICON + '</li>' +
         '</ol>';
}

function genericHintHTML() {
  return '<p class="install-note">Άνοιξε το μενού του browser και διάλεξε ' +
         '<b>«Εγκατάσταση εφαρμογής»</b> ή <b>«Προσθήκη στην αρχική οθόνη»</b>.</p>';
}

function renderInstall() {
  const btn = $('btn-install');
  const help = $('install-help');
  if (deferredPrompt) {
    btn.hidden = false;
    help.innerHTML = '';
  } else {
    btn.hidden = true;
    help.innerHTML = isIOS() ? iosStepsHTML() : genericHintHTML();
  }
}

async function doInstall() {
  if (!deferredPrompt) return;
  const promptEvent = deferredPrompt;
  deferredPrompt = null;            // a captured prompt can only be used once
  promptEvent.prompt();
  let outcome = 'dismissed';
  try { outcome = (await promptEvent.userChoice).outcome; } catch (e) { /* ignore */ }
  if (outcome === 'accepted') {
    dismissInstall();
  } else {
    renderInstall();                // falls back to the browser-menu hint
  }
}

function dismissInstall() {
  state.settings.installDismissed = true;
  saveState();
  updateInstallLink();
  goHome(true);
}

function updateInstallLink() {
  const b = $('btn-install-again');
  if (b) b.hidden = isStandalone();
}

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!$('screen-install').hidden) renderInstall();
});

window.addEventListener('appinstalled', () => {
  deferredPrompt = null;
  if (!$('screen-install').hidden) dismissInstall();
  else { state.settings.installDismissed = true; saveState(); }
  updateInstallLink();
});

/* ── Wiring ────────────────────────────────────────────── */

function wire() {
  on('btn-start-subject', 'click', () => startSession(activePool({ subjectId: nav.subjectId }), 'practice'));
  on('btn-start-chapter', 'click', () => startSession(activePool({ chapterKey: nav.chapterKey }), 'practice'));

  on('btn-subject-back', 'click', () => goHome(true));
  on('btn-chapter-back', 'click', () => goSubject(nav.subjectId, true));

  on('btn-resume', 'click', () => { show('screen-quiz'); renderCard(); });
  on('btn-next', 'click', nextCard);
  on('btn-quit', 'click', showCurrentNav);
  on('btn-home', 'click', () => goHome(true));
  on('btn-missing', 'click', renderMissing);
  on('btn-install', 'click', doInstall);
  on('btn-skip-install', 'click', dismissInstall);
  on('btn-install-again', 'click', () => { renderInstall(); show('screen-install'); });
  on('btn-missing-back', 'click', showCurrentNav);

  // Remember whether the settings drawer was left open.
  on('sec-settings', 'toggle', () => {
    if (state.settings.openSections.settings === $('sec-settings').open) return;
    state.settings.openSections.settings = $('sec-settings').open;
    saveState();
  });

  for (const [id, key] of [['opt-shuffle', 'shuffle'], ['opt-only-wrong', 'onlyWrong'], ['opt-only-unseen', 'onlyUnseen']]) {
    on(id, 'change', (e) => {
      state.settings[key] = e.target.checked;
      saveState();
      renderHome();
    });
  }

  on('btn-reset', 'click', () => {
    if (!confirm('Να διαγραφεί όλη η πρόοδος;')) return;
    const keep = state.settings;
    state = defaultState();
    state.settings = keep;
    saveState();
    goHome(true);
  });
}

/* ── Boot ──────────────────────────────────────────────── */

function bootError(e) {
  $('boot-msg').innerHTML =
    '<strong>Δεν φορτώθηκε η τράπεζα ερωτήσεων.</strong>' +
    '<p>Η εφαρμογή χρειάζεται σέρβερ (το <code>file://</code> δεν επιτρέπει fetch). Από τον φάκελο της εφαρμογής:</p>' +
    '<pre>python3 -m http.server 8000</pre>' +
    '<p>και άνοιξε <code>http://localhost:8000</code></p>' +
    '<p style="opacity:.6">' + esc(e && e.message ? e.message : e) + '</p>';
}

async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(url + ' — HTTP ' + res.status);
  return res.json();
}

async function boot() {
  state = loadState();
  try {
    const index = await fetchJSON('data/index.json');
    if (!Array.isArray(index.subjects)) throw new Error('data/index.json: λείπει το subjects');

    const files = await Promise.all(index.subjects.map((e) => fetchJSON(e.file)));
    BANK = {
      subjects: index.subjects.map((e, i) => ({
        id: e.id,
        title: e.title || files[i].title || e.id,
        color: safeColor(e.color) || SUBJECT_COLORS[i % SUBJECT_COLORS.length],
        autoFormat: e.autoFormat || null,
        chapters: files[i].chapters || []
      }))
    };
  } catch (e) {
    return bootError(e);
  }

  CARDS = buildCards(BANK);
  TREE = buildTree(BANK, CARDS);
  if (freshState) migrateLegacy();

  $('boot').hidden = true;
  $('app').hidden = false;
  wire();
  updateInstallLink();
  renderHome(true);
  if (shouldShowInstall()) { renderInstall(); show('screen-install'); }
  else show('screen-home');

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

boot();
