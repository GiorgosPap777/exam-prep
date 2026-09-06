/* Χημεία Quiz — offline practice app. No dependencies. */
'use strict';

const STORAGE_KEY = 'chemquiz.v1';
const GREEK_SEQ = ['α','β','γ','δ','ε','στ','ζ','η','θ','ι','κ','λ'];
const ROMAN_SEQ = ['i','ii','iii','iv','v','vi','vii','viii','ix','x'];
const TYPE_NAMES = {
  single_choice_set: 'Πολλαπλής επιλογής',
  true_false_set: 'Σωστό / Λάθος',
  matching: 'Αντιστοίχιση'
};

let BANK = null;
let CARDS = [];
let state = null;

/* ── Storage ───────────────────────────────────────────── */

function defaultState() {
  return {
    settings: { chapters: null, exercises: null, types: null,
                shuffle: true, onlyWrong: false, onlyUnseen: false,
                installDismissed: false,
                openSections: { filters: false, settings: false } },
    stats: {},      // cardId -> { seen, correct, wrong, last }
    session: null   // { ids, i, answers, mode }
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    const merged = Object.assign(defaultState(), parsed);
    // Settings gained keys over time — merge rather than replace wholesale.
    merged.settings = Object.assign(defaultState().settings, parsed.settings || {});
    merged.settings.openSections = Object.assign(
      { filters: false, settings: false }, (parsed.settings || {}).openSections || {});
    return merged;
  } catch (e) {
    return defaultState();
  }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* full or blocked */ }
}

/* ── Chemistry formatting ──────────────────────────────── */

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Renders CO2 -> CO₂, [Cu(NH3)4]2+ -> [Cu(NH₃)₄]²⁺, Mr -> M_r, H2O(s) -> H₂O₍s₎.
// Only fires on Latin-script runs, so Greek prose passes through untouched.
function formatChem(text) {
  let s = esc(text);
  s = s.replace(/\](\d*)([+−-])/g, ']<sup>$1$2</sup>');           // ]2+
  s = s.replace(/([A-Za-z])(\d+)([+−])/g, '$1<sup>$2$3</sup>');   // Fe2+
  s = s.replace(/([A-Za-z)\]])(\d+)/g, '$1<sub>$2</sub>');             // CO2, (CH3)4
  s = s.replace(/\bMr\b/g, 'M<sub>r</sub>');
  s = s.replace(/\s?\((aq|s|g|l|ℓ)\)/g, '<sub>($1)</sub>');       // H2O(s)
  return s;
}

function lewisHTML(spec) {
  const dot = (n) => n > 0 ? '<span class="dots">' + '•'.repeat(n) + '</span>' : '<span></span>';
  return '<span class="lewis">' +
    '<span></span>' + dot(spec.top) + '<span></span>' +
    dot(spec.left) + '<span class="sym">' + esc(spec.symbol) + '</span>' + dot(spec.right) +
    '<span></span>' + dot(spec.bottom) + '<span></span>' +
    '</span>';
}

function optionHTML(value) {
  if (value && typeof value === 'object' && value.lewis) return lewisHTML(value.lewis);
  return formatChem(value);
}

function optionPlain(value) {
  if (value && typeof value === 'object' && value.lewis) {
    return 'το ' + value.lewis.symbol;
  }
  return String(value);
}

function sortLabels(labels) {
  const seq = labels.every((l) => ROMAN_SEQ.includes(l)) ? ROMAN_SEQ
            : labels.every((l) => GREEK_SEQ.includes(l)) ? GREEK_SEQ
            : null;
  if (!seq) return labels.slice(); // e.g. Α1..Α6 — keep author order
  return labels.slice().sort((a, b) => seq.indexOf(a) - seq.indexOf(b));
}

/* ── Progress rings & counters ─────────────────────────── */

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

