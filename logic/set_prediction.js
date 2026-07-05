// set_prediction.js
//
// get_next_set — RPE-anchored, phase-aware load & rep suggestion for BackTracker.
//
// Training logs come from Google Drive (see get_data.js) — not from a local
// *_logging.json mirror. Adjust the import path below to wherever get_data.js
// lives relative to this file.
//
// Input formats (matching Data/ layout):
//
//   exercises_info.json
//     "Hip Thrust": {
//       "category": "legs",
//       "rep_range": [6, 10],
//       "increase_steps": 2.5,
//       "percentage_increase": { "deload": 2, "build": 4, "intensify": 6, "peak": 10 }
//     }
//
//   current_program.json
//     {
//       "start_date": "2026-06-01",
//       "weeks": [
//         { "week": 1, "phase": "build" },
//         { "week": 2, "phase": "intensify" },
//         { "week": 3, "phase": "intensify" },
//         { "week": 4, "phase": "deload" }
//       ]
//     }
//
//   per-exercise log (as returned by get_next_set(<exercise_name>) in the old stub,
//   now passed in directly as `logs`):
//     [
//       {
//         id: "m3x8k2a1",
//         weight: 100,
//         reps: 5,
//         rpe: 2,
//         timestamp: "2026-06-22T18:42:11.203Z",
//         modified: "2026-06-22T18:42:11.203Z",
//         deleted: false
//       },
//       {
//         id: "m3x9p7q4",
//         weight: 102.5,
//         reps: 5,
//         rpe: 2,
//         timestamp: "2026-06-29T18:05:33.910Z",
//         modified: "2026-06-29T19:10:02.118Z",
//         deleted: false,
//         edited: true
//       }
//     ]
//
// Output: predicted next set, e.g.
//   { weight: 70, reps: 6, target_rpe: 7.5, phase: "build", e1rm: 88.4, applied_pct: 3.1,
//     delivered_rpe: 7.4 }
//
// How it decides (and what weighs most):
//   1. Every logged set -> estimated 1RM (e1RM) via RPE-adjusted Epley:
//        effective_reps_to_failure = reps + (10 - RPE)
//      This is the spine: it turns "what felt like X" into an absolute number, so a
//      depressed post-cut max self-reports honestly instead of being assumed.
//   2. Each session (calendar day) collapses to one indicator set (heaviest real
//      working set that day), killing warm-up / back-off noise.
//   3. Rolling e1RM = weighted mean over recent sessions, weight =
//        recency  (exponential decay, newest set dominates)   <- biggest factor
//      x reliability (e1RM is trustworthy at low reps / high RPE, noisy at high reps /
//        low RPE — Zourdos 2016; so an easy 12-rep set barely moves the number).
//   4. Phase (build/intensify/peak/deload) sets a target-rep CENTER (position in the
//      rep range) and a target RPE.
//   5. Baseline weight to hit (target_reps @ target_RPE) is derived from the rolling
//      e1RM with Epley inverted — self-consistent round-trip.
//   6. The phase's "percentage_increase" is an INTENSITY BUDGET, not a fixed jump.
//      Autoregulation decides how much of it to spend: a positive RPE gap last session
//      (it felt easier than target) and a rising e1RM trend spend more of the budget;
//      over-reaching or a downward trend spend less. The loop is self-correcting —
//      push too hard and next call's RPE is high, so it backs off. This scales the
//      rolling e1RM into an "effective" target e1RM (eEff).
//   7. Rep selection (NEW): instead of forcing the phase-center rep and then rounding
//      the weight (which smears the delivered RPE, badly on light/large-step lifts),
//      we search a small rep WINDOW around the phase center and pick the (reps, weight)
//      pair on the e1RM curve that lands closest to target RPE AFTER rounding to the
//      plate grid — staying near the center unless deviating buys back real accuracy.
//        - On heavy barbell lifts the rounding error is tiny (<~0.5 RPE), so they stay
//          glued to the phase reps. Correct: you don't juggle reps on the comp lifts.
//        - Strength lifts (rep-range floor <= STRENGTH_REP_FLOOR, i.e. squat/bench/
//          deadlift trained at singles/doubles/triples) are HARD-LOCKED to the center
//          rep — guaranteed never to wander for a rounding artifact.
//        - On accessory/machine work (wide, higher-rep ranges) it trades reps for load
//          to nail the RPE, e.g. "more reps, same plate" or "fewer reps, one plate up".
//   8. Round weight to the exercise's increment.
//
// Refs: Helms RPE for RT (2016/18); Zourdos RIR/RPE scale (2016); Israetel volume
// landmarks; Issurin block periodization; SRA fatigue model.
//
// Post-cut note: because step 1 reads RPE off real sets and step 3 is recency-heavy,
// this tracks neural recovery automatically — no manual 1RM re-test needed. Keep
// target_rpe honest during the first ~3-4 weeks and let the rolling e1RM climb on its own.

