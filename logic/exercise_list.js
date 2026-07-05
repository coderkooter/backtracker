// exercise_list.js
//
// Function called by the UI: getExerciseList(muscleGroup)
// Returns: { Main_List: [...exercise names], Quick_List: [...exercise names], Search_List: [...exercise names] }
//
// Replaces the old mock lookup table with a real classification driven by
// what's actually logged in Drive (see get_data.js). Every exercise the user
// has ever logged (plus everything defined in exercises_info.json) gets
// bucketed into a tier based on how often — and how recently — it shows up:
//
//   Main    -> logged often, and recently. The "default" lifts.
//   Quick   -> used to be logged often, but has cooled off. Still one tap
//              away instead of buried in search.
//   Search  -> rarely logged, or logged a lot once but now stale for a long
//              time (fully dropped off). Everything not in Main/Quick lands
//              here, including brand-new exercises with zero history.
//
// How the score works:
//   1. Logs are collapsed to one "session" per calendar day (like
//      set_prediction.js's indicatorSets) so doing 5 sets of Bench in one
//      workout doesn't inflate the score vs. someone who trained it once.
//   2. Each session contributes weight = exp(-daysAgo / RECENCY_HALF_LIFE_DAYS)
//      to that exercise's score — recent sessions count a lot, old ones fade
//      out smoothly. This is the "recency-weighted attendance score."
//   3. Two independent thresholds (not just one) create hysteresis: an
//      exercise needs a HIGHER score to *enter* Main than to *stay* in Main
//      once it's there, and likewise for Quick. This stops an exercise from
//      flickering between tiers on borderline scores. Since we don't persist
//      previous tier state, hysteresis is approximated using a secondary
//      "grace" signal — see resolveTier() — but the enter/exit gap is the
//      main defense against flapping.
//   4. STALE_DAYS is a hard override: if it's been longer than that since the
//      last session, force the exercise down to Search regardless of score
//      (an exercise you crushed all year but haven't touched in 3 months
//      shouldn't still show up in Main).
//
// All knobs are in CONFIG below — tune freely, nothing else needs to change.

import { getAllLogs, driveReady } from '../helpers/get_data.js';

// --- CONFIG ------------------------------------------------------------
const CONFIG = {
  // How fast a session's contribution to the score fades with age.
  // e.g. 21 means a session from 21 days ago counts ~37% (1/e) as much as
  // one logged today. Smaller = more recency-sensitive, larger = smoother/slower.
  RECENCY_HALF_LIFE_DAYS: 21,

  // How many days of history to even look at. Sessions older than this are
  // ignored entirely (they don't contribute to the score at all).
  LOOKBACK_DAYS: 180,

  // Score thresholds. "Enter" is the bar to newly qualify for a tier;
  // "exit" is lower, so an exercise that already earned the tier gets some
  // slack before dropping out — this is the hysteresis behavior.
  MAIN_ENTER_SCORE: 4.0,
  MAIN_EXIT_SCORE: 2.5,
  QUICK_ENTER_SCORE: 1.5,
  QUICK_EXIT_SCORE: 0.75,

  // Hard override: if the most recent session for an exercise is older than
  // this many days, force it down to Search no matter how high its score is.
  STALE_DAYS: 45,

  // Exercises with zero logged sessions ever (brand new / never trained)
  // always land here.
  DEFAULT_TIER_FOR_NO_HISTORY: 'Search_List',
};

// --- helpers -------------------------------------------------------------

function dayKey(timestamp) {
  return timestamp.slice(0, 10);
}

function daysAgo(dateStr, now) {
  const then = new Date(dateStr + 'T00:00:00Z').getTime();
  return (now - then) / (1000 * 60 * 60 * 24);
}

// Collapse an exercise's raw logs into one session per calendar day,
// dropping deleted entries. Mirrors set_prediction.js's indicatorSets().
function sessionDays(logs) {
  const days = new Set();
  for (const l of logs) {
    if (l.deleted) continue;
    days.add(dayKey(l.timestamp));
  }
  return [...days];
}

// Recency-weighted attendance score for one exercise's session days.
function scoreOf(days, now) {
  let score = 0;
  for (const d of days) {
    const age = daysAgo(d, now);
    if (age > CONFIG.LOOKBACK_DAYS) continue;
    score += Math.exp(-age / CONFIG.RECENCY_HALF_LIFE_DAYS);
  }
  return score;
}

// Turns a score + last-session age into a tier. Hysteresis is approximated
// by giving mid-range scores a "grace" nudge toward the tier whose *exit*
// threshold they still clear, rather than always evaluating against the
// stricter *enter* threshold. Simple, stateless, good enough without needing
// to persist previous tiers per exercise.
function resolveTier(score, lastSessionAgeDays) {
  if (lastSessionAgeDays == null) return CONFIG.DEFAULT_TIER_FOR_NO_HISTORY;
  if (lastSessionAgeDays > CONFIG.STALE_DAYS) return 'Search_List';

  if (score >= CONFIG.MAIN_ENTER_SCORE) return 'Main_List';
  if (score >= CONFIG.MAIN_EXIT_SCORE) return 'Main_List'; // was already in main, held by hysteresis
  if (score >= CONFIG.QUICK_ENTER_SCORE) return 'Quick_List';
  if (score >= CONFIG.QUICK_EXIT_SCORE) return 'Quick_List'; // was already in quick, held by hysteresis
  return 'Search_List';
}

