// ai_coach_store.js
//
// Holds the coaching notes read from ai_coach.json in Drive (pulled by
// drive_sync.js's _pullAiCoach). Cached to localStorage so notes are still
// available immediately on reload, before the Drive pull finishes.
//
// Expected ai_coach.json shape — a flat map of exercise name -> note.
// A missing key, or a null/empty value, means "no advice for this exercise":
//   {
//     "Bench Press": "RPE has crept up three sessions straight — consider a deload.",
//     "Squat": "Steady progress, keep adding load in small increments.",
//     "Overhead Press": null
//   }
//
// Functions called by drive_sync.js:
//   importAiCoach(data)        replace the in-memory + cached coaching data
// Functions called by the UI (ai_coach_text.js):
//   getCoachNote(exerciseName) -> string | null

const AI_COACH_STORAGE_KEY = 'backtracker_ai_coach';

function _loadCachedCoach() {
  try {
    const raw = localStorage.getItem(AI_COACH_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    console.error('ai_coach_store: failed to read cached notes', err);
    return {};
  }
}

let _aiCoachData = _loadCachedCoach();

function importAiCoach(data) {
  _aiCoachData = (data && typeof data === 'object') ? data : {};
  localStorage.setItem(AI_COACH_STORAGE_KEY, JSON.stringify(_aiCoachData));
}

function getCoachNote(exerciseName) {
  const note = _aiCoachData[exerciseName];
  return note ? String(note) : null;
}