// --- tunables (Bas: these are the knobs) -----------------------------------
// rep_pos: 0.0 = bottom of rep range (heaviest), 1.0 = top of range (lightest)
const PHASE_PROFILE = {
  deload:    { rep_pos: 0.5, target_rpe: 5.5 },
  build:     { rep_pos: 1.0, target_rpe: 7.5 },
  intensify: { rep_pos: 0.5, target_rpe: 8.5 },
  peak:      { rep_pos: 0.0, target_rpe: 9.5 },
};
const RECENCY_DECAY  = 0.65;  // each older session counts 65% of the next-newer one
const MAX_SESSIONS   = 8;     // window of history considered
const RELIABILITY_K  = 0.08;  // how fast e1RM trust decays with effective reps
const TREND_SESSIONS = 3;     // window for short-term trend
const TREND_CAP      = 0.20;  // max trend influence on push fraction
const WEEK_LENGTH_DAYS = 7;   // how long each program week lasts

// --- rep-selection tunables (NEW) -------------------------------------------
// The phase gives a rep CENTER; these govern how far, and under what cost, the
// prediction is allowed to move off that center to fit the plate grid.
const REP_WINDOW          = 2;    // reps explored either side of the phase center (clamped to rep_range)
const CENTER_COST_PER_REP = 0.75; // RPE "charge" per rep away from the phase center — only deviate
                                  // if it buys back MORE than this in rounding error. Higher = stickier.
const REP_BIAS            = 0.0;  // 0 = pure block periodization (recommended for a powerlifter).
                                  // >0 = DUP-style nudge: strong days drift heavier/fewer, rough days
                                  // lighter/more. Leave at 0 unless you deliberately want undulation.
const STRENGTH_REP_FLOOR  = 3;    // lifts whose rep_range LOW is <= this (squat/bench/deadlift trained
                                  // at singles/doubles/triples) are HARD-LOCKED to the phase-center rep.

// --- data source --------------------------------------------------------
// Logs live in Drive, not in a local Data/*_logging.json file. Adjust this
// path to match your project layout (e.g. './get_data.js' or '../Data/get_data.js').
import { getExerciseLog } from '../helpers/get_data.js';

// --- core math --------------------------------------------------------------
function effReps(reps, rpe) {
  return reps + Math.max(0.0, 10.0 - rpe);
}

function e1rmOf(weight, reps, rpe) {
  return weight * (1.0 + effReps(reps, rpe) / 30.0);
}

function weightFor(e1rm, reps, rpe) {
  return e1rm / (1.0 + effReps(reps, rpe) / 30.0);
}

// Inverse of the above: what RPE does a concrete (weight, reps) represent for a
// given e1RM? Used to score how far a rounded prescription drifts from target RPE.
function rpeFor(e1rm, weight, reps) {
  return reps + 10.0 - 30.0 * (e1rm / weight - 1.0);
}

function reliabilityOf(reps, rpe) {
  return 1.0 / (1.0 + RELIABILITY_K * Math.max(0.0, effReps(reps, rpe) - 1.0));
}

// --- history shaping --------------------------------------------------------

// day key (UTC date portion) used to group sets into sessions
function dayKey(timestamp) {
  return timestamp.slice(0, 10); // "2026-06-22T18:42:11.203Z" -> "2026-06-22"
}

// One set per calendar day: heaviest, RPE as tie-break. Drops deleted logs.
// Returns sessions oldest -> newest, each { weight, reps, rpe, date }.
function indicatorSets(logs) {
  const byDate = {};
  for (const s of logs) {
    if (s.deleted) continue;
    const d = dayKey(s.timestamp);
    const rpe = s.rpe ?? 8;
    const cur = byDate[d];
    if (!cur || s.weight > cur.weight || (s.weight === cur.weight && rpe > cur.rpe)) {
      byDate[d] = { weight: s.weight, reps: s.reps, rpe, date: d };
    }
  }
  return Object.keys(byDate).sort().map(d => byDate[d]);
}

