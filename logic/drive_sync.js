// drive_sync.js
//
// Syncs log_store.js with a single JSON file in the user's Google Drive
// (backtracker_logs.json), so logs follow you across devices.
//
// ONE-TIME SETUP (Google Cloud Console):
//   1. console.cloud.google.com -> new project (or reuse one)
//   2. APIs & Services -> Library -> enable "Google Drive API"
//   3. APIs & Services -> OAuth consent screen -> External -> fill app name,
//      your email -> add yourself as a test user
//   4. APIs & Services -> Credentials -> Create Credentials -> OAuth client ID
//      -> Application type: Web application
//      -> Authorized JavaScript origins: every origin you'll load the app from
//         (e.g. http://localhost:5500, later https://<you>.github.io)
//   5. Paste the Client ID into CLIENT_ID below.
//
// Scope used: drive.file -> this app can only see/edit files it creates
// itself. It never sees the rest of your Drive.

const DRIVE_SYNC_CONFIG = {
  CLIENT_ID: '796415309185-ooj2o7802s8cfbgdv94cf9jeq3l29rkm.apps.googleusercontent.com',
  SCOPES: 'https://www.googleapis.com/auth/drive.file',
  FILE_NAME: 'backtracker_logs.json'
};

const _driveState = {
  tokenClient: null,
  accessToken: null,
  fileId: null,
  aiCoachFileId: null,
  pushTimer: null,
  syncing: false
};

function initDriveSync() {
  _injectSyncStatusUI();
  _injectAiCoachUploadUI();
  _waitForGoogleThen(_setupTokenClient);
}

function _waitForGoogleThen(cb, attemptsLeft = 20) {
  if (window.google && google.accounts) { cb(); return; }
  if (attemptsLeft <= 0) { _setSyncStatus('offline'); return; }
  setTimeout(() => _waitForGoogleThen(cb, attemptsLeft - 1), 250);
}

function _setupTokenClient() {
  if (DRIVE_SYNC_CONFIG.CLIENT_ID.startsWith('PASTE_')) {
    _setSyncStatus('unconfigured');
    return;
  }

  _driveState.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: DRIVE_SYNC_CONFIG.CLIENT_ID,
    scope: DRIVE_SYNC_CONFIG.SCOPES,
    callback: _onToken,
    error_callback: (err) => {
      // Silent refresh couldn't complete without UI (no live grant / session).
      // Do NOT let it escalate to a popup — just show disconnected and wait
      // for the user to tap the status dot.
      console.warn('Silent Drive refresh failed, tap to connect:', err.type);
      localStorage.removeItem('backtracker_drive_connected'); // stale flag; clear it
      _setSyncStatus('disconnected');
    }
  });

  onLogStoreChange(_scheduleDrivePush);
  window.addEventListener('online', () => { if (_driveState.accessToken) _pullThenPush(); });

  if (localStorage.getItem('backtracker_drive_connected') === '1') {
    _driveState.tokenClient.requestAccessToken({ prompt: '' }); // silent refresh
  } else {
    _setSyncStatus('disconnected');
  }
}

function connectDrive() {
  if (!_driveState.tokenClient) return;
  _driveState.tokenClient.requestAccessToken({ prompt: 'consent' });
}

function _onToken(resp) {
  if (resp.error) { _setSyncStatus('error'); return; }
  _driveState.accessToken = resp.access_token;
  localStorage.setItem('backtracker_drive_connected', '1');
  _pullThenPush();
}

async function _driveFetch(url, options = {}) {
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${_driveState.accessToken}` }
  });
}

async function _findOrCreateFile() {
  if (_driveState.fileId) return _driveState.fileId;

  const q = encodeURIComponent(`name='${DRIVE_SYNC_CONFIG.FILE_NAME}' and trashed=false`);
  const searchRes = await _driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
  );
  const searchData = await searchRes.json();

  if (searchData.files && searchData.files.length) {
    _driveState.fileId = searchData.files[0].id;
    return _driveState.fileId;
  }

  const createRes = await _driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: DRIVE_SYNC_CONFIG.FILE_NAME })
  });
  const createData = await createRes.json();
  _driveState.fileId = createData.id;
  return _driveState.fileId;
}

async function _pullThenPush() {
  if (_driveState.syncing) return;
  _driveState.syncing = true;
  _setSyncStatus('syncing');

  try {
    const fileId = await _findOrCreateFile();
    const res = await _driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (res.ok) {
      const text = await res.text();
      if (text) importMergeLogs(JSON.parse(text));
    }
    await _pushNow();
    await _pullAiCoach();  
    _setSyncStatus('synced');
    if (typeof window.onDriveDataLoaded === 'function') window.onDriveDataLoaded(); // ← repaint  
  } catch (err) {
    console.error('Drive sync failed', err);
    _setSyncStatus('error');
  } finally {
    _driveState.syncing = false;
  }
}

function _scheduleDrivePush() {
  if (!_driveState.accessToken) return; // local write already happened, will push once connected
  clearTimeout(_driveState.pushTimer);
  _setSyncStatus('pending');
  _driveState.pushTimer = setTimeout(_pushNow, 3000);
}

async function _pushNow() {
  if (!_driveState.accessToken) return;
  try {
    const fileId = await _findOrCreateFile();
    await _driveFetch(
      `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(exportAllLogs())
      }
    );
    _setSyncStatus('synced');
  } catch (err) {
    console.error('Drive push failed', err);
    _setSyncStatus('error');
  }
}

