// log_store.js
//
// Functions called by the UI:
//   updateLog(exerciseName, weight, reps, rpe)
//   getLastLogs(exerciseName, count = 5)
//   editLog(exerciseName, logId, weight, reps, rpe)
//   deleteLog(exerciseName, logId)
//
// Functions called by drive_sync.js (or any future sync layer):
//   onLogStoreChange(fn)      subscribe to local mutations
//   exportAllLogs()           full local dataset, for pushing to the cloud
//   importMergeLogs(remote)   merge a remote dataset into local storage
//
// LOCAL IMPLEMENTATION using localStorage, keyed per exercise.
// Soft-delete (tombstones) so a delete on one device survives a merge
// with another device that still has the old entry.

const LOG_STORE_PREFIX = 'backtracker_log__';
const _changeListeners = [];

function onLogStoreChange(fn) {
  _changeListeners.push(fn);
}

function _notifyChange(exerciseName) {
  _changeListeners.forEach(fn => fn(exerciseName));
}

function _allExerciseKeys() {
  return Object.keys(localStorage)
    .filter(k => k.startsWith(LOG_STORE_PREFIX))
    .map(k => k.slice(LOG_STORE_PREFIX.length));
}

function _loadRaw(exerciseName) {
  const raw = localStorage.getItem(LOG_STORE_PREFIX + exerciseName);
  return raw ? JSON.parse(raw) : [];
}

function _saveRaw(exerciseName, logs) {
  localStorage.setItem(LOG_STORE_PREFIX + exerciseName, JSON.stringify(logs));
}

function _newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function updateLog(exerciseName, weight, reps, rpe) {
  const logs = _loadRaw(exerciseName);
  const now = new Date().toISOString();
  const entry = {
    id: _newId(),
    weight, reps, rpe,
    timestamp: now,
    modified: now,
    deleted: false
  };
  logs.push(entry);
  _saveRaw(exerciseName, logs);
  _notifyChange(exerciseName);
  return entry;
}

function getLastLogs(exerciseName, count = 5) {
  const logs = _loadRaw(exerciseName).filter(l => !l.deleted);
  return logs.slice(-count).reverse();
}

function editLog(exerciseName, logId, weight, reps, rpe) {
  const logs = _loadRaw(exerciseName);
  const entry = logs.find(l => l.id === logId);
  if (!entry) return null;
  entry.weight = weight;
  entry.reps = reps;
  entry.rpe = rpe;
  entry.edited = true;
  entry.modified = new Date().toISOString();
  _saveRaw(exerciseName, logs);
  _notifyChange(exerciseName);
  return entry;
}

function deleteLog(exerciseName, logId) {
  const logs = _loadRaw(exerciseName);
  const entry = logs.find(l => l.id === logId);
  if (!entry) return false;
  entry.deleted = true;
  entry.modified = new Date().toISOString();
  _saveRaw(exerciseName, logs);
  _notifyChange(exerciseName);
  return true;
}

// ---- Sync layer hooks ----

function exportAllLogs() {
  const out = {};
  _allExerciseKeys().forEach(name => { out[name] = _loadRaw(name); });
  return out;
}

// Merge a remote { exerciseName: [entries] } dataset into local storage.
// Per entry id: keep whichever copy has the newer `modified` timestamp.
function importMergeLogs(remote) {
  if (!remote) return;
  Object.keys(remote).forEach(exerciseName => {
    const local = _loadRaw(exerciseName);
    const byId = new Map(local.map(l => [l.id, l]));

    remote[exerciseName].forEach(rEntry => {
      const lEntry = byId.get(rEntry.id);
      if (!lEntry || new Date(rEntry.modified) > new Date(lEntry.modified)) {
        byId.set(rEntry.id, rEntry);
      }
    });

    _saveRaw(exerciseName, [...byId.values()].sort((a, b) =>
      new Date(a.timestamp) - new Date(b.timestamp)));
  });
}
