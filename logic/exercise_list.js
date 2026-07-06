// exercise_list.js
//
// Function called by the UI: getExerciseList(muscleGroup)
// Returns: { Main_List: [...], Quick_List: [...], Search_List: [...] }
//
// (header comment unchanged — see original for the full tier/score explanation)

import { getAllLogs, driveReady } from '../helpers/get_data.js';

const EXERCISE_LIST_DEBUG = false; // flip to true for a per-exercise tiering trace

// --- CONFIG ------------------------------------------------------------
const CONFIG = {
  RECENCY_HALF_LIFE_DAYS: 21,
  LOOKBACK_DAYS: 180,
  MAIN_ENTER_SCORE: 3.0,
  MAIN_EXIT_SCORE: 1.8,
  QUICK_ENTER_SCORE: 1.0,
  QUICK_EXIT_SCORE: 0.5,
  STALE_DAYS: 45,
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

function sessionDays(logs) {
  const days = new Set();
  for (const l of logs) {
    if (l.deleted) continue;
    days.add(dayKey(l.timestamp));
  }
  return [...days];
}

function scoreOf(days, now) {
  let score = 0;
  for (const d of days) {
    const age = daysAgo(d, now);
    if (age > CONFIG.LOOKBACK_DAYS) continue;
    score += Math.exp(-age / CONFIG.RECENCY_HALF_LIFE_DAYS);
  }
  return score;
}

function resolveTier(score, priorScore, lastSessionAgeDays) {
  if (lastSessionAgeDays == null) return CONFIG.DEFAULT_TIER_FOR_NO_HISTORY;
  if (lastSessionAgeDays > CONFIG.STALE_DAYS) return 'Search_List';

  const wasMain = priorScore >= CONFIG.MAIN_ENTER_SCORE;
  const wasQuick = priorScore >= CONFIG.QUICK_ENTER_SCORE;

  if (score >= CONFIG.MAIN_ENTER_SCORE) return 'Main_List';
  if (wasMain && score >= CONFIG.MAIN_EXIT_SCORE) return 'Main_List';
  if (score >= CONFIG.QUICK_ENTER_SCORE) return 'Quick_List';
  if (wasQuick && score >= CONFIG.QUICK_EXIT_SCORE) return 'Quick_List';
  return 'Search_List';
}

// FIX #2: tolerant key matching. exercises_info.json names and getAllLogs()
// keys only have to differ in case/spacing/punctuation for the old
// `allLogs[name]` lookup to miss and dump every exercise into Search.
// Normalising both sides removes that whole class of silent failure.
function normKey(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- main ------------------------------------------------------------------

/**
 * @param {string} muscleGroup
 * @param {string} [dataDir]
 * @param {Date}   [now]
 * @returns {Promise<{Main_List: string[], Quick_List: string[], Search_List: string[]}>}
 */
async function getExerciseList(muscleGroup, dataDir = './Data', now = new Date()) {
  if (EXERCISE_LIST_DEBUG) console.group(`🏋️ getExerciseList("${muscleGroup}")`);

  // --- 1. Drive readiness ---
  let driveAvailable = true;
  try {
    await driveReady;
  } catch (err) {
    driveAvailable = false;
    console.warn('⚠️ driveReady rejected — treating all as no-history:', err);
  }

  // --- 2. exercises_info.json fetch ---
  let infoBlob;
  try {
    const resp = await fetch(`${dataDir}/exercises_info.json`);
    infoBlob = await resp.json();
  } catch (err) {
    console.error('❌ Could not load/parse exercises_info.json:', err);
    if (EXERCISE_LIST_DEBUG) console.groupEnd();
    throw err;
  }
  const allNames = Object.keys(infoBlob);

  // --- 3. category matching ---
  const exercisesInGroup = allNames.filter(
    name => (infoBlob[name].category || '').toLowerCase() === muscleGroup.toLowerCase()
  );
  if (exercisesInGroup.length === 0) {
    console.warn(`⚠️ getExerciseList("${muscleGroup}"): no exercises matched this category.`);
  }

  // --- 4. logs availability ---
  // FIX #1: await getAllLogs(). If it's async, the old un-awaited call left
  // allLogs as a Promise, so every allLogs[name] was undefined → all Search.
  // (await on a non-promise is a harmless no-op, so this is safe either way.)
  const allLogs = driveAvailable ? await getAllLogs() : null;

  // Build a normalised index once: normKey(logKey) -> logs array.
  let logIndex = null;
  if (allLogs != null) {
    logIndex = {};
    for (const k of Object.keys(allLogs)) logIndex[normKey(k)] = allLogs[k];
  }

  const nowMs = now.getTime();
  const result = { Main_List: [], Quick_List: [], Search_List: [] };
  const mainMisses = []; // exercises that had sessions but didn't reach Main, + why

  // --- 5. per-exercise tiering ---
  for (const name of exercisesInGroup) {
    // exact key first, then normalised fallback.
    const logs = allLogs ? (allLogs[name] || (logIndex ? logIndex[normKey(name)] : null) || []) : [];
    const days = sessionDays(logs).sort();

    if (!days.length) {
      result[CONFIG.DEFAULT_TIER_FOR_NO_HISTORY].push(name);
      if (EXERCISE_LIST_DEBUG) console.log(`  ${name}: 0 sessions → ${CONFIG.DEFAULT_TIER_FOR_NO_HISTORY}`);
      continue;
    }

    const lastSessionAgeDays = daysAgo(days[days.length - 1], nowMs);
    const score = scoreOf(days, nowMs);

    let priorScore = 0;
    if (days.length >= 2) {
      const priorDays = days.slice(0, -1);
      const priorRefMs = new Date(priorDays[priorDays.length - 1] + 'T00:00:00Z').getTime();
      priorScore = scoreOf(priorDays, priorRefMs);
    }

    const tier = resolveTier(score, priorScore, lastSessionAgeDays);
    result[tier].push(name);
    console.log(
      `  ${name}: ${days.length} sessions | score=${score.toFixed(2)} | priorScore=${priorScore.toFixed(2)} | lastSession=${lastSessionAgeDays.toFixed(1)}d ago → ${tier}`
    );

    // Explain every near-Main outcome so "why isn't this in Main?" is answerable.
    if (tier !== 'Main_List') {
      let why;
      if (lastSessionAgeDays > CONFIG.STALE_DAYS) {
        why = `STALE override: last session ${lastSessionAgeDays.toFixed(1)}d ago > STALE_DAYS(${CONFIG.STALE_DAYS})`;
      } else if (score >= CONFIG.MAIN_EXIT_SCORE && score < CONFIG.MAIN_ENTER_SCORE) {
        why = `score ${score.toFixed(2)} is in the hysteresis band [${CONFIG.MAIN_EXIT_SCORE}, ${CONFIG.MAIN_ENTER_SCORE}) but priorScore ${priorScore.toFixed(2)} < MAIN_ENTER(${CONFIG.MAIN_ENTER_SCORE}) → never earned Main, no grace`;
      } else {
        why = `score ${score.toFixed(2)} < MAIN_ENTER(${CONFIG.MAIN_ENTER_SCORE}); needs ~${(CONFIG.MAIN_ENTER_SCORE - score).toFixed(2)} more (roughly ${Math.ceil((CONFIG.MAIN_ENTER_SCORE - score) / Math.exp(-lastSessionAgeDays / CONFIG.RECENCY_HALF_LIFE_DAYS))} more recent sessions)`;
      }
      mainMisses.push({ name, score: +score.toFixed(2), tier, why });
    }
  }

  // --- 6. final result ---
  console.log('📊 RESULT counts:', {
    Main: result.Main_List.length,
    Quick: result.Quick_List.length,
    Search: result.Search_List.length,
  });
  console.log('full result:', result);
  console.groupEnd();

  // === LOUD SUMMARY (printed OUTSIDE the collapsed group so it's always visible) ===
  console.log(
    `%c[getExerciseList:${muscleGroup}] Main_List has ${result.Main_List.length} entries`,
    `font-weight:bold;font-size:13px;color:${result.Main_List.length ? '#16a34a' : '#dc2626'}`
  );
  if (result.Main_List.length === 0) {
    console.warn(
      `❗ THIS FUNCTION PRODUCED ZERO MAIN ENTRIES for "${muscleGroup}". ` +
      `So if the screen shows no Main items, the bug is UPSTREAM (scoring/data), not rendering.`
    );
    if (mainMisses.length) {
      console.warn('Closest exercises to Main and why each missed:');
      console.table(mainMisses.sort((a, b) => b.score - a.score).slice(0, 10));
    } else {
      console.warn('No exercise in this group had ANY logged sessions → likely a log-key join problem (see the "matching log keys" line above).');
    }
  } else {
    console.log('✅ Main_List contents being returned:', result.Main_List);
    console.warn(
      `👉 RENDER CHECK: this function IS returning ${result.Main_List.length} Main item(s). ` +
      `If the screen still shows none, the bug is in the UI. Add this line where you consume the result:\n` +
      `   console.log('[UI] received Main_List:', list.Main_List);\n` +
      `and confirm it logs the same ${result.Main_List.length} item(s).`
    );
  }
  console.log('[getExerciseList] RETURNING →', JSON.parse(JSON.stringify(result)));

  return result;
}

export { getExerciseList, CONFIG };