// ---- minimal status dot, injected into the top nav ----

function _injectSyncStatusUI() {
  const nav = document.querySelector('.topnav');
  if (!nav || document.getElementById('sync-status')) return;

  const dot = document.createElement('button');
  dot.id = 'sync-status';
  dot.type = 'button';
  dot.title = 'Google Drive sync';
  dot.addEventListener('click', () => { if (!_driveState.accessToken) connectDrive(); });
  nav.appendChild(dot);
}

function _setSyncStatus(status) {
  const dot = document.getElementById('sync-status');
  if (!dot) return;
  dot.className = 'sync-dot sync-' + status;
  const labels = {
    unconfigured: 'Drive sync not set up yet (see drive_sync.js)',
    disconnected: 'Tap to connect Google Drive',
    pending: 'Changes pending sync…',
    syncing: 'Syncing…',
    synced: 'Synced',
    offline: 'Offline',
    error: 'Sync error — tap to retry'
  };
  dot.title = labels[status] || '';
}

async function _pullAiCoach() {
  try {
    const q = encodeURIComponent(`name='ai_coach.json' and trashed=false`);
    const searchRes = await _driveFetch(
      `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
    );
    const searchData = await searchRes.json();
    const file = searchData.files && searchData.files[0];

    if (!file) {
      // drive.file scope only sees files THIS app created or opened — a file
      // just uploaded straight into Drive is invisible to this search until
      // it's opened through this app (e.g. via a file picker), so this is
      // the most likely reason coach notes don't show up.
      console.warn('drive_sync: ai_coach.json not found in Drive — remember drive.file scope only sees files this app created or opened, not ones uploaded directly in Drive');
      return;
    }

    const res = await _driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`);
    if (!res.ok) {
      console.error(`drive_sync: ai_coach.json found but fetch failed (HTTP ${res.status})`);
      return;
    }

    const text = await res.text();
    if (!text) {
      console.warn('drive_sync: ai_coach.json found but empty');
      return;
    }

    let notes;
    try {
      notes = JSON.parse(text);
    } catch (err) {
      console.error('drive_sync: ai_coach.json is not valid JSON', err);
      return;
    }

    if (typeof importAiCoach === 'function') importAiCoach(notes);
    console.log(`drive_sync: ai_coach.json loaded — ${Object.keys(notes).length} note(s) for:`, Object.keys(notes));
  } catch (err) {
    console.error('drive_sync: failed to load ai_coach.json', err);
  }
}

async function _findOrCreateAiCoachFile() {
  if (_driveState.aiCoachFileId) return _driveState.aiCoachFileId;

  const q = encodeURIComponent(`name='ai_coach.json' and trashed=false`);
  const searchRes = await _driveFetch(
    `https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`
  );
  const searchData = await searchRes.json();

  if (searchData.files && searchData.files.length) {
    _driveState.aiCoachFileId = searchData.files[0].id;
    return _driveState.aiCoachFileId;
  }

  const createRes = await _driveFetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'ai_coach.json' })
  });
  const createData = await createRes.json();
  _driveState.aiCoachFileId = createData.id;
  return _driveState.aiCoachFileId;
}

// Writes notes to ai_coach.json THROUGH this app (find-or-create, same
// pattern as backtracker_logs.json) so drive.file scope can read it back
// afterward — a file uploaded directly on drive.google.com never becomes
// visible to this scope.
async function writeAiCoach(notes) {
  const fileId = await _findOrCreateAiCoachFile();
  await _driveFetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notes)
    }
  );
}

