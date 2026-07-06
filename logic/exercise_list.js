// exercise_list.js
//
// Function called by the UI: getExerciseList(muscleGroup)
// Returns: { Main_List: [...], Quick_List: [...], Search_List: [...] }
//
// (header comment unchanged — see original for the full tier/score explanation)

import { getAllLogs, driveReady } from '../helpers/get_data.js';

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

  // --- 3. category matching ---
  const categoriesSeen = [...new Set(allNames.map(n => infoBlob[n].category))];
  console.log('distinct categories in JSON:', categoriesSeen);
  console.log(`looking for category === "${muscleGroup.toLowerCase()}" (case-insensitive)`);

  const exercisesInGroup = allNames.filter(
    name => (infoBlob[name].category || '').toLowerCase() === muscleGroup.toLowerCase()
  );
  console.log(`→ ${exercisesInGroup.length} exercises matched this group:`, exercisesInGroup);
  if (exercisesInGroup.length === 0) {
    console.warn('⚠️ NO exercises matched — check muscleGroup arg vs the categories listed above.');
  }

  // --- 4. logs availability ---
  // FIX #1: await getAllLogs(). If it's async, the old un-awaited call left
  // allLogs as a Promise, so every allLogs[name] was undefined → all Search.
  // (await on a non-promise is a harmless no-op, so this is safe either way.)
  const allLogs = driveAvailable ? await getAllLogs() : null;

  // Build a normalised index once: normKey(logKey) -> logs array.
  let logIndex = null;
  if (allLogs == null) {
    console.warn('⚠️ allLogs is null — every exercise will be no-history');
  } else {
    logIndex = {};
    for (const k of Object.keys(allLogs)) logIndex[normKey(k)] = allLogs[k];

    const loggedKeys = Object.keys(allLogs);
    console.log(`allLogs loaded: ${loggedKeys.length} exercises have log entries`);

    const logsFor = n => allLogs[n] || logIndex[normKey(n)] || [];
    const matched = exercisesInGroup.filter(n => logsFor(n).length);
    console.log(`of the ${exercisesInGroup.length} in-group exercises, ${matched.length} have matching log keys:`, matched);
    const unmatched = exercisesInGroup.filter(n => !logsFor(n).length);
    if (unmatched.length) {
      console.log('in-group exercises with NO matching log key (name mismatch or never trained):', unmatched);
    }
  }

  const nowMs = now.getTime();
  const result = { Main_List: [], Quick_List: [], Search_List: [] };

  // --- 5. per-exercise tiering ---
  for (const name of exercisesInGroup) {
    // exact key first, then normalised fallback.
    const logs = allLogs ? (allLogs[name] || (logIndex ? logIndex[normKey(name)] : null) || []) : [];
    const days = sessionDays(logs).sort();

    if (!days.length) {
      result[CONFIG.DEFAULT_TIER_FOR_NO_HISTORY].push(name);
      console.log(`  ${name}: 0 sessions → ${CONFIG.DEFAULT_TIER_FOR_NO_HISTORY}`);
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