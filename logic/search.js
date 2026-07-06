// search.js
//
// Smart fuzzy search over the exercise catalog. Exposes ONE global that app.js
// already calls synchronously from handleSearch():
//
//   searchExercises(query) -> string[]   // ranked exercise names, best first
//
// Classic <script> (NOT a module), same as log_store.js — that's why app.js
// can call searchExercises()/getLastLogs() bare without importing them.
//
// WHY AN IN-MEMORY INDEX:
//   handleSearch() calls searchExercises() synchronously on every keystroke,
//   but the catalog lives in exercises_info.json (async fetch). So we fetch
//   the catalog ONCE at load, build a searchable index, and every search runs
//   synchronously against that. Until the fetch resolves we fall back to the
//   exercises already logged in log_store.js so search isn't dead on first paint.
//
// WHAT MAKES IT "SMART":
//   1. Synonyms / abbreviations — a gym dictionary expands query terms
//      (db->dumbbell, ohp->overhead press, pecs->chest, rdl->romanian deadlift…)
//   2. Typo tolerance — Optimal String Alignment (Damerau-Levenshtein) distance,
//      so "bnech pres" still finds "Bench Press". Tolerance scales with word length.
//   3. Partial / loose matching — exact > prefix > substring > fuzzy, scored
//      against both the name tokens AND the category, with singular/plural leniency.
//   4. Dedup — collapses equivalent names ("DB Bench Press" == "Dumbbell Bench
//      Press") to ONE result, preferring the spelled-out name, so you don't log
//      the same exercise under two different names.
//
// Tune everything in SEARCH_CONFIG / SYNONYMS / CANONICAL_TOKENS below.

// add near the top, just under SEARCH_CONFIG:
const SEARCH_DEBUG = false; // flip to true for a per-keystroke scoring trace

