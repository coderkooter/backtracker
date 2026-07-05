// app.js
// Wires the UI to the logic layer (exercise_list.js, set_prediction.js,
// ai_coach_text.js, search_function.js, log_store.js).
import { getExerciseSet } from './logic/set_prediction.js';
import { getExerciseList } from './logic/exercise_list.js';
import { driveReady } from './helpers/get_data.js';
import { connectDrive } from './helpers/get_data.js';

const state = {
  currentGroup: 'chest',
  openExercises: new Set() // exercises pulled in from the quick list for this session
};

async function init() {
  // Repaint the lists when drive_sync finishes pulling fresh cloud data
  // (silent refresh on load, or a manual connect via the status dot).
  window.onDriveDataLoaded = () => switchGroup(state.currentGroup);

  // Wire up interactivity immediately — the UI should be clickable even if
  // Drive sync is slow, still waiting on the consent popup, or fails outright.
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchGroup(btn.dataset.group));
  });

  document.getElementById('search-results').addEventListener('click', handleSearchResultClick);

  document.getElementById('exercise-list').addEventListener('click', handleExerciseListClick);
  document.getElementById('search-input').addEventListener('input', handleSearch);

  // Render immediately too, using whatever's available (likely nothing yet —
  // getExerciseList/getExerciseSet already handle a null/not-loaded Drive
  // state gracefully). This makes the empty/loading state visible instead of
  // a blank unresponsive screen.
  switchGroup('chest');

  // try {
  //   await driveReady;
  //   console.log('Drive data loaded — refreshing UI with real data');
  //   switchGroup(state.currentGroup); // re-render now that logs are in
  // } catch (err) {
  //   console.error('Could not load Drive data:', err);
  //   // TODO: surface a visible "sync failed, tap to retry" state in the UI
  // }
}

function switchGroup(group) {
  state.currentGroup = group;
  state.openExercises.clear();

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.group === group);
  });

  renderExercises();
  renderQuickList();
}

// ---------- Main exercise list ----------

async function renderExercises() {
  const list = await getExerciseList(state.currentGroup);
  const container = document.getElementById('exercise-list');
  container.innerHTML = '';

  const mainNames = list.Main_List;
  const extraNames = [...state.openExercises].filter(n => !mainNames.includes(n));

  mainNames.forEach(name => container.appendChild(buildExerciseCard(name, false)));
  extraNames.forEach(name => container.appendChild(buildExerciseCard(name, true)));
}

function buildExerciseCard(name, fromQuickList) {
  const card = document.createElement('div');
  card.className = 'exercise-card';
  card.dataset.exercise = name;

  card.innerHTML = `
    <div class="card-header">
      <span class="exercise-name">${name}</span>
      ${fromQuickList ? '<span class="quick-badge">quick</span>' : ''}
    </div>

    <div class="predict-meta" hidden></div>

    <div class="input-row">
      <div class="stepper">
        <button class="step-btn" data-delta="-2.5" type="button">−</button>
        <input type="number" class="value-input weight-input" value="" placeholder="…" inputmode="decimal">
        <button class="step-btn" data-delta="2.5" type="button">+</button>
        <span class="unit">kg</span>
      </div>
      <div class="stepper">
        <button class="step-btn" data-delta="-1" type="button">−</button>
        <input type="number" class="value-input reps-input" value="" placeholder="…" inputmode="numeric">
        <button class="step-btn" data-delta="1" type="button">+</button>
        <span class="unit">reps</span>
      </div>
    </div>

    <div class="rpe-row">
      <span class="rpe-label">RPE</span>
      <button class="rpe-btn" data-rpe="1" type="button">1</button>
      <button class="rpe-btn" data-rpe="2" type="button">2</button>
      <button class="rpe-btn" data-rpe="3" type="button">3</button>
    </div>

    <div class="coach-text" hidden></div>

    <button class="plug-btn" type="button">🔌 Log set</button>

    <div class="last-logs"></div>
  `;

  renderLastLogs(card, name);
  fillPrediction(card, name);
  return card;
}