// Circular progress ring; pct === null renders an empty ring.
function progressRing(pct, size, stroke) {
  const r = 50 - stroke / 2;
  const circ = 2 * Math.PI * r;
  const target = circ * (1 - (pct || 0) / 100);
  return `<svg class="ring" viewBox="0 0 100 100" width="${size}" height="${size}" aria-hidden="true">` +
    `<circle class="ring-track" cx="50" cy="50" r="${r}" stroke-width="${stroke}"/>` +
    `<circle class="ring-bar" cx="50" cy="50" r="${r}" stroke-width="${stroke}" ` +
    `stroke-dasharray="${circ.toFixed(2)}" style="stroke-dashoffset:${circ.toFixed(2)}" ` +
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
  for (const ch of bank.chapters) {
    for (const q of ch.questions) {
      const base = {
        chapterId: ch.id, chapterTitle: ch.title, exId: q.id,
        section: q.section || null, type: q.type,
        instructions: q.instructions || ''
      };
      if (q.needs_question_text) continue;

      if (q.type === 'single_choice_set') {
        for (const it of q.items || []) {
          if (!it.stem || !it.options) continue;
          out.push(Object.assign({}, base, {
            id: q.id + ':' + it.label,
            label: it.label,
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
            id: q.id + ':' + it.label,
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
          id: q.id,
          label: null,
          matching: true,
          pairs,
          options: q.right.map((r) => ({ label: r.label, value: r.text }))
        }));
      }
    }
  }
  return out;
}

function missingEntries(bank) {
  const out = [];
  for (const ch of bank.chapters) {
    for (const q of ch.questions) {
      if (q.needs_question_text) out.push({ ch, q });
    }
  }
  return out;
}

/* ── Filtering ─────────────────────────────────────────── */

function activePool() {
  const s = state.settings;
  return CARDS.filter((c) => {
    if (s.chapters && !s.chapters.includes(c.chapterId)) return false;
    if (s.exercises && !s.exercises.includes(c.exId)) return false;
    if (s.types && !s.types.includes(c.type)) return false;
    const st = state.stats[c.id];
    if (s.onlyWrong && !(st && st.last === 'wrong')) return false;
    if (s.onlyUnseen && st && st.seen) return false;
    return true;
  });
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

/* ── Home ──────────────────────────────────────────────── */

function renderChips(container, values, selected, labelFn, onToggle) {
  container.innerHTML = '';
  for (const v of values) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.setAttribute('aria-pressed', String(!selected || selected.includes(v)));
    b.innerHTML = labelFn(v);
    b.addEventListener('click', () => onToggle(v));
    container.appendChild(b);
  }
}

function renderHome(animate) {
  const s = state.settings;
  const chapters = BANK.chapters.map((c) => c.id);
  const exercises = [];
  for (const ch of BANK.chapters) {
    for (const q of ch.questions) if (!q.needs_question_text) exercises.push(q.id);
  }
  const types = [...new Set(CARDS.map((c) => c.type))];

  const toggle = (key, all, v) => {
    const cur = s[key] ? s[key].slice() : all.slice();
    const i = cur.indexOf(v);
    if (i >= 0) cur.splice(i, 1); else cur.push(v);
    s[key] = (cur.length === all.length) ? null : cur;
    if (cur.length === 0) s[key] = [];
    saveState(); renderHome();
  };

  const chTitle = (id) => {
    const ch = BANK.chapters.find((c) => c.id === id);
    return esc(ch ? ch.title : id);
  };

  renderChips($('filter-chapters'), chapters, s.chapters, chTitle, (v) => toggle('chapters', chapters, v));
  renderChips($('filter-exercises'), exercises, s.exercises, esc, (v) => toggle('exercises', exercises, v));
  renderChips($('filter-types'), types, s.types, (t) => esc(TYPE_NAMES[t] || t), (v) => toggle('types', types, v));

  $('opt-shuffle').checked = s.shuffle;
  $('opt-only-wrong').checked = s.onlyWrong;
  $('opt-only-unseen').checked = s.onlyUnseen;

  // Overall stats
  const known = new Set(CARDS.map((c) => c.id));
  const ids = Object.keys(state.stats).filter((i) => known.has(i));
  const answered = ids.filter((i) => state.stats[i].seen > 0).length;
  const totalCorrect = ids.reduce((n, i) => n + (state.stats[i].correct || 0), 0);
  const totalTries = ids.reduce((n, i) => n + (state.stats[i].correct || 0) + (state.stats[i].wrong || 0), 0);
  const pct = totalTries ? Math.round(100 * totalCorrect / totalTries) : null;
  const wrongNow = ids.filter((i) => state.stats[i].last === 'wrong').length;

  $('home-stats').innerHTML =
    `<div class="ring-wrap">${progressRing(pct, 112, 9)}` +
      `<div class="ring-label">` +
        (pct === null ? '<b>—</b>' : `<b data-count="${pct}" data-suffix="%">0%</b>`) +
        `<span>επιτυχία</span></div></div>` +
    `<div class="hero-stats">` +
      `<div class="hero-stat"><b>${answered}</b><span>από ${CARDS.length} απαντημένες</span></div>` +
      `<div class="hero-stat${wrongNow ? ' flag' : ''}"><b>${wrongNow}</b><span>για επανάληψη</span></div>` +
    `</div>`;
  animateStats($('home-stats'), animate);

  // Section summaries, so the collapsed state still says what is selected.
  const nCh = s.chapters ? s.chapters.length : chapters.length;
  const nEx = s.exercises ? s.exercises.length : exercises.length;
  const nTy = s.types ? s.types.length : types.length;
  const bits = [];
  if (nCh !== chapters.length) bits.push(`${nCh} από ${chapters.length} κεφάλαια`);
  bits.push(nEx === exercises.length ? 'όλες οι ασκήσεις'
           : nEx === 1 ? '1 άσκηση' : `${nEx} ασκήσεις`);
  if (nTy !== types.length) bits.push(nTy === 1 ? '1 τύπος' : `${nTy} τύποι`);
  $('sum-filters').textContent = bits.join(' · ');

  const on = [];
  if (s.shuffle) on.push('Τυχαία σειρά');
  if (s.onlyWrong) on.push('Μόνο λάθη');
  if (s.onlyUnseen) on.push('Μόνο αναπάντητες');
  $('sum-settings').textContent = on.length ? on.join(' · ') : 'Καμία';

  $('sec-filters').open = !!s.openSections.filters;
  $('sec-settings').open = !!s.openSections.settings;

  const pool = activePool();
  $('pool-count').textContent = pool.length
    ? `${pool.length} ${pool.length === 1 ? 'ερώτηση' : 'ερωτήσεις'} στην επιλογή`
    : 'Καμία ερώτηση με αυτά τα φίλτρα';
  $('btn-start').disabled = pool.length === 0;

  const canResume = state.session && state.session.i < state.session.ids.length;
  $('btn-resume').hidden = !canResume;
  if (canResume) {
    $('btn-resume').textContent = `Συνέχεια (${state.session.i}/${state.session.ids.length})`;
  }

  const missing = missingEntries(BANK).length;
  $('btn-missing').textContent = missing ? `Λείπουν κείμενα (${missing})` : 'Λείπουν κείμενα';

  const allEx = !s.exercises || s.exercises.length === exercises.length;
  $('btn-toggle-all-ex').textContent = allEx ? 'Καμία' : 'Επιλογή όλων';
  $('btn-toggle-all-ex').onclick = () => {
    s.exercises = allEx ? [] : null;
    saveState(); renderHome();
  };
}

/* ── Quiz ──────────────────────────────────────────────── */

function startSession(cards, mode) {
  const list = state.settings.shuffle ? shuffled(cards) : cards;
  state.session = { ids: list.map((c) => c.id), i: 0, answers: {}, mode: mode || 'practice' };
  saveState();
  show('screen-quiz');
  renderCard();
}

function cardById(id) { return CARDS.find((c) => c.id === id); }

function renderCard() {
  const sess = state.session;
  if (!sess || sess.i >= sess.ids.length) return renderResults();

  const card = cardById(sess.ids[sess.i]);
  if (!card) { sess.i++; return renderCard(); }

  const answeredCount = Object.keys(sess.answers).length;
  const correctCount = Object.values(sess.answers).filter((a) => a.ok).length;
  $('progress-fill').style.width = (100 * sess.i / sess.ids.length) + '%';
  $('score').textContent = `${correctCount}/${answeredCount}`;

  const badge = `<span class="badge">${esc(card.exId)}${card.label ? ' · ' + esc(card.label) : ''}</span>` +
    (card.section ? `<span class="badge section-tag">${esc(card.section)}</span>` : '');

  const instr = card.instructions ? `<p class="instructions">${formatChem(card.instructions)}</p>` : '';

  if (card.matching) return renderMatchCard(card, badge, instr);

  let stemHTML;
  if (card.twoUp) {
    stemHTML = `<p class="stem"><span class="sub-label">${esc(card.label)})</span>${formatChem(card.stem)}</p>`;
  } else {
    stemHTML = `<p class="stem">${formatChem(card.stem)}</p>`;
  }

  const optClass = card.twoUp ? 'options two-up' : 'options';
  const opts = card.options.map((o, i) =>
    `<button class="option" type="button" style="--i:${i}" data-label="${esc(o.label)}">` +
    `<span class="opt-label">${card.twoUp ? '' : esc(o.label) + ')'}</span>` +
    `<span class="opt-text">${optionHTML(o.value)}</span>` +
    `<span class="mark"></span></button>`
  ).join('');

  $('card-wrap').innerHTML = badge + instr + stemHTML +
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
  const rows = card.pairs.map((p, i) =>
    `<button class="mrow" type="button" style="--i:${i}" data-left="${esc(p.label)}">` +
      `<span class="mrow-main">` +
        `<span class="mrow-label">${esc(p.label)})</span>` +
        `<span class="mrow-text">${formatChem(p.text)}</span>` +
        `<span class="mrow-slot"></span>` +
      `</span>` +
      `<span class="mrow-extra"></span>` +
    `</button>`).join('');

  const pool = card.options.map((o, i) =>
    `<button class="mopt" type="button" style="--i:${i}" data-right="${esc(o.label)}">` +
      `<span class="mopt-label">${esc(o.label)})</span>` +
      `<span class="mopt-text">${optionHTML(o.value)}</span>` +
    `</button>`).join('');

  $('card-wrap').innerHTML = badge + instr +
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
        slot.innerHTML = `<span class="slot-label">${esc(assigned)})</span> ${optionHTML(o.value)}`;
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
      (given ? `<span class="slot-label">${esc(given)})</span> ${optionHTML(givenOpt.value)} ` : '') +
      `<span class="slot-mark">${good ? '✓' : '✕'}</span>`;

    const rightOpt = card.options.find((o) => o.label === p.correct);
    row.querySelector('.mrow-extra').innerHTML =
      (good ? '' : `<span class="mrow-correct">Σωστό: <b>${esc(p.correct)})</b> ${optionHTML(rightOpt.value)}</span>`) +
      (p.explanation ? `<span class="mrow-why">${formatChem(p.explanation)}</span>` : '');
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
    answerLine = `Σωστή απάντηση: <b>${esc(card.correct)})</b> ${optionHTML(correctOpt ? correctOpt.value : '')}`;
  }

  $('feedback').innerHTML =
    `<div class="feedback ${ok ? 'ok' : 'bad'}">` +
    `<div class="fb-head"><span class="fb-icon">${ok ? '✓' : '✕'}</span>` +
    `<h3>${ok ? 'Σωστά' : 'Λάθος'}</h3></div>` +
    (ok ? '' : `<p>${answerLine}</p>`) +
    (card.explanation ? `<p class="why"><b>Αιτιολόγηση:</b> ${formatChem(card.explanation)}</p>` : '') +
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
      const head = `<div class="miss-id">${esc(c.exId)}${c.label ? ' · ' + esc(c.label) : ''}</div>`;

      if (c.matching) {
        const bad = c.pairs.filter((p) => !(a.detail || {})[p.label]);
        const lines = bad.map((p) => {
          const co = c.options.find((o) => o.label === p.correct);
          return `<li>${formatChem(p.text)} → <b>${esc(p.correct)})</b> ${optionHTML(co.value)}</li>`;
        }).join('');
        return `<li>${head}<p class="miss-q">Αντιστοίχιση — ${a.score} από ${c.pairs.length} σωστές</p>` +
               `<ul class="miss-pairs">${lines}</ul></li>`;
      }

      const co = c.options.find((o) => o.label === c.correct);
      const ansTxt = c.twoUp
        ? (c.correct === 'true' ? 'Σωστό' : 'Λάθος')
        : esc(c.correct) + ') ' + optionHTML(co ? co.value : '');
      return `<li>${head}` +
             `<p class="miss-q">${formatChem(c.stem)}</p>` +
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
    ? '<ul class="miss-list">' + list.map(({ ch, q }) =>
        `<li><div class="miss-id">${esc(q.id)}</div>` +
        `<p class="miss-q">${esc(ch.title)} · ${esc(TYPE_NAMES[q.type] || q.type)}</p>` +
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
  renderHome(true);
  show('screen-home');
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
  on('btn-start', 'click', () => {
    const pool = activePool();
    if (pool.length) startSession(pool, 'practice');
  });
  on('btn-resume', 'click', () => { show('screen-quiz'); renderCard(); });
  on('btn-next', 'click', nextCard);
  on('btn-quit', 'click', () => { renderHome(true); show('screen-home'); });
  on('btn-home', 'click', () => { renderHome(true); show('screen-home'); });
  on('btn-missing', 'click', renderMissing);
  on('btn-install', 'click', doInstall);
  on('btn-skip-install', 'click', dismissInstall);
  on('btn-install-again', 'click', () => { renderInstall(); show('screen-install'); });
  on('btn-missing-back', 'click', () => { renderHome(true); show('screen-home'); });

  // Remember which sections the user left open.
  for (const [id, key] of [['sec-filters', 'filters'], ['sec-settings', 'settings']]) {
    on(id, 'toggle', () => {
      if (state.settings.openSections[key] === $(id).open) return;
      state.settings.openSections[key] = $(id).open;
      saveState();
    });
  }

  for (const [id, key] of [['opt-shuffle', 'shuffle'], ['opt-only-wrong', 'onlyWrong'], ['opt-only-unseen', 'onlyUnseen']]) {
    on(id, 'change', (e) => {
      state.settings[key] = e.target.checked;
      saveState(); renderHome();
    });
  }

  on('btn-reset', 'click', () => {
    if (!confirm('Να διαγραφεί όλη η πρόοδος;')) return;
    const keep = state.settings;
    state = defaultState();
    state.settings = keep;
    saveState(); renderHome(true);
  });
}

/* ── Boot ──────────────────────────────────────────────── */

function bootError(e) {
  $('boot-msg').innerHTML =
    '<strong>Δεν φορτώθηκε το questions.json.</strong>' +
    '<p>Η εφαρμογή χρειάζεται σέρβερ (το <code>file://</code> δεν επιτρέπει fetch). Από τον φάκελο της εφαρμογής:</p>' +
    '<pre>python3 -m http.server 8000</pre>' +
    '<p>και άνοιξε <code>http://localhost:8000</code></p>' +
    '<p style="opacity:.6">' + esc(e && e.message ? e.message : e) + '</p>';
}

async function boot() {
  state = loadState();
  try {
    const res = await fetch('questions.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.json();
    // Accept both the wrapped shape and a bare single-chapter object.
    BANK = raw.chapters ? raw : { version: 1, chapters: [Object.assign({ id: '1' }, raw, { title: raw.chapter || 'Κεφάλαιο' })] };
  } catch (e) {
    return bootError(e);
  }

  CARDS = buildCards(BANK);
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