const SEARCH_CONFIG = {
    DATA_URL: './Data/exercises_info.json', // same path exercise_list.js uses
    MAX_RESULTS: 25,
    MIN_SCORE: 30, // drop pure-noise fuzzy hits below this
  };
  
  // term -> list of expansion terms (all lowercase, single or multi word).
  // Keys are normalized single tokens; multi-word values are split automatically.
  const SYNONYMS = {
    // equipment
    db: ['dumbbell'], dbs: ['dumbbell'], dumbell: ['dumbbell'], dumbells: ['dumbbell'],
    bb: ['barbell'], barbel: ['barbell'],
    kb: ['kettlebell'],
    cbl: ['cable'], cbls: ['cable'],
    ez: ['ez bar'], smith: ['smith machine'], machine: ['machine'],
  
    // movement abbreviations
    ohp: ['overhead press'], mp: ['military press'],
    bp: ['bench press'],
    dl: ['deadlift'], rdl: ['romanian deadlift'], sldl: ['stiff leg deadlift'],
    bss: ['bulgarian split squat'],
    pullup: ['pull up'], pullups: ['pull up'], chinup: ['chin up'], chinups: ['chin up'],
    pulldown: ['lat pulldown'], pushdown: ['tricep pushdown'], pressdown: ['tricep pushdown'],
    flye: ['fly'], flyes: ['fly'], flies: ['fly'],
    ext: ['extension'], curls: ['curl'],
  
    // muscles / body parts -> anatomical term + likely category word(s)
    pecs: ['pec', 'chest'], pec: ['chest'], chest: ['chest'],
    lats: ['lat', 'back'], lat: ['back'], back: ['back'],
    delts: ['delt', 'shoulder'], delt: ['shoulder'], shoulders: ['shoulder'], shoulder: ['shoulder'],
    tris: ['tricep', 'arm'], tri: ['tricep'], triceps: ['tricep'], tricep: ['tricep', 'arm'],
    bis: ['bicep', 'arm'], bi: ['bicep'], biceps: ['bicep'], bicep: ['bicep', 'arm'],
    arms: ['arm', 'bicep', 'tricep'], arm: ['bicep', 'tricep'],
    quads: ['quad', 'leg', 'legs'], quad: ['leg', 'legs'],
    hams: ['hamstring', 'leg', 'legs'], hammies: ['hamstring', 'leg', 'legs'],
    hamstrings: ['hamstring', 'leg', 'legs'], hamstring: ['leg', 'legs'],
    glutes: ['glute'], glute: ['glute'], butt: ['glute'],
    legs: ['leg', 'legs'], leg: ['leg', 'legs'],
    calves: ['calf'], calf: ['calf'],
    abs: ['ab', 'core'], ab: ['core'], core: ['core'], obliques: ['oblique', 'core'],
    traps: ['trap'], trap: ['trap'], lower: ['lower'],
  };

  // Abbreviation / spelling variants that denote the SAME exercise written a
  // different way. Used ONLY to collapse duplicate results (e.g. "DB Curl" and
  // "Dumbbell Curl" -> one entry) — NOT for matching. Keep entries strictly
  // "identical exercise", equipment/movement only.
  const CANONICAL_TOKENS = {
    db: 'dumbbell', dbs: 'dumbbell', dumbell: 'dumbbell', dumbells: 'dumbbell',
    bb: 'barbell', barbel: 'barbell',
    kb: 'kettlebell',
    cbl: 'cable', cbls: 'cable',
    ohp: 'overhead press', mp: 'military press',
    rdl: 'romanian deadlift', sldl: 'stiff leg deadlift',
    bss: 'bulgarian split squat',
  };
  
  // --- text utils -------------------------------------------------------------
  
  function _norm(s) {
    return (s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip diacritics
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  
  function _tokenize(s) {
    const n = _norm(s);
    return n ? n.split(' ').filter(Boolean) : [];
  }

  // Group key: collapse a name's abbreviations so equivalents match.
  function _canonKey(name) {
    return _tokenize(name).map(t => CANONICAL_TOKENS[t] || t).join(' ');
  }

  // True if the name already uses full words (no abbreviation we'd expand).
  function _isCanonicalName(name) {
    return _tokenize(name).every(t => !(t in CANONICAL_TOKENS));
  }
  
  // Optimal String Alignment distance (Damerau-Levenshtein w/ adjacent
  // transpositions), bounded by `max` with early exit for speed.
  function _osa(a, b, max) {
    const al = a.length, bl = b.length;
    if (Math.abs(al - bl) > max) return max + 1;
    let prevPrev = new Array(bl + 1).fill(0);
    let prev = new Array(bl + 1);
    for (let j = 0; j <= bl; j++) prev[j] = j;
  
    for (let i = 1; i <= al; i++) {
      const curr = new Array(bl + 1);
      curr[0] = i;
      let rowMin = curr[0];
      for (let j = 1; j <= bl; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
          v = Math.min(v, prevPrev[j - 2] + 1); // transposition
        }
        curr[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1; // whole row already over budget
      prevPrev = prev;
      prev = curr;
    }
    return prev[bl] <= max ? prev[bl] : max + 1;
  }
  
  // --- index ------------------------------------------------------------------
  
  let _index = [];
  
  function _makeDoc(name, category) {
    const norm = _norm(name);
    const cat = _norm(category || '');
    return { name, norm, tokens: _tokenize(name), category: cat, blob: (norm + ' ' + cat).trim() };
  }
  
  function _loggedNames() {
    try {
      return typeof window.exportAllLogs === 'function' ? Object.keys(window.exportAllLogs()) : [];
    } catch { return []; }
  }
  
  // Fallback used before the catalog fetch resolves (or if it fails): at least
  // make every exercise you've already logged searchable. Category unknown.
  function _fallbackIndex() {
    return _loggedNames().map(n => _makeDoc(n, ''));
  }
  
  async function _loadIndex() {
    try {
      if (SEARCH_DEBUG) console.log('🔍 search.js: loading index from', SEARCH_CONFIG.DATA_URL);
      const res = await fetch(SEARCH_CONFIG.DATA_URL);
      if (SEARCH_DEBUG) console.log(`🔍 fetch → ${res.status} ${res.ok ? 'OK' : 'FAILED'}`);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const info = await res.json();
  
      const docs = Object.keys(info).map(name => _makeDoc(name, info[name] && info[name].category));
  
      const have = new Set(docs.map(d => d.name));
      _loggedNames().forEach(n => { if (!have.has(n)) docs.push(_makeDoc(n, '')); });
  
      _index = docs;
      console.log(`🔍 search.js: indexed ${_index.length} exercises`,
        SEARCH_DEBUG ? _index.map(d => d.name) : '');
    } catch (err) {
      console.warn('🔍 search.js: catalog load failed — using logged exercises only:', err);
      _index = _fallbackIndex();
      if (SEARCH_DEBUG) console.log(`🔍 fallback index: ${_index.length} exercises`, _index.map(d => d.name));
    }
  }
  // --- scoring ----------------------------------------------------------------
  
  function _expandTerms(tokens) {
    const out = new Set();
    for (const t of tokens) {
      out.add(t);
      const syn = SYNONYMS[t];
      if (syn) syn.forEach(phrase => _tokenize(phrase).forEach(w => out.add(w)));
      if (t.endsWith('s') && t.length > 3) out.add(t.slice(0, -1)); // crude singular
    }
    return [...out];
  }
  
  // How well one query term matches one target word (name token or category).
  function _termWordScore(term, word) {
    if (!term || !word) return 0;
    if (term === word) return 100;
    if (word.startsWith(term)) return 70;         // "ben" -> "bench"
    if (term.startsWith(word)) return 55;
    if (term.length >= 3 && word.includes(term)) return 45;
    if (word.length >= 3 && term.includes(word)) return 40;
  
    // singular/plural leniency
    const ts = term.replace(/s$/, ''), ws = word.replace(/s$/, '');
    if (ts.length > 2 && ts === ws) return 65;
  
    // fuzzy — only for terms long enough that a typo is plausible, not noise
    if (term.length >= 4) {
      const max = term.length <= 4 ? 1 : term.length <= 7 ? 2 : 3;
      const d = _osa(term, word, max);
      if (d <= max) return Math.max(0, 60 - d * 22); // d1->38, d2->16
    }
    return 0;
  }
  
  function _scoreDoc(qNorm, qTerms, doc) {
    let score = 0;
  
    // whole-query signals (strongest)
    if (doc.norm === qNorm) score += 1000;
    else if (doc.norm.startsWith(qNorm)) score += 400;
    else if (doc.blob.includes(qNorm)) score += 150;
  
    // per-term: best match against name tokens or (discounted) the category
    let matched = 0;
    for (const term of qTerms) {
      let best = 0;
      for (const tok of doc.tokens) best = Math.max(best, _termWordScore(term, tok));
      if (doc.category) best = Math.max(best, _termWordScore(term, doc.category) * 0.9);
      if (best > 0) matched++;
      score += best;
    }
  
    if (matched === 0) return 0;
    if (qTerms.length && matched === qTerms.length) score += 120;      // full coverage bonus
    if (qTerms.length > 1 && matched < qTerms.length) score *= matched / qTerms.length; // partial penalty
    return score;
  }
  
  // --- public API -------------------------------------------------------------
  
  function searchExercises(query) {
    const qNorm = _norm(query);
    if (SEARCH_DEBUG) console.group(`🔍 searchExercises("${query}") → norm="${qNorm}"`);
  
    if (!qNorm) {
      if (SEARCH_DEBUG) { console.log('empty query'); console.groupEnd(); }
      return [];
    }
  
    const docs = _index.length ? _index : _fallbackIndex();
    if (SEARCH_DEBUG) console.log(`index size: ${docs.length}${_index.length ? '' : ' (FALLBACK — main index empty!)'}`);
    if (!docs.length) {
      if (SEARCH_DEBUG) { console.warn('❌ no docs to search — index never loaded'); console.groupEnd(); }
      return [];
    }
  
    const qTerms = _expandTerms(_tokenize(query));
    if (SEARCH_DEBUG) console.log('expanded query terms:', qTerms);
  
    const scored = [];
    for (const doc of docs) {
      const s = _scoreDoc(qNorm, qTerms, doc);
      if (s >= SEARCH_CONFIG.MIN_SCORE) scored.push([s, doc.name]);
    }
  
    scored.sort((a, b) => b[0] - a[0] || a[1].localeCompare(b[1]));
  
    // Collapse equivalent names (e.g. "DB Bench Press" == "Dumbbell Bench Press").
    // Keep ONE per canonical key, preferring the spelled-out name, then score.
    const best = new Map(); // canonKey -> { name, score }
    for (const [s, name] of scored) {
      const key = _canonKey(name);
      const cur = best.get(key);
      if (!cur) { best.set(key, { name, score: s }); continue; }
      const curCanon = _isCanonicalName(cur.name);
      const newCanon = _isCanonicalName(name);
      if (newCanon !== curCanon) {
        if (newCanon) best.set(key, { name, score: s }); // prefer the spelled-out one
      } else if (s > cur.score) {
        best.set(key, { name, score: s });
      }
    }
    const deduped = [...best.values()]
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  
    if (SEARCH_DEBUG) {
      // show the top scorers even if below threshold, so you can see if it's a
      // MIN_SCORE problem vs a no-match-at-all problem
      const allScored = docs.map(d => [_scoreDoc(qNorm, qTerms, d), d.name])
        .sort((a, b) => b[0] - a[0]).slice(0, 8);
      console.log(`MIN_SCORE=${SEARCH_CONFIG.MIN_SCORE}. Top 8 by raw score:`,
        allScored.map(([s, n]) => `${n}:${s.toFixed(0)}`));
      console.log(`→ ${scored.length} passed threshold, ${deduped.length} after dedup:`,
        deduped.map(x => `${x.name}:${x.score.toFixed(0)}`));
      console.groupEnd();
    }
  
    return deduped.slice(0, SEARCH_CONFIG.MAX_RESULTS).map(x => x.name);
  }
  
  // Expose as globals (classic-script style, matches log_store.js).
  window.searchExercises = searchExercises;
  window.refreshSearchIndex = _loadIndex; // call after a sync if you want fresh catalog
  
  _loadIndex(); // build the index now