// Manual upload path: user picks a local ai_coach.json (flat
// { "Exercise Name": "note" } map — see ai_coach_store.js) and this writes
// it to Drive through the app, then reloads it into the running UI.
async function uploadAiCoachFile(file) {
  if (!_driveState.accessToken) {
    console.warn('uploadAiCoachFile: connect Drive first');
    return;
  }

  const text = await file.text();
  let notes;
  try {
    notes = JSON.parse(text);
  } catch (err) {
    console.error('uploadAiCoachFile: selected file is not valid JSON', err);
    alert('That file is not valid JSON — check the format and try again.');
    return;
  }
  if (!notes || typeof notes !== 'object' || Array.isArray(notes)) {
    console.error('uploadAiCoachFile: expected a flat { "Exercise Name": "note" } object', notes);
    alert('ai_coach.json should be a flat object of { "Exercise Name": "note" }.');
    return;
  }

  try {
    await writeAiCoach(notes);
    importAiCoach(notes);
    console.log(`uploadAiCoachFile: uploaded ${Object.keys(notes).length} note(s) to Drive`, Object.keys(notes));
    if (typeof window.onDriveDataLoaded === 'function') window.onDriveDataLoaded();
  } catch (err) {
    console.error('uploadAiCoachFile: upload failed', err);
  }
}

function _injectAiCoachUploadUI() {
  const nav = document.querySelector('.topnav');
  if (!nav || document.getElementById('ai-coach-upload')) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.id = 'ai-coach-upload-input';
  input.hidden = true;
  input.addEventListener('change', () => {
    const file = input.files[0];
    input.value = ''; // reset so picking the same file again still fires 'change'
    if (file) uploadAiCoachFile(file);
  });

  const btn = document.createElement('button');
  btn.id = 'ai-coach-upload';
  btn.type = 'button';
  btn.textContent = '📤';
  btn.title = 'Upload ai_coach.json to Drive';
  btn.addEventListener('click', () => {
    if (!_driveState.accessToken) { connectDrive(); return; }
    input.click();
  });

  nav.appendChild(input);
  nav.appendChild(btn);
}

// Generate coaching notes from logged history, then write them to Drive
// THROUGH this app (writeAiCoach) so drive.file scope can read them back.
async function generateAndUploadCoach() {
  if (!_driveState.accessToken) {
    console.warn('generateAndUploadCoach: connect Drive first');
    return;
  }

  const logs = exportAllLogs(); // { exerciseName: [entries] }, already synced
  if (!Object.keys(logs).length) {
    console.warn('generateAndUploadCoach: no logs to analyse yet');
    return;
  }

  const prompt = _buildCoachPrompt(logs);

  let raw;
  try {
    raw = await callClaude(prompt);        // ← the ONE part that depends on hosting
  } catch (err) {
    console.error('generateAndUploadCoach: model call failed', err);
    return;
  }

  const notes = _parseCoachJson(raw);
  if (!notes) return;

  await writeAiCoach(notes);               // app-created file → readable under drive.file
  await _pullAiCoach();                    // reload into _aiCoachData
  if (window.onDriveDataLoaded) window.onDriveDataLoaded(); // repaint cards
  console.log(`generateAndUploadCoach: wrote notes for ${Object.keys(notes).length} exercises`);
}

function _buildCoachPrompt(logs) {
  // Trim to what matters: drop deleted entries, keep recent history per exercise.
  const trimmed = {};
  for (const [name, entries] of Object.entries(logs)) {
    const live = entries.filter(e => !e.deleted)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
      .slice(-20) // last 20 sets is plenty of signal, keeps the prompt small
      .map(e => ({ w: e.weight, r: e.reps, rpe: e.rpe, t: e.timestamp.slice(0, 10) }));
    if (live.length) trimmed[name] = live;
  }

  return `You are an experienced strength coach analysing a lifter's training log.
For each exercise with enough data, write ONE short coaching note (1-2 sentences):
comment on RPE trends, stalls or progress, recency, and volume. Be specific and
practical. Skip exercises with too little data.

Return ONLY valid JSON — no markdown, no prose around it — shaped exactly as:
{ "Exercise Name": { "note": "...", "updated": "${new Date().toISOString().slice(0,10)}" } }

RPE scale here is 1-3 (1 = easy, 2 = target, 3 = grinder).

Training log (last sets per exercise, oldest to newest):
${JSON.stringify(trimmed)}`;
}

function _parseCoachJson(raw) {
  const clean = String(raw).replace(/```json|```/g, '').trim();
  try {
    const parsed = JSON.parse(clean);
    if (parsed && typeof parsed === 'object') return parsed;
    console.error('_parseCoachJson: not an object', parsed);
  } catch (err) {
    console.error('_parseCoachJson: parse failed', err, clean.slice(0, 200));
  }
  return null;
}

window.generateAndUploadCoach = generateAndUploadCoach;
window.uploadAiCoachFile = uploadAiCoachFile;

document.addEventListener('DOMContentLoaded', initDriveSync);