function rollingE1rm(sessions) {
  const recent = sessions.slice(-MAX_SESSIONS);
  const n = recent.length;
  let num = 0.0, den = 0.0;
  recent.forEach((s, i) => {
    const age = (n - 1) - i; // newest -> 0
    const w = Math.pow(RECENCY_DECAY, age) * reliabilityOf(s.reps, s.rpe);
    num += w * e1rmOf(s.weight, s.reps, s.rpe);
    den += w;
  });
  return den ? num / den : null;
}

function trendOf(sessions) {
  const pts = sessions.slice(-TREND_SESSIONS);
  if (pts.length < 2) return 0.0;
  const first = e1rmOf(pts[0].weight, pts[0].reps, pts[0].rpe);
  const last = e1rmOf(pts[pts.length - 1].weight, pts[pts.length - 1].reps, pts[pts.length - 1].rpe);
  return first ? (last - first) / first : 0.0;
}

function pushFraction(targetRpe, lastSession, trend) {
  const rpeGap = targetRpe - (lastSession.rpe ?? targetRpe); // +ve => room to push
  const frac = 0.5 + 0.25 * rpeGap + Math.max(-TREND_CAP, Math.min(TREND_CAP, trend * 4));
  return Math.max(0.0, Math.min(1.0, frac));
}

// --- rep + weight selection (NEW) -------------------------------------------

// Given the push-adjusted target e1RM (eEff), search a rep window around the
// phase center and pick the (reps, weight) pair that best balances:
//   - grid fit:   how close the *rounded* load lands to target RPE (in RPE points)
//   - phase intent: staying near the phase's rep center (CENTER_COST_PER_REP / rep)
//   - autoregulation bias (optional; REP_BIAS, off by default)
// repWindow is passed in so the caller can collapse it to 0 for locked strength lifts.
function chooseRepAndWeight(eEff, center, low, high, targetRpe, step, push, repWindow) {
  const lo = Math.max(low, center - repWindow);
  const hi = Math.min(high, center + repWindow);

  let best = null;
  for (let k = lo; k <= hi; k++) {
    const w = Math.round(weightFor(eEff, k, targetRpe) / step) * step;
    if (w <= 0) continue;

    const gridCost   = Math.abs(rpeFor(eEff, w, k) - targetRpe);   // RPE lost to rounding
    const centerCost = CENTER_COST_PER_REP * Math.abs(k - center); // cost of leaving phase intent
    const biasCost   = REP_BIAS * (k - center) * (push - 0.5);     // >0 => fewer reps on strong days
    const cost = gridCost + centerCost + biasCost;

    if (!best || cost < best.cost) {
      best = { reps: k, weight: w, cost, delivered_rpe: Math.round(rpeFor(eEff, w, k) * 10) / 10 };
    }
  }
  return best;
}

// --- program week resolution -------------------------------------------------

// Derives the current program week number by extrapolating from the program's
// start_date out to today: how many whole weeks have elapsed since start_date,
// then wrapping (looping) through the defined weeks so the program repeats
// indefinitely (e.g. a 4-week block restarts at week 1 again in week 5).
// matching current_program.json's { start_date, weeks: [{week, phase}, ...] } shape.
function currentWeekFromProgram(currentProgram, now = new Date()) {
  const start = new Date(currentProgram.start_date + 'T00:00:00Z');
  const diffDays = Math.floor((now - start) / (1000 * 60 * 60 * 24));
  const weeks = currentProgram.weeks;

  // elapsedWeeks: 0 during the start week, 1 once a week has passed, etc.
  // If today is before start_date, treat it as the first week of the program.
  const elapsedWeeks = Math.max(0, Math.floor(diffDays / WEEK_LENGTH_DAYS));
  const index = elapsedWeeks % weeks.length; // loop the program block
  return weeks[index].week;
}

// --- main -------------------------------------------------------------------

/**
 * @param {string} currentExercise - exercise name, e.g. "Hip Thrust"
 * @param {object} exerciseInfo - exercises_info.json entry for this exercise:
 *   { category, rep_range: [low, high], increase_steps, percentage_increase: {deload, build, intensify, peak} }
 * @param {object} currentProgram - current_program.json: { start_date, weeks: [{week, phase}, ...] }
 * @param {Array} logs - this exercise's raw log entries:
 *   [{ id, weight, reps, rpe, timestamp, modified, deleted, edited }, ...]
 * @param {number} [currentWeek] - optional override; if omitted, derived from
 *   currentProgram.start_date and today's date
 * @returns {{weight: number|null, reps: number, target_rpe: number, phase: string,
 *            e1rm?: number, applied_pct?: number, delivered_rpe?: number, note?: string}}
 */