function fillPrediction(card, name) {
  getExerciseSet(name).then(predicted => {
    card.querySelector('.weight-input').value = predicted.weight ?? '';
    card.querySelector('.reps-input').value = predicted.reps ?? '';

    const bits = [];
    if (predicted.phase) bits.push(predicted.phase[0].toUpperCase() + predicted.phase.slice(1) + ' phase');
    if (predicted.target_rpe) bits.push(`target RPE ${predicted.target_rpe}`);
    if (predicted.e1rm) bits.push(`e1RM ${predicted.e1rm}kg`);
    if (predicted.note) bits.push(predicted.note);

    if (bits.length) {
      const meta = card.querySelector('.predict-meta');
      meta.hidden = false;
      meta.textContent = bits.join(' · ');
    }
  }).catch(err => {
    console.error('Set prediction failed for', name, err);
  });
}

// ---------- Click delegation for exercise cards ----------

function handleExerciseListClick(e) {
  const card = e.target.closest('.exercise-card');
  if (!card) return;
  const name = card.dataset.exercise;

  if (e.target.classList.contains('step-btn')) {
    const delta = parseFloat(e.target.dataset.delta);
    const input = e.target.parentElement.querySelector('.value-input');
    const next = (parseFloat(input.value) || 0) + delta;
    input.value = Math.max(0, next);
    return;
  }

  if (e.target.classList.contains('rpe-btn')) {
    card.querySelectorAll('.rpe-btn').forEach(b => b.classList.remove('selected'));
    e.target.classList.add('selected');
    const rpe = parseInt(e.target.dataset.rpe, 10);
    card.dataset.rpe = rpe;

    const coachBox = card.querySelector('.coach-text');
    coachBox.hidden = false;
    coachBox.textContent = getAiCoach(name, rpe);
    return;
  }

  if (e.target.classList.contains('plug-btn')) {
    const weight = parseFloat(card.querySelector('.weight-input').value);
    const reps = parseInt(card.querySelector('.reps-input').value, 10);
    const rpe = parseInt(card.dataset.rpe || '', 10);

    if (!rpe) {
      flashCard(card, 'flash-warn');
      return;
    }

    updateLog(name, weight, reps, rpe);
    renderLastLogs(card, name);
    fillPrediction(card, name);   // <-- re-run prediction with the new log included
    flashCard(card, 'flash-go');
    return;
  }

  if (e.target.classList.contains('edit-log-btn')) {
    startEditLog(card, name, e.target.dataset.logId);
    return;
  }

  if (e.target.classList.contains('delete-log-btn')) {
    handleDeleteClick(e.target, card, name);
    return;
  }

  if (e.target.classList.contains('save-edit-btn')) {
    saveEditLog(card, name, e.target.dataset.logId);
    return;
  }

  if (e.target.classList.contains('cancel-edit-btn')) {
    renderLastLogs(card, name);
    return;
  }
}

function flashCard(card, className) {
  card.classList.remove('flash-go', 'flash-warn');
  // force reflow so the animation re-triggers on repeat taps
  void card.offsetWidth;
  card.classList.add(className);
  setTimeout(() => card.classList.remove(className), 450);
}

// ---------- Last 5 logs: render / edit / delete ----------

function renderLastLogs(card, name) {
  const wrap = card.querySelector('.last-logs');
  const logs = getLastLogs(name, 5);

  if (!logs.length) {
    wrap.innerHTML = `<div class="last-logs-label">Last 5 sets</div><div class="log-empty">No sets logged yet.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="last-logs-label">Last 5 sets</div>` +
    logs.map(logRowHtml).join('');
}

function logRowHtml(l) {
  const date = new Date(l.timestamp);
  const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `
    <div class="log-row" data-log-id="${l.id}">
      <span class="log-value">${l.weight}kg × ${l.reps} @ RPE${l.rpe}${l.edited ? ' ✎' : ''}</span>
      <span class="log-meta">${dateStr}</span>
      <span class="log-actions">
        <button class="edit-log-btn" data-log-id="${l.id}" type="button">✏️</button>
        <button class="delete-log-btn" data-log-id="${l.id}" type="button">🗑️</button>
      </span>
    </div>`;
}

function startEditLog(card, name, logId) {
  const entry = getLastLogs(name, 5).find(l => l.id === logId);
  if (!entry) return;
  const row = card.querySelector(`.log-row[data-log-id="${logId}"]`);
  row.innerHTML = `
    <input type="number" class="edit-field edit-weight" value="${entry.weight}">
    <input type="number" class="edit-field edit-reps" value="${entry.reps}">
    <input type="number" class="edit-field edit-rpe" value="${entry.rpe}" min="1" max="3">
    <span class="edit-row-actions">
      <button class="save-edit-btn" data-log-id="${logId}" type="button">✓</button>
      <button class="cancel-edit-btn" type="button">✕</button>
    </span>`;
}

function saveEditLog(card, name, logId) {
  const row = card.querySelector(`.log-row[data-log-id="${logId}"]`);
  const weight = parseFloat(row.querySelector('.edit-weight').value);
  const reps = parseInt(row.querySelector('.edit-reps').value, 10);
  const rpe = parseInt(row.querySelector('.edit-rpe').value, 10);
  editLog(name, logId, weight, reps, rpe);
  renderLastLogs(card, name);
}

function handleDeleteClick(btn, card, name) {
  if (btn.classList.contains('confirming')) {
    deleteLog(name, btn.dataset.logId);
    renderLastLogs(card, name);
    return;
  }
  btn.classList.add('confirming');
  btn.textContent = 'Confirm?';
  setTimeout(() => {
    btn.classList.remove('confirming');
    btn.textContent = '🗑️';
  }, 2000);
}

// ---------- Quick list ----------

async function renderQuickList() {
  const list = await getExerciseList(state.currentGroup);
  const row = document.getElementById('quick-list');
  row.innerHTML = '';

  list.Quick_List.forEach(name => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'quick-chip' + (state.openExercises.has(name) ? ' active' : '');
    chip.textContent = name;
    chip.addEventListener('click', () => toggleQuickExercise(name));
    row.appendChild(chip);
  });
}

function toggleQuickExercise(name) {
  if (state.openExercises.has(name)) {
    state.openExercises.delete(name);
  } else {
    state.openExercises.add(name);
  }
  renderExercises();
  renderQuickList();
}

// ---------- Search (stub — wiring only, logic added later) ----------

function handleSearch(e) {
  const query = e.target.value.trim();
  const container = document.getElementById('search-results');

  if (!query) {
    container.innerHTML = '';
    return;
  }

  const results = searchExercises(query);
  container.innerHTML = results.length
    ? results.map(r => `<div class="search-result" data-exercise="${r}">${r}</div>`).join('')
    : '<div class="search-empty">No exercises match that.</div>';
}

function handleSearchResultClick(e) {
  const hit = e.target.closest('.search-result');
  if (!hit) return;

  const name = hit.dataset.exercise;

  // Reuse the quick-list rail: pull the exercise into the current view as an
  // extra card. renderExercises() already renders openExercises on top of
  // Main_List, and logging into it flows through the normal log_store path.
  state.openExercises.add(name);
  renderExercises();

  // Clear the search box + results so the new card is the focus, and scroll
  // it into view so the user sees where it landed.
  const input = document.getElementById('search-input');
  input.value = '';
  document.getElementById('search-results').innerHTML = '';

  const card = document.querySelector(`.exercise-card[data-exercise="${CSS.escape(name)}"]`);
  if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

document.addEventListener('DOMContentLoaded', init);  