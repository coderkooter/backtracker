// ai_coach_text.js
//
// Function called by the UI: getAiCoach(exerciseName, rpe)
// Returns: string (coaching note shown under the RPE row)
//
// MOCK IMPLEMENTATION. Replace the body of getAiCoach with a call to the
// AI coaching layer (pattern recognition across training history: fatigue
// correlations, accessory neglect, personal SRA curve characteristics).

function getAiCoach(exerciseName, rpe) {
  const MOCK_COACH_BY_RPE = {
    1: `${exerciseName}: felt light. Push the next set or add load.`,
    2: `${exerciseName}: right in the target zone. Hold the line here.`,
    3: `${exerciseName}: that was a grinder. Bank it, don't chase a number today.`
  };

  return MOCK_COACH_BY_RPE[rpe] || `Log a set on ${exerciseName} to get coaching feedback.`;
}