function getNextSet(currentExercise, exerciseInfo, currentProgram, logs, currentWeek) {
  const [low, high] = exerciseInfo.rep_range;
  const step = exerciseInfo.increase_steps;

  const week = currentWeek ?? currentWeekFromProgram(currentProgram);
  const weekEntry = currentProgram.weeks.find(w => w.week === week);
  const phase = weekEntry ? weekEntry.phase : currentProgram.weeks[currentProgram.weeks.length - 1].phase;
  const profile = PHASE_PROFILE[phase];

  // Phase gives the rep CENTER and target RPE. Reps may move around this center
  // (see chooseRepAndWeight) unless the lift is a locked strength lift.
  const centerReps = Math.round(low + profile.rep_pos * (high - low));
  const targetRpe = profile.target_rpe;

  const sessions = indicatorSets(logs);
  if (!sessions.length) {
    return {
      weight: null,
      reps: centerReps,
      target_rpe: targetRpe,
      phase,
      note: 'No history — log a calibration top set first.',
    };
  }

  const rolling = rollingE1rm(sessions);
  const budget = exerciseInfo.percentage_increase[phase] / 100.0;
  const push = pushFraction(targetRpe, sessions[sessions.length - 1], trendOf(sessions));

  // eEff = the e1RM we're actually aiming the working set to express, after
  // spending some of the phase's intensity budget via autoregulation.
  const eEff = rolling * (1.0 + budget * push);

  // Strength lifts (heavy singles/doubles/triples) stay rep-locked; everything
  // else may trade reps for a cleaner RPE on the plate grid.
  const repWindow = low <= STRENGTH_REP_FLOOR ? 0 : REP_WINDOW;
  const pick = chooseRepAndWeight(eEff, centerReps, low, high, targetRpe, step, push, repWindow);

  return {
    weight: pick.weight,
    reps: pick.reps,
    target_rpe: targetRpe,
    phase,
    e1rm: Math.round(rolling * 10) / 10,
    applied_pct: Math.round(budget * push * 1000) / 10,
    delivered_rpe: pick.delivered_rpe, // ~RPE the rounded set actually asks for; nice to surface in UI
  };
}

// --- thin loader ------------------------------------------------------------
// exercises_info.json and current_program.json are static config and still
// come from the Data/ folder. The actual training logs come from Drive via
// get_data.js's getExerciseLog(), not from a local *_logging.json file — that
// was the bug: predictions were silently running on stale/local data instead
// of whatever the OAuth flow had just synced from Drive.
//
// (app.js's getExerciseSet(name) can be implemented as a thin wrapper around this)
async function getNextSetFromFiles(currentExercise, dataDir = './Data', currentWeek) {
  const [infoBlob, program] = await Promise.all([
    fetch(`${dataDir}/exercises_info.json`).then(r => r.json()),
    fetch(`${dataDir}/current_program.json`).then(r => r.json()),
  ]);
  const info = infoBlob[currentExercise];

  // Pull logs straight from Drive (get_data.js). getExerciseLog() returns
  // null if the OAuth token exchange / drive fetch hasn't resolved yet.
  const logs = getExerciseLog(currentExercise);
  if (logs === null) {
    return {
      weight: null,
      reps: null,
      target_rpe: null,
      phase: null,
      note: 'Drive data not loaded yet — wait for the consent popup to finish, then try again.',
    };
  }

  return getNextSet(currentExercise, info, program, logs, currentWeek);
}

// --- app.js-facing wrapper ---------------------------------------------------
// app.js calls: getExerciseSet(name).then(predicted => ...)
// This is the thin wrapper getExerciseSet should actually be — it just calls
// getNextSetFromFiles and normalizes a missing/failed lookup to a safe default
// so fillPrediction() in app.js never has to special-case errors.
async function getExerciseSet(name, dataDir = './Data') {
  try {
    return await getNextSetFromFiles(name, dataDir);
  } catch (err) {
    console.error('getExerciseSet failed for', name, err);
    return { weight: null, reps: null, target_rpe: null, phase: null, note: null };
  }
}

export { getNextSet, getNextSetFromFiles, getExerciseSet, currentWeekFromProgram };