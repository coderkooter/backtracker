// ai_coach_text.js
//
// Function called by the UI: getAiCoach(exerciseName)
// Returns: string | null — the coaching note to show when this exercise's
// card opens in the main list, or null if there's no advice for it.
//
// Backed by ai_coach_store.js, which holds whatever ai_coach.json (uploaded
// to Drive — see drive_sync.js) contains for this exercise.

function getAiCoach(exerciseName) {
  return getCoachNote(exerciseName);
}