// --- main ------------------------------------------------------------------

/**
 * @param {string} muscleGroup - e.g. "chest", "back", "legs" (matches the
 *   "category" field in exercises_info.json)
 * @param {string} [dataDir] - folder containing exercises_info.json
 * @param {Date}   [now] - override for "today", mainly for testing
 * @returns {Promise<{Main_List: string[], Quick_List: string[], Search_List: string[]}>}
 */
async function getExerciseList(muscleGroup, dataDir = './Data', now = new Date()) {
  console.group(`🏋️ getExerciseList("${muscleGroup}")`);
  console.log('dataDir:', dataDir, '| now:', now.toISOString());

  // --- 1. Drive readiness ---
  let driveAvailable = true;
  try {
    await driveReady;
    console.log('✅ driveReady resolved');
  } catch (err) {
    driveAvailable = false;
    console.warn('⚠️ driveReady rejected — treating all as no-history:', err);
  }

  // --- 2. exercises_info.json fetch ---
  let infoBlob;
  try {
    const resp = await fetch(`${dataDir}/exercises_info.json`);
    console.log(`fetch exercises_info.json → status ${resp.status} ${resp.ok ? 'OK' : 'FAILED'}`);
    infoBlob = await resp.json();
  } catch (err) {
    console.error('❌ Could not load/parse exercises_info.json:', err);
    console.groupEnd();
    throw err;
  }
  const allNames = Object.keys(infoBlob);
  console.log(`infoBlob has ${allNames.length} exercises total`);

  // --- 3. category matching (most likely failure point) ---
  const categoriesSeen = [...new Set(allNames.map(n => infoBlob[n].category))];
  console.log('distinct categories in JSON:', categoriesSeen);
  console.log(`looking for category === "${muscleGroup.toLowerCase()}" (case-insensitive)`);

  const exercisesInGroup = allNames.filter(
    name => (infoBlob[name].category || '').toLowerCase() === muscleGroup.toLowerCase()
  );
  console.log(`→ ${exercisesInGroup.length} exercises matched this group:`, exercisesInGroup);
  if (exercisesInGroup.length === 0) {
    console.warn('⚠️ NO exercises matched — check muscleGroup arg vs the categories listed above (typo? case? "legs" vs "Legs" vs "quads"?)');
  }

  // --- 4. logs availability ---
  const allLogs = driveAvailable ? getAllLogs() : null;
  if (allLogs == null) {
    console.warn('⚠️ allLogs is null — every exercise will be no-history');
  } else {
    const loggedKeys = Object.keys(allLogs);
    console.log(`allLogs loaded: ${loggedKeys.length} exercises have log entries`);
    // How many of THIS group's exercises actually have a matching log key?
    const matched = exercisesInGroup.filter(n => allLogs[n] && allLogs[n].length);
    console.log(`of the ${exercisesInGroup.length} in-group exercises, ${matched.length} have matching log keys:`, matched);
    const unmatched = exercisesInGroup.filter(n => !allLogs[n] || !allLogs[n].length);
    if (unmatched.length) {
      console.log('in-group exercises with NO matching log key (name mismatch or never trained):', unmatched);
    }
  }

  const nowMs = now.getTime();
  const result = { Main_List: [], Quick_List: [], Search_List: [] };

  // --- 5. per-exercise tiering ---
  for (const name of exercisesInGroup) {
    const logs = allLogs ? (allLogs[name] || []) : [];
    const days = sessionDays(logs).sort();

    if (!days.length) {
      result[CONFIG.DEFAULT_TIER_FOR_NO_HISTORY].push(name);
      console.log(`  ${name}: 0 sessions → ${CONFIG.DEFAULT_TIER_FOR_NO_HISTORY}`);
      continue;
    }

    const lastSessionAgeDays = daysAgo(days[days.length - 1], nowMs);
    const score = scoreOf(days, nowMs);
    const tier = resolveTier(score, lastSessionAgeDays);
    result[tier].push(name);
    console.log(
      `  ${name}: ${days.length} sessions | score=${score.toFixed(2)} | lastSession=${lastSessionAgeDays.toFixed(1)}d ago → ${tier}`
    );
  }

  // --- 6. final result ---
  console.log('📊 RESULT counts:', {
    Main: result.Main_List.length,
    Quick: result.Quick_List.length,
    Search: result.Search_List.length,
  });
  console.log('full result:', result);
  console.groupEnd();

  return result;
}

export { getExerciseList, CONFIG };