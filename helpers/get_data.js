// get_data.js
//
// READ ADAPTER over log_store.js — NOT a separate Drive client anymore.
//
// This file used to run its OWN OAuth flow and keep its OWN copy of the logs
// (_driveData): a second, parallel Drive integration alongside drive_sync.js.
// THAT was the bug. On refresh, drive_sync.js filled log_store.js, but
// getExerciseList()/getExerciseSet() read _driveData here — which only the
// redundant button ever filled. Two stores, two logins, button-works /
// refresh-doesn't.
//
// Now there's ONE store: log_store.js (localStorage, synced by drive_sync.js).
// This file just re-exposes it under the old function names so exercise_list.js
// and set_prediction.js don't need their imports changed. ALL auth lives in
// drive_sync.js now.

// log_store.js loads as a classic <script>, so its functions are globals.
const _store = () => (window.exportAllLogs ? window.exportAllLogs() : {});

// Kept for backwards-compat: callers still `await driveReady` before reading.
// localStorage is synchronous and already populated on load, so there is
// literally nothing to wait for — resolve immediately.
const driveReady = Promise.resolve();

// Connecting Drive is drive_sync.js's job now. Delegate so the old button in
// app.js still works; the real popup + sync happens over there.
function connectDrive() {
  if (typeof window.connectDrive === 'function') window.connectDrive();
  return driveReady;
}

function getExerciseLog(exerciseName) {
  return (_store()[exerciseName] || []).filter(l => !l.deleted);
}

function getLastLog(exerciseName) {
  const logs = getExerciseLog(exerciseName);
  return logs.length ? logs.at(-1) : null;
}

function getAllLogs() {
  return _store(); // exportAllLogs already returns fresh objects — no clone needed
}

export { getExerciseLog, getLastLog, getAllLogs, driveReady, connectDrive };