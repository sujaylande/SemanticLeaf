/* =========================================================
   Loose Leaf — a folderless, local-first memory vault.

   Everything runs in this browser tab:
   - Notes + their embeddings live in IndexedDB (this device only).
   - "Understanding" comes from a small sentence-embedding model
     (Xenova/all-MiniLM-L6-v2) that downloads once from a public
     CDN and then runs fully offline via WebAssembly.
   - No API keys, no server, no account, no ongoing cost.
   ========================================================= */

/* ---------------------------------------------------------
   Config
--------------------------------------------------------- */
const TRANSFORMERS_CDN_URL = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

// Cosine-similarity thresholds (embeddings are normalized, so dot product
// IS cosine similarity). Tune these if matching feels too loose/strict.
const MATCH_THRESHOLD = 0.5;   // above this -> suggest filing into an existing pile
const SEARCH_THRESHOLD = 0.32; // below this -> "no strong match" fallback

const DB_NAME = 'looseLeafDB';
const DB_VERSION = 1;

const STOPWORDS = new Set(('a about above after again against all am an and any are as at be because '
  + 'been before being below between both but by could did do does doing down during each few for from '
  + 'further had has have having he her here hers herself him himself his how https http www com net org '
  + 'i if in into is it its itself just me more most my myself no nor not now of off on once only or other '
  + 'our ours ourselves out over own same she should so some such than that the their theirs them themselves '
  + 'then there these they this those through to too under until up very was we were what when where which '
  + 'while who whom why will with you your yours yourself yourselves this that these those been being have '
  + 'has had does did doing done also like get got make made one two into onto').split(/\s+/));

/* ---------------------------------------------------------
   Tiny state store
--------------------------------------------------------- */
const state = {
  notes: [],
  clusters: [],
  expanded: new Set(),
  pendingSave: null,
  lastSearch: null,      // { query, qEmbed, scored, primaryClusterId }
  initialExpandDone: false,
  editingNoteId: null,
};

let isModelReady = false;

/* ---------------------------------------------------------
   DOM refs
--------------------------------------------------------- */
const $ = (sel) => document.querySelector(sel);
const statusDot = $('#statusDot');
const statusText = $('#statusText');
const captureInput = $('#captureInput');
const captureHint = $('#captureHint');
const saveBtn = $('#saveBtn');
const suggestionPanel = $('#suggestionPanel');
const suggestionLabel = $('#suggestionLabel');
const clusterSelect = $('#clusterSelect');
const newClusterName = $('#newClusterName');
const tagPreview = $('#tagPreview');
const confirmSaveBtn = $('#confirmSaveBtn');
const cancelSaveBtn = $('#cancelSaveBtn');
const clusterListEl = $('#clusterList');
const browseEmpty = $('#browseEmpty');
const searchInput = $('#searchInput');
const searchBtn = $('#searchBtn');
const searchResultsEl = $('#searchResults');
const exportBtn = $('#exportBtn');
const importInput = $('#importInput');
const toastEl = $('#toast');

/* =========================================================
   IndexedDB layer
   ========================================================= */
let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('clusters')) db.createObjectStore('clusters', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getDB() {
  if (!dbInstance) dbInstance = await openDB();
  return dbInstance;
}

async function getStore(name, mode = 'readonly') {
  const db = await getDB();
  return db.transaction(name, mode).objectStore(name);
}

async function dbGetAll(name) {
  const store = await getStore(name);
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(name, obj) {
  const store = await getStore(name, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.put(obj);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbDelete(name, id) {
  const store = await getStore(name, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbClear(name) {
  const store = await getStore(name, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function dbBulkPut(name, items) {
  if (!items.length) return;
  const store = await getStore(name, 'readwrite');
  return new Promise((resolve, reject) => {
    let done = 0;
    items.forEach((item) => {
      const req = store.put(item);
      req.onsuccess = () => { done++; if (done === items.length) resolve(); };
      req.onerror = () => reject(req.error);
    });
  });
}

/* =========================================================
   Embedding model (loads once, then fully offline)
   ========================================================= */
let extractorPromise = null;
const fileProgress = new Map();

function setStatus(kind, text) {
  statusDot.className = 'status-dot' + (kind ? ` ${kind}` : '');
  statusText.textContent = text;
}

function onModelProgress(data) {
  if (data.status === 'progress' && typeof data.progress === 'number') {
    fileProgress.set(data.file, data.progress);
    const values = [...fileProgress.values()];
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    setStatus('loading', `Loading local model… ${Math.round(avg)}%`);
  }
}

async function ensureModel() {
  if (extractorPromise) return extractorPromise;
  extractorPromise = (async () => {
    setStatus('loading', 'Loading local model…');
    try {
      const mod = await import(/* webpackIgnore: true */ TRANSFORMERS_CDN_URL);
      mod.env.allowLocalModels = false;
      const extractor = await mod.pipeline('feature-extraction', EMBEDDING_MODEL, {
        progress_callback: onModelProgress,
      });
      isModelReady = true;
      setStatus('ready', 'Local model ready — everything below runs offline');
      refreshControlAvailability();
      return extractor;
    } catch (err) {
      console.error('Model failed to load', err);
      setStatus('error', 'Couldn\u2019t load the local model — check your connection, then reload the page');
      throw err;
    }
  })();
  return extractorPromise;
}

async function embed(text) {
  const extractor = await ensureModel();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

function dot(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/* =========================================================
   Lightweight keyword extraction (no AI needed for this part)
   ========================================================= */
function extractKeywords(text, max = 5) {
  const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
  const freq = new Map();
  const order = [];
  for (const w of words) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    if (!freq.has(w)) { freq.set(w, 0); order.push(w); }
    freq.set(w, freq.get(w) + 1);
  }
  if (order.length === 0) {
    const urlMatch = text.match(/https?:\/\/([^/\s]+)/i);
    if (urlMatch) return [urlMatch[1].replace(/^www\./, '').split('.')[0].toLowerCase()];
    return [];
  }
  return order.sort((a, b) => freq.get(b) - freq.get(a)).slice(0, max);
}

function titleCase(w) {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function autoName(keywords, text) {
  if (keywords.length > 0) return keywords.slice(0, 2).map(titleCase).join(' & ');
  const words = text.trim().split(/\s+/).slice(0, 5).join(' ');
  if (!words) return 'Untitled pile';
  return words.length > 40 ? words.slice(0, 40) + '\u2026' : words;
}

function aggregateTags(notes, max = 5) {
  const freq = new Map();
  for (const n of notes) for (const k of (n.keywords || [])) freq.set(k, (freq.get(k) || 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([k]) => k);
}

/* =========================================================
   Formatting helpers
   ========================================================= */
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function linkify(escapedStr) {
  return escapedStr.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
}

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toastEl.classList.add('hidden'), 2600);
}

/* =========================================================
   Rendering
   ========================================================= */
function clusterNotes(clusterId) {
  return state.notes
    .filter((n) => n.clusterId === clusterId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function clusterOptionsHtml(excludeId, extraTop) {
  // extraTop: optional {value, label} entries to place before the alphabetical list
  let html = '';
  if (extraTop) for (const opt of extraTop) html += `<option value="${opt.value}">${escapeHtml(opt.label)}</option>`;
  const rest = state.clusters
    .filter((c) => c.id !== excludeId)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const c of rest) html += `<option value="${c.id}">${escapeHtml(c.name)}</option>`;
  return html;
}

function buildNoteEl(note, { highlight = false } = {}) {
  const li = document.createElement('div');
  li.className = 'note-item' + (highlight ? ' just-saved' : '');
  li.dataset.noteId = note.id;

  if (state.editingNoteId === note.id) {
    const textarea = document.createElement('textarea');
    textarea.className = 'note-edit-textarea';
    textarea.value = note.text;
    textarea.rows = Math.min(10, Math.max(3, Math.ceil(note.text.length / 55)));

    const row = document.createElement('div');
    row.className = 'note-edit-row';

    const saveEditBtn = document.createElement('button');
    saveEditBtn.className = 'btn btn-primary';
    saveEditBtn.dataset.action = 'save-edit-note';
    saveEditBtn.dataset.noteId = note.id;
    saveEditBtn.textContent = 'Save changes';

    const cancelEditBtn = document.createElement('button');
    cancelEditBtn.className = 'btn btn-ghost';
    cancelEditBtn.dataset.action = 'cancel-edit-note';
    cancelEditBtn.dataset.noteId = note.id;
    cancelEditBtn.textContent = 'Cancel';

    row.append(saveEditBtn, cancelEditBtn);
    li.append(textarea, row);
    return li;
  }

  const textDiv = document.createElement('p');
  textDiv.className = 'note-text';
  textDiv.innerHTML = linkify(escapeHtml(note.text));

  const meta = document.createElement('div');
  meta.className = 'note-meta';

  const time = document.createElement('span');
  time.textContent = relativeTime(note.updatedAt || note.createdAt) + (note.updatedAt ? ' (edited)' : '');

  const editBtn = document.createElement('button');
  editBtn.className = 'btn-text';
  editBtn.dataset.action = 'edit-note';
  editBtn.dataset.noteId = note.id;
  editBtn.textContent = 'edit';

  const moveSelect = document.createElement('select');
  moveSelect.dataset.role = 'move-note';
  moveSelect.dataset.noteId = note.id;
  moveSelect.innerHTML = `<option value="${note.clusterId}">Move to\u2026</option>` + clusterOptionsHtml(note.clusterId);
  moveSelect.value = note.clusterId;

  const delBtn = document.createElement('button');
  delBtn.className = 'btn-text danger';
  delBtn.dataset.action = 'delete-note';
  delBtn.dataset.noteId = note.id;
  delBtn.textContent = 'delete';

  meta.append(time, editBtn, moveSelect, delBtn);
  li.append(textDiv, meta);
  return li;
}

function buildClusterBlock(cluster, { showManage = true, matchScore = null, forceExpanded = null, highlightNoteId = null } = {}) {
  const notes = clusterNotes(cluster.id);
  const expanded = forceExpanded !== null ? forceExpanded : state.expanded.has(cluster.id);

  const block = document.createElement('div');
  block.className = 'cluster-block';
  block.dataset.clusterId = cluster.id;

  const header = document.createElement('div');
  header.className = 'cluster-header';
  header.dataset.action = 'toggle-cluster';
  header.dataset.clusterId = cluster.id;

  const titleGroup = document.createElement('div');
  titleGroup.className = 'cluster-title-group';

  const name = document.createElement('h3');
  name.className = 'cluster-name';
  name.textContent = cluster.name;
  titleGroup.append(name);

  const count = document.createElement('span');
  count.className = 'cluster-count';
  count.textContent = notes.length === 1 ? '1 note' : `${notes.length} notes`;
  titleGroup.append(count);

  if (matchScore !== null) {
    const badge = document.createElement('span');
    badge.className = 'cluster-count';
    badge.textContent = `${Math.round(matchScore * 100)}% match`;
    titleGroup.append(badge);
  }

  const toggle = document.createElement('span');
  toggle.className = 'cluster-toggle';
  toggle.textContent = expanded ? '\u25be hide' : '\u25b8 show';

  header.append(titleGroup, toggle);
  block.append(header);

  const tags = aggregateTags(notes);
  if (tags.length) {
    const tagRow = document.createElement('div');
    tagRow.className = 'cluster-tags';
    for (const t of tags) {
      const chip = document.createElement('span');
      chip.className = 'tag';
      chip.textContent = t;
      tagRow.append(chip);
    }
    block.append(tagRow);
  }

  const notesWrap = document.createElement('div');
  notesWrap.className = 'cluster-notes' + (expanded ? '' : ' hidden');
  for (const n of notes) notesWrap.append(buildNoteEl(n, { highlight: n.id === highlightNoteId }));
  block.append(notesWrap);

  if (showManage) {
    const manage = document.createElement('div');
    manage.className = 'cluster-manage';

    const renameBtn = document.createElement('button');
    renameBtn.className = 'btn-text';
    renameBtn.dataset.action = 'rename-cluster';
    renameBtn.dataset.clusterId = cluster.id;
    renameBtn.textContent = 'rename';

    const moveAllSelect = document.createElement('select');
    moveAllSelect.dataset.role = 'move-all-select';
    moveAllSelect.dataset.clusterId = cluster.id;
    moveAllSelect.innerHTML = `<option value="">Move all notes to\u2026</option>`
      + clusterOptionsHtml(cluster.id, [{ value: '__new__', label: '\u2794 New pile\u2026' }]);

    const moveAllBtn = document.createElement('button');
    moveAllBtn.className = 'btn-text';
    moveAllBtn.dataset.action = 'move-all';
    moveAllBtn.dataset.clusterId = cluster.id;
    moveAllBtn.textContent = 'go';

    const delBtn = document.createElement('button');
    delBtn.className = 'btn-text danger';
    delBtn.dataset.action = 'delete-cluster';
    delBtn.dataset.clusterId = cluster.id;
    delBtn.textContent = 'delete pile';
    if (notes.length > 0) {
      delBtn.disabled = true;
      delBtn.title = 'Move or delete its notes first';
      delBtn.style.opacity = '0.4';
      delBtn.style.cursor = 'not-allowed';
    }

    manage.append(renameBtn, moveAllSelect, moveAllBtn, delBtn);
    block.append(manage);
  }

  return block;
}

function renderBrowseView(highlightNoteId = null) {
  clusterListEl.innerHTML = '';

  if (!state.initialExpandDone && state.clusters.length > 0) {
    const mostRecent = [...state.clusters].sort((a, b) => {
      const at = Math.max(0, ...clusterNotes(a.id).map((n) => n.createdAt));
      const bt = Math.max(0, ...clusterNotes(b.id).map((n) => n.createdAt));
      return bt - at;
    })[0];
    if (mostRecent) state.expanded.add(mostRecent.id);
    state.initialExpandDone = true;
  }

  if (highlightNoteId) {
    const note = state.notes.find((n) => n.id === highlightNoteId);
    if (note) state.expanded.add(note.clusterId);
  }

  browseEmpty.classList.toggle('hidden', state.clusters.length > 0);

  const sorted = [...state.clusters].sort((a, b) => {
    const at = Math.max(0, ...clusterNotes(a.id).map((n) => n.createdAt));
    const bt = Math.max(0, ...clusterNotes(b.id).map((n) => n.createdAt));
    return bt - at;
  });

  for (const cluster of sorted) {
    clusterListEl.append(buildClusterBlock(cluster, { highlightNoteId }));
  }
}

function renderSuggestion(suggestion) {
  const { keywords, matches, suggestedClusterId, suggestedName } = suggestion;

  if (matches.length > 0 && suggestedClusterId !== '__new__') {
    const top = matches[0];
    suggestionLabel.textContent = `Looks like it belongs with \u201c${top.name}\u201d (${Math.round(top.score * 100)}% match):`;
  } else if (state.clusters.length === 0) {
    suggestionLabel.textContent = 'This will start your first pile:';
  } else {
    suggestionLabel.textContent = 'Doesn\u2019t closely match an existing pile \u2014 start a new one, or pick one below:';
  }

  const topMatches = matches.slice(0, 3);
  const matchedIds = new Set(topMatches.map((m) => m.clusterId));

  const options = [{ value: '__new__', label: `\u2794 New pile: ${suggestedName}` }];
  for (const m of topMatches) options.push({ value: m.clusterId, label: `${m.name} (${Math.round(m.score * 100)}% match)` });
  const rest = state.clusters.filter((c) => !matchedIds.has(c.id)).sort((a, b) => a.name.localeCompare(b.name));
  for (const c of rest) options.push({ value: c.id, label: c.name });

  clusterSelect.innerHTML = options.map((o) => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
  clusterSelect.value = suggestedClusterId;
  newClusterName.classList.toggle('hidden', suggestedClusterId !== '__new__');
  newClusterName.value = suggestedClusterId === '__new__' ? suggestedName : '';

  tagPreview.innerHTML = keywords.map((k) => `<span class="tag">${escapeHtml(k)}</span>`).join('');

  suggestionPanel.classList.remove('hidden');
}

/* =========================================================
   Save flow
   ========================================================= */
function refreshControlAvailability() {
  const hasText = captureInput.value.trim().length > 0;
  saveBtn.disabled = !(isModelReady && hasText);
  searchBtn.disabled = !isModelReady;
  searchBtn.title = isModelReady ? '' : 'Loading local model\u2026';
}

captureInput.addEventListener('input', () => {
  captureHint.textContent = '';
  refreshControlAvailability();
});

captureInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!saveBtn.disabled) saveBtn.click();
  }
});

saveBtn.addEventListener('click', async () => {
  const text = captureInput.value.trim();
  if (!text) return;

  saveBtn.disabled = true;
  captureHint.textContent = 'Thinking about where this belongs\u2026';

  try {
    const embedding = await embed(text);
    const keywords = extractKeywords(text);

    const bestByCluster = new Map();
    for (const n of state.notes) {
      const score = dot(embedding, n.embedding);
      if (!bestByCluster.has(n.clusterId) || score > bestByCluster.get(n.clusterId)) {
        bestByCluster.set(n.clusterId, score);
      }
    }
    const matches = [...bestByCluster.entries()]
      .map(([clusterId, score]) => ({ clusterId, score, name: state.clusters.find((c) => c.id === clusterId)?.name || 'Untitled pile' }))
      .sort((a, b) => b.score - a.score);

    const top = matches[0];
    const suggestedClusterId = top && top.score >= MATCH_THRESHOLD ? top.clusterId : '__new__';
    const suggestedName = autoName(keywords, text);

    state.pendingSave = { text, embedding, keywords };
    renderSuggestion({ keywords, matches, suggestedClusterId, suggestedName });
  } catch (err) {
    // ensureModel() already surfaced a status message; nothing else to do here.
  } finally {
    captureHint.textContent = '';
    refreshControlAvailability();
  }
});

clusterSelect.addEventListener('change', () => {
  const isNew = clusterSelect.value === '__new__';
  newClusterName.classList.toggle('hidden', !isNew);
  if (isNew && !newClusterName.value) newClusterName.value = autoName(state.pendingSave?.keywords || [], state.pendingSave?.text || '');
});

confirmSaveBtn.addEventListener('click', async () => {
  if (!state.pendingSave) return;
  const { text, embedding, keywords } = state.pendingSave;
  let clusterId = clusterSelect.value;
  let clusterName;

  if (clusterId === '__new__') {
    clusterName = newClusterName.value.trim() || 'Untitled pile';
    clusterId = crypto.randomUUID();
    const cluster = { id: clusterId, name: clusterName };
    state.clusters.push(cluster);
    await dbPut('clusters', cluster);
  } else {
    clusterName = state.clusters.find((c) => c.id === clusterId)?.name || 'that pile';
  }

  const note = { id: crypto.randomUUID(), text, clusterId, keywords, embedding, createdAt: Date.now() };
  state.notes.push(note);
  await dbPut('notes', note);

  captureInput.value = '';
  suggestionPanel.classList.add('hidden');
  state.pendingSave = null;
  refreshControlAvailability();

  renderBrowseView(note.id);
  showToast(`Saved to \u201c${clusterName}\u201d.`);
});

cancelSaveBtn.addEventListener('click', () => {
  suggestionPanel.classList.add('hidden');
  state.pendingSave = null;
});

/* =========================================================
   Note & cluster interactions (shared between Browse and Search)
   ========================================================= */
function focusEditTextareaIfNeeded() {
  if (!state.editingNoteId) return;
  const ta = document.querySelector(`.view:not(.hidden) .note-item[data-note-id="${state.editingNoteId}"] .note-edit-textarea`);
  if (ta) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
}

async function handleNoteAreaClick(e) {
  const toggleHeader = e.target.closest('[data-action="toggle-cluster"]');
  if (toggleHeader) {
    const id = toggleHeader.dataset.clusterId;
    if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
    renderBrowseView();
    return;
  }

  const renameBtn = e.target.closest('[data-action="rename-cluster"]');
  if (renameBtn) {
    const id = renameBtn.dataset.clusterId;
    const cluster = state.clusters.find((c) => c.id === id);
    const next = prompt('Rename this pile:', cluster.name);
    if (next && next.trim()) {
      cluster.name = next.trim();
      await dbPut('clusters', cluster);
      renderBrowseView();
      refreshSearchCache();
    }
    return;
  }

  const moveAllBtn = e.target.closest('[data-action="move-all"]');
  if (moveAllBtn) {
    const sourceId = moveAllBtn.dataset.clusterId;
    const select = document.querySelector(`select[data-role="move-all-select"][data-cluster-id="${sourceId}"]`);
    const target = select.value;
    if (!target) return;
    let targetId = target;
    if (target === '__new__') {
      const name = prompt('Name the new pile:');
      if (!name || !name.trim()) return;
      targetId = crypto.randomUUID();
      const cluster = { id: targetId, name: name.trim() };
      state.clusters.push(cluster);
      await dbPut('clusters', cluster);
    }
    const toMove = state.notes.filter((n) => n.clusterId === sourceId);
    for (const n of toMove) { n.clusterId = targetId; await dbPut('notes', n); }
    state.expanded.add(targetId);
    renderBrowseView();
    refreshSearchCache();
    showToast(`Moved ${toMove.length} note${toMove.length === 1 ? '' : 's'}.`);
    return;
  }

  const delClusterBtn = e.target.closest('[data-action="delete-cluster"]');
  if (delClusterBtn && !delClusterBtn.disabled) {
    const id = delClusterBtn.dataset.clusterId;
    if (!confirm('Delete this empty pile?')) return;
    state.clusters = state.clusters.filter((c) => c.id !== id);
    await dbDelete('clusters', id);
    renderBrowseView();
    refreshSearchCache();
    return;
  }

  const delNoteBtn = e.target.closest('[data-action="delete-note"]');
  if (delNoteBtn) {
    const id = delNoteBtn.dataset.noteId;
    if (!confirm('Delete this note?')) return;
    state.notes = state.notes.filter((n) => n.id !== id);
    await dbDelete('notes', id);
    renderBrowseView();
    refreshSearchCache();
    return;
  }

  const editBtn = e.target.closest('[data-action="edit-note"]');
  if (editBtn) {
    state.editingNoteId = editBtn.dataset.noteId;
    renderBrowseView();
    refreshSearchCache();
    focusEditTextareaIfNeeded();
    return;
  }

  const cancelEditBtn = e.target.closest('[data-action="cancel-edit-note"]');
  if (cancelEditBtn) {
    state.editingNoteId = null;
    renderBrowseView();
    refreshSearchCache();
    return;
  }

  const saveEditBtn = e.target.closest('[data-action="save-edit-note"]');
  if (saveEditBtn) {
    const noteId = saveEditBtn.dataset.noteId;
    const container = saveEditBtn.closest('.note-item');
    const textarea = container?.querySelector('.note-edit-textarea');
    const newText = textarea?.value.trim();
    if (!newText) {
      alert('A note can\u2019t be empty.');
      return;
    }
    const note = state.notes.find((n) => n.id === noteId);
    if (!note) return;

    saveEditBtn.disabled = true;
    saveEditBtn.textContent = 'Saving\u2026';
    try {
      const embedding = await embed(newText);
      const keywords = extractKeywords(newText);
      note.text = newText;
      note.embedding = embedding;
      note.keywords = keywords;
      note.updatedAt = Date.now();
      await dbPut('notes', note);
      state.editingNoteId = null;
      renderBrowseView(note.id);
      refreshSearchCache();
      showToast('Note updated.');
    } catch (err) {
      console.error('Failed to save edited note', err);
      alert('Couldn\u2019t update the note \u2014 try again.');
      saveEditBtn.disabled = false;
      saveEditBtn.textContent = 'Save changes';
    }
    return;
  }
}

async function handleNoteAreaChange(e) {
  const moveSelect = e.target.closest('[data-role="move-note"]');
  if (moveSelect) {
    const noteId = moveSelect.dataset.noteId;
    const newClusterId = moveSelect.value;
    const note = state.notes.find((n) => n.id === noteId);
    if (note && newClusterId && newClusterId !== note.clusterId) {
      note.clusterId = newClusterId;
      await dbPut('notes', note);
      state.expanded.add(newClusterId);
      renderBrowseView();
      refreshSearchCache();
      showToast('Note moved.');
    }
  }
}

clusterListEl.addEventListener('click', handleNoteAreaClick);
clusterListEl.addEventListener('change', handleNoteAreaChange);
searchResultsEl.addEventListener('click', handleNoteAreaClick);
searchResultsEl.addEventListener('change', handleNoteAreaChange);

/* =========================================================
   Search
   ========================================================= */
async function runSearch(query) {
  if (!query.trim()) return;
  searchResultsEl.innerHTML = '<p class="empty-state">Searching\u2026</p>';

  if (state.notes.length === 0) {
    searchResultsEl.innerHTML = '<p class="empty-state">Nothing saved yet.</p>';
    return;
  }

  const qEmbed = await embed(query);
  const scored = state.notes
    .map((n) => ({ note: n, score: dot(qEmbed, n.embedding) }))
    .sort((a, b) => b.score - a.score);

  state.lastSearch = { query, qEmbed, scored, primaryClusterId: scored[0]?.note.clusterId ?? null };
  renderSearchFromCache();
}

function refreshSearchCache() {
  if (!state.lastSearch) return;
  const { qEmbed } = state.lastSearch;
  state.lastSearch.scored = state.notes
    .map((n) => ({ note: n, score: dot(qEmbed, n.embedding) }))
    .sort((a, b) => b.score - a.score);
  renderSearchFromCache();
}

function renderSearchFromCache() {
  if (!state.lastSearch) return;
  const { primaryClusterId } = state.lastSearch;
  // Drop any cached results for notes that have since been deleted.
  const scored = state.lastSearch.scored.filter((s) => state.notes.includes(s.note));
  searchResultsEl.innerHTML = '';

  if (scored.length === 0) {
    searchResultsEl.innerHTML = '<p class="empty-state">Nothing left to show for that search.</p>';
    return;
  }

  const topScore = scored[0]?.score ?? 0;

  if (topScore < SEARCH_THRESHOLD) {
    const p = document.createElement('p');
    p.className = 'empty-state';
    p.textContent = 'No strong match. Here are the closest individual notes:';
    searchResultsEl.append(p);
    for (const { note, score } of scored.slice(0, 5)) {
      const clusterName = state.clusters.find((c) => c.id === note.clusterId)?.name || 'Untitled pile';
      const wrap = document.createElement('div');
      wrap.style.marginBottom = '14px';
      const label = document.createElement('div');
      label.className = 'cluster-count';
      label.textContent = `in \u201c${clusterName}\u201d \u2014 ${Math.round(score * 100)}% match`;
      wrap.append(label, buildNoteEl(note));
      searchResultsEl.append(wrap);
    }
    return;
  }

  const cluster = state.clusters.find((c) => c.id === primaryClusterId);
  if (!cluster) return;
  const primaryEntry = scored.find((s) => s.note.clusterId === primaryClusterId);
  searchResultsEl.append(buildClusterBlock(cluster, { showManage: false, matchScore: primaryEntry?.score ?? null, forceExpanded: true }));

  const others = [];
  const seen = new Set([primaryClusterId]);
  for (const { note } of scored) {
    if (!seen.has(note.clusterId)) {
      seen.add(note.clusterId);
      const c = state.clusters.find((cc) => cc.id === note.clusterId);
      if (c) others.push(c);
    }
    if (others.length >= 3) break;
  }

  if (others.length) {
    const altWrap = document.createElement('div');
    altWrap.className = 'search-alt';
    altWrap.textContent = 'Not what you meant? ';
    for (const c of others) {
      const btn = document.createElement('button');
      btn.textContent = c.name;
      btn.addEventListener('click', () => {
        state.lastSearch.primaryClusterId = c.id;
        renderSearchFromCache();
      });
      altWrap.append(btn, document.createTextNode('  '));
    }
    searchResultsEl.append(altWrap);
  }
}

searchBtn.addEventListener('click', () => runSearch(searchInput.value));
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(searchInput.value); });

/* =========================================================
   Tabs
   ========================================================= */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');
    const view = btn.dataset.view;
    $('#view-browse').classList.toggle('hidden', view !== 'browse');
    $('#view-search').classList.toggle('hidden', view !== 'search');
  });
});

/* =========================================================
   Export / Import
   ========================================================= */
exportBtn.addEventListener('click', () => {
  const data = { version: 1, exportedAt: Date.now(), clusters: state.clusters, notes: state.notes };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `looseleaf-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

importInput.addEventListener('change', async () => {
  const file = importInput.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data.notes) || !Array.isArray(data.clusters)) throw new Error('Not a Loose Leaf backup file');
    if (!confirm(`This will replace everything currently saved (${state.notes.length} notes) with the backup (${data.notes.length} notes). Continue?`)) {
      importInput.value = '';
      return;
    }
    await dbClear('notes');
    await dbClear('clusters');
    await dbBulkPut('clusters', data.clusters);
    await dbBulkPut('notes', data.notes);
    state.notes = data.notes;
    state.clusters = data.clusters;
    state.expanded = new Set();
    state.initialExpandDone = false;
    state.lastSearch = null;
    searchResultsEl.innerHTML = '';
    renderBrowseView();
    showToast('Backup imported.');
  } catch (err) {
    alert('Couldn\u2019t read that file: ' + err.message);
  } finally {
    importInput.value = '';
  }
});

/* =========================================================
   Init
   ========================================================= */
async function init() {
  refreshControlAvailability();
  try {
    const [notes, clusters] = await Promise.all([dbGetAll('notes'), dbGetAll('clusters')]);
    state.notes = notes;
    state.clusters = clusters;
    renderBrowseView();
  } catch (err) {
    console.error('Failed to load local data', err);
  }
  ensureModel(); // kick off in the background; UI unlocks via refreshControlAvailability()
}

init();
