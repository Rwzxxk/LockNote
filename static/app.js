'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const ICONS = {
  text: '<svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>',
  code: '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
  folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m5 4v6m4-6v6"/></svg>',
  calendar: '<svg viewBox="0 0 24 24"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h18"/></svg>',
};

const LANG_NAMES = {
  bash: 'Bash', c: 'C', cpp: 'C++', csharp: 'C#', css: 'CSS', go: 'Go', haskell: 'Haskell',
  java: 'Java', javascript: 'JavaScript', json: 'JSON', kotlin: 'Kotlin', markdown: 'Markdown',
  php: 'PHP', powershell: 'PowerShell', python: 'Python', ruby: 'Ruby', rust: 'Rust', sql: 'SQL',
  swift: 'Swift', typescript: 'TypeScript', xml: 'HTML/XML', yaml: 'YAML',
};
const langName = (l) => LANG_NAMES[l] || (l ? l : '');

// ---------- API ----------
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const error = await res.json().catch(() => null);
    throw new Error(error?.error || `${method} ${url}: ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}
const api = {
  list: (q) => request('GET', '/api/notes' + (q ? '?q=' + encodeURIComponent(q) : '')),
  create: (n) => request('POST', '/api/notes', n),
  update: (id, n) => request('PUT', `/api/notes/${id}`, n),
  remove: (id) => request('DELETE', `/api/notes/${id}`),
  folders: () => request('GET', '/api/folders'),
  createFolder: (name, color) => request('POST', '/api/folders', { name, color }),
  updateFolder: (id, name, color) => request('PUT', `/api/folders/${id}`, { name, color }),
  removeFolder: (id) => request('DELETE', `/api/folders/${id}`),
  folderNotes: (id) => request('GET', `/api/folders/${id}/notes`),
  moveNote: (id, folderId) => request('PUT', `/api/notes/${id}/folder`, { folderId }),
  pinNote: (id, pinned) => request('PUT', `/api/notes/${id}/pin`, { pinned }),
};

// ---------- Estado ----------
const state = {
  notes: [],
  current: null,   // nota aberta (cópia local editável)
  split: null,
  openFolder: null,
  noteFolderOrigin: null,
  filter: 'all',
  query: '',
  saveTimer: null,
  saveInFlight: null,
  dirty: false,
  lineCount: 0,
};
let draggedNoteId = null;
let listNeedsRender = false;

const el = {
  app: $('#app'),
  list: $('#note-list'),
  search: $('#search'),
  empty: $('#empty'),
  foldersView: $('#folders-view'),
  noteFolderBack: $('#note-folder-back'),
  editor: $('#editor'),
  tools: $('#note-tools'),
  statusbar: $('#statusbar'),
  title: $('#title'),
  content: $('#content'),
  sheet: $('#sheet'),
  gutter: $('#gutter'),
  hl: $('#highlight'),
  hlCode: $('#highlight code'),
  codeLang: $('#code-lang'),
  metaKind: $('#meta-kind'),
  metaCreated: $('#meta-created'),
  metaUpdated: $('#meta-updated'),
  pinNote: $('#pin-note'),
  pinLabel: $('#pin-note-label'),
  crumbKind: $('#crumb-kind'),
  crumbSep2: $('#crumb-sep2'),
  crumbTitle: $('#crumb-title'),
  saveState: $('#save-state'),
  statusText: $('#status-text'),
  stats: $('#stats'),
  statLang: $('#stat-lang'),
  total: $('#total'),
  toast: $('#toast'),
};

// ---------- Utilidades ----------
const isMobile = () => matchMedia('(max-width: 860px)').matches;

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* armazenamento indisponível: ignora */ }
  return null;
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 1800);
}

function relTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 7 * 86400) return d.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '');
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }).replace('.', '');
}

function fullDate(iso) {
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  }).replace('.', '');
}

function groupOf(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const days = Math.round((today - day) / 86400000);
  if (days <= 0) return 'Hoje';
  if (days === 1) return 'Ontem';
  if (days < 7) return 'Últimos 7 dias';
  if (days < 30) return 'Últimos 30 dias';
  return 'Mais antigas';
}

function firstLine(s) {
  return (s.split('\n').find((l) => l.trim()) || '').trim().slice(0, 120);
}

// ---------- Barra lateral ----------
function toggleSidebar(force) {
  if (isMobile()) {
    const open = force ?? !el.app.classList.contains('drawer-open');
    el.app.classList.toggle('drawer-open', open);
  } else {
    const collapsed = force === undefined ? !el.app.classList.contains('sidebar-collapsed') : !force;
    el.app.classList.toggle('sidebar-collapsed', collapsed);
    store('locknote.sidebarCollapsed', collapsed ? '1' : '0');
  }
}
function closeDrawer() { el.app.classList.remove('drawer-open'); }

function renderCounts() {
  const all = state.notes.length;
  const code = state.notes.filter((n) => n.kind === 'code').length;
  $('[data-count="all"]').textContent = all;
  $('[data-count="text"]').textContent = all - code;
  $('[data-count="code"]').textContent = code;
  if (!state.query) el.total.textContent = `${all} ${all === 1 ? 'nota' : 'notas'}`;
}

function renderList() {
  if (draggedNoteId !== null) {
    listNeedsRender = true;
    return;
  }
  renderCounts();
  const items = state.notes.filter((n) => state.filter === 'all' || n.kind === state.filter);
  items.sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
    || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || b.id - a.id);
  el.list.replaceChildren();

  if (!items.length) {
    const p = document.createElement('div');
    p.className = 'list-empty';
    p.textContent = state.query ? `Nada encontrado para “${state.query}”.` : 'Nenhuma nota por aqui ainda.';
    el.list.append(p);
    return;
  }

  let lastGroup = null;
  for (const n of items) {
    const group = n.pinned ? 'Fixados' : groupOf(n.updatedAt);
    if (group !== lastGroup) {
      const g = document.createElement('div');
      g.className = 'group-label';
      g.textContent = group;
      el.list.append(g);
      lastGroup = group;
    }

    const item = document.createElement('button');
    item.className = 'note-item';
    item.draggable = true;
    if (state.current && state.current.id === n.id) item.classList.add('active');

    const icon = document.createElement('span');
    icon.className = 'ni-icon' + (n.kind === 'code' ? ' code' : '');
    icon.innerHTML = ICONS[n.kind] || ICONS.text;

    const body = document.createElement('span');
    body.className = 'ni-body';

    const row = document.createElement('span');
    row.className = 'ni-row';
    const title = document.createElement('span');
    title.className = 'ni-title' + (n.title ? '' : ' untitled');
    title.textContent = n.title || 'Sem título';
    const time = document.createElement('span');
    time.className = 'ni-time';
    time.textContent = relTime(n.updatedAt);
    row.append(title, time);

    const snippet = document.createElement('span');
    snippet.className = 'ni-snippet' + (n.kind === 'code' ? ' mono' : '');
    snippet.textContent = firstLine(n.content) || 'Vazia';

    body.append(row, snippet);
    if (n.kind === 'code' && n.language) {
      const tag = document.createElement('span');
      tag.className = 'ni-tag';
      tag.textContent = langName(n.language);
      body.append(tag);
    }

    item.append(icon, body);
    item.addEventListener('click', () => openNote(n.id));
    item.addEventListener('dragstart', (event) => {
      if (!state.current || state.current.id === n.id) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-locknote-note', String(n.id));
      draggedNoteId = n.id;
      splitDropTargets.hidden = false;
      closeDrawer();
    });
    item.addEventListener('dragend', clearSplitDrag);
    el.list.append(item);
  }
}

async function loadNotes() {
  try {
    state.notes = await api.list(state.query);
  } catch (e) {
    console.error(e);
    state.notes = [];
    toast('Não foi possível carregar as notas');
  }
  if (state.query) {
    el.total.textContent = `${state.notes.length} resultado${state.notes.length === 1 ? '' : 's'}`;
  }
  renderList();
}

// ---------- Detecção de linguagem ----------
// Linguagens consideradas na detecção estatística do highlight.js
const LANGS = Object.keys(LANG_NAMES);

// Sinais fortes, testados em ordem antes do palpite estatístico (que erra em trechos curtos)
const RULES = [
  ['bash',       /^#!.*\b(ba|z)?sh\b/],
  ['python',     /^#!.*python/],
  ['php',        /<\?php/],
  ['xml',        /^\s*<(!doctype|html|\?xml|[a-z][\w-]*[\s>])/i],
  ['go',         /^\s*package\s+\w+\s*$[\s\S]*\bfunc\b/m],
  ['rust',       /\bfn\s+\w+\s*\(|\blet\s+mut\b|\w+!\(|\bimpl\b.*\{/],
  ['java',       /\bpublic\s+(static\s+)?(class|void)\b|System\.out\./],
  ['csharp',     /\busing\s+System\b|\bnamespace\s+[\w.]+|Console\.Write/],
  ['cpp',        /#include\s*<(iostream|vector|string|map)>|\bstd::/],
  ['c',          /#include\s*[<"]/],
  ['haskell',    /^\w+\s*::\s*.+->|^\s*(module\s+[A-Z][\w.]*|import\s+(qualified\s+)?[A-Z][\w.]*)|^main\s*=\s*do\b|\bwhere\s*$/m],
  ['sql',        /^\s*(select|insert\s+into|update\s+\w+\s+set|delete\s+from|create\s+(table|index|view)|alter\s+table|with\s+\w+\s+as)\b/im],
  ['python',     /^\s*(def\s+\w+\s*\(.*\)\s*(->.*)?:|class\s+\w+.*:\s*$|from\s+[\w.]+\s+import\b|import\s+[\w.]+\s*$|if\s+__name__\s*==)|\bprint\(|\belif\b|\bself\./m],
  ['powershell', /^\s*\$\w+\s*=|\b(Get|Set|New|Remove|Write)-[A-Z]\w+/m],
  ['typescript', /\binterface\s+\w+\s*\{|:\s*(string|number|boolean)\b|\btype\s+\w+\s*=/],
  ['javascript', /\b(const|let|var)\s+\w+\s*=|=>|\bfunction\b|console\.log|document\.|require\(/],
  ['css',        /^\s*[.#@]?[\w-]+[^{]*\{\s*[\w-]+\s*:/m],
  ['yaml',       /^[\w-]+:\s*.*$\n^\s+[\w-]+:/m],
];

function detectLanguage(text) {
  const t = text.trim();
  if (!t || !window.hljs) return '';
  if (/^[{[]/.test(t)) {
    try { JSON.parse(t); return 'json'; } catch { /* não é JSON */ }
  }
  for (const [lang, re] of RULES) {
    if (re.test(t) && hljs.getLanguage(lang)) return lang;
  }
  const subset = LANGS.filter((l) => hljs.getLanguage(l));
  return hljs.highlightAuto(t, subset).language || '';
}

// ---------- Editor ----------
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderHighlight() {
  if (!state.current || state.current.kind !== 'code') return;
  const text = el.content.value;
  const lang = detectLanguage(text);
  // linha extra para o <pre> acompanhar o cursor na última linha vazia
  el.hlCode.innerHTML = highlightedCode(text, lang) + '\n';
  state.current.language = lang;
  el.codeLang.textContent = lang ? langName(lang) : (text.trim() ? 'texto simples' : 'detectando…');
  renderGutter();
  syncScroll();
}

function highlightedCode(text, language) {
  return language && window.hljs?.getLanguage(language)
    ? hljs.highlight(text, { language, ignoreIllegals: true }).value
    : escapeHtml(text);
}

function renderGutter() {
  const lines = el.content.value.split('\n').length;
  if (lines === state.lineCount) return;
  state.lineCount = lines;
  let s = '';
  for (let i = 1; i <= lines; i++) s += i + '\n';
  el.gutter.textContent = s;
}

function syncScroll() {
  el.hl.scrollTop = el.content.scrollTop;
  el.hl.scrollLeft = el.content.scrollLeft;
  el.gutter.scrollTop = el.content.scrollTop;
}

function renderMeta() {
  const c = state.current;
  if (!c) return;
  el.pinNote.dataset.pinned = Boolean(c.pinned);
  el.pinLabel.textContent = c.pinned ? 'Desafixar' : 'Fixar';
  const isCode = c.kind === 'code';

  el.metaKind.className = 'pill' + (isCode ? ' code' : '');
  el.metaKind.innerHTML = ICONS[c.kind];
  el.metaKind.append(isCode ? (c.language ? `Código · ${langName(c.language)}` : 'Código') : 'Texto');

  el.metaCreated.innerHTML = ICONS.calendar;
  el.metaCreated.append(`Criada em ${fullDate(c.createdAt)}`);
  el.metaUpdated.innerHTML = ICONS.clock;
  el.metaUpdated.append(`Editada ${relTime(c.updatedAt) === 'agora' ? 'agora' : 'há ' + relTime(c.updatedAt)}`);

  el.crumbKind.textContent = isCode ? 'Código' : 'Texto';
  el.crumbSep2.hidden = false;
  el.crumbTitle.textContent = c.title || 'Sem título';
}

function renderStats() {
  const c = state.current;
  if (!c) return;
  const text = el.content.value;
  const chars = text.length.toLocaleString('pt-BR');
  if (c.kind === 'code') {
    el.stats.textContent = `${text.split('\n').length} linhas · ${chars} caracteres`;
    el.statLang.textContent = c.language ? langName(c.language) : '';
  } else {
    const words = (text.match(/\S+/g) || []).length;
    const mins = Math.max(1, Math.round(words / 200));
    el.stats.textContent = `${words.toLocaleString('pt-BR')} palavras · ${chars} caracteres · ${mins} min de leitura`;
    el.statLang.textContent = '';
  }
}

function applyKind() {
  const isCode = state.current.kind === 'code';
  $$('.kind-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.current.kind));
  el.sheet.classList.toggle('code', isCode);
  el.content.spellcheck = !isCode;
  el.content.placeholder = isCode ? '// cole ou escreva seu código — a linguagem é detectada sozinha' : 'Comece a escrever…';
  state.lineCount = 0;
  renderHighlight();
  renderMeta();
  renderStats();
}

const splitPreview = $('#split-preview');
const splitCloseCurrent = $('#split-close-current');
const deleteButton = $('#delete');
const splitContent = $('#split-content');
const splitDialog = $('#split-dialog');
const splitChoice = $('#split-choice');
const splitSubmit = $('#split-submit');
const splitMessage = $('#split-message');
const splitDropTargets = $('#split-drop-targets');
let splitRequest = 0;

function clearSplitDrag() {
  draggedNoteId = null;
  splitDropTargets.hidden = true;
  splitDropTargets.querySelector('.drop-active')?.classList.remove('drop-active');
  if (listNeedsRender) {
    listNeedsRender = false;
    renderList();
  }
}

for (const target of splitDropTargets.children) {
  target.addEventListener('dragover', (event) => {
    if (draggedNoteId === null || !state.current || state.current.id === draggedNoteId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    target.classList.add('drop-active');
  });
  target.addEventListener('dragleave', () => target.classList.remove('drop-active'));
  target.addEventListener('drop', (event) => {
    const id = draggedNoteId;
    if (id === null || event.dataTransfer.getData('application/x-locknote-note') !== String(id)) return;
    event.preventDefault();
    const existing = state.split?.note.id === id ? state.split : null;
    const note = existing?.note ?? state.notes.find((item) => item.id === id);
    if (note && state.current && state.current.id !== id) {
      state.split = { note, folder: existing?.folder ?? null, reversed: target.dataset.splitSide === 'start' };
      renderSplit();
    }
    clearSplitDrag();
  });
}

function renderSplit() {
  const split = state.split;
  splitPreview.hidden = !split;
  splitCloseCurrent.hidden = !split;
  deleteButton.hidden = Boolean(split);
  splitPreview.parentElement.classList.toggle('split-view', Boolean(split));
  splitPreview.parentElement.classList.toggle('split-reversed', Boolean(split?.reversed));
  if (!split) return;
  const { note } = split;
  const code = note.kind === 'code';
  $('#split-preview-title').textContent = note.title || 'Sem título';
  const kind = $('#split-kind');
  kind.classList.toggle('code', code);
  kind.innerHTML = ICONS[note.kind];
  kind.append(code ? 'Código' : 'Texto');
  $('#split-sheet').classList.toggle('code', code);
  $('#split-language').textContent = langName(note.language) || 'texto simples';
  splitContent.firstElementChild.innerHTML = code
    ? highlightedCode(note.content, note.language)
    : escapeHtml(note.content);
  splitContent.scrollTop = 0;
  splitContent.scrollLeft = 0;
}

$('#split-note').addEventListener('click', async () => {
  const requestId = ++splitRequest;
  const current = state.current;
  const form = $('#split-form');
  form.onsubmit = (event) => event.preventDefault();
  splitChoice.replaceChildren();
  splitSubmit.disabled = true;
  splitMessage.textContent = 'Carregando notas…';
  splitDialog.showModal();
  try {
    const notes = await api.list();
    if (!splitDialog.open || requestId !== splitRequest || state.current !== current) return;
    for (const note of notes) {
      if (note.id === current.id) continue;
      const kind = note.kind === 'code' ? 'Código' : 'Nota';
      splitChoice.add(new Option(`${note.title || 'Sem título'} · ${kind}`, note.id));
    }
    const previous = notes.find((note) => note.id === state.split?.note.id);
    if (previous) splitChoice.value = String(previous.id);
    splitSubmit.disabled = !splitChoice.options.length;
    splitMessage.textContent = splitSubmit.disabled ? 'Crie outra nota ou código para dividir a tela.' : '';
    form.onsubmit = (event) => {
      event.preventDefault();
      const note = notes.find((item) => item.id === Number(splitChoice.value));
      if (!note || note.id === state.current?.id || state.current !== current) return;
      state.split = { note, folder: null, reversed: state.split?.reversed ?? false };
      renderSplit();
      splitDialog.close();
    };
  } catch {
    if (splitDialog.open && requestId === splitRequest) {
      splitMessage.textContent = 'Não foi possível carregar as notas.';
    }
  }
});

$('#split-cancel').addEventListener('click', () => splitDialog.close());
$('#split-close').addEventListener('click', () => {
  state.split = null;
  renderSplit();
  $('#split-note').focus();
});
splitCloseCurrent.addEventListener('click', async () => {
  const split = state.split;
  if (!split) return;
  const navigation = ++folderNavigation;
  if (!await flushSave() || navigation !== folderNavigation || state.split !== split) return;
  state.split = null;
  renderSplit();
  displayNote(split.note, split.folder);
  $('#split-note').focus();
});
$('#split-edit').addEventListener('click', async () => {
  const id = state.split.note.id;
  await openNote(id);
  if (state.current?.id === id) el.content.focus();
});

function showEditor(show) {
  if (!show) {
    clearSplitDrag();
    state.split = null;
    renderSplit();
  }
  el.foldersView.hidden = true;
  el.empty.hidden = show;
  el.editor.hidden = !show;
  el.tools.hidden = !show;
  el.statusbar.hidden = !show;
  el.noteFolderBack.hidden = !show || !state.noteFolderOrigin;
  if (!show) {
    el.crumbKind.textContent = 'Notas';
    el.crumbSep2.hidden = true;
    el.crumbTitle.textContent = '';
  }
}

let folderNavigation = 0;

async function openNote(id, { note, folder } = {}) {
  const navigation = ++folderNavigation;
  if (!await flushSave() || navigation !== folderNavigation) return;
  const split = state.split;
  const swapping = split?.note.id === id;
  const n = swapping ? split.note : note || state.notes.find((x) => x.id === id);
  if (!n) return;
  if (swapping) {
    state.split = { note: state.current, folder: state.noteFolderOrigin, reversed: !split.reversed };
    folder ??= split.folder;
    renderSplit();
  }
  displayNote(n, folder);
}

function displayNote(n, folder) {
  state.current = { ...n };
  state.noteFolderOrigin = folder || null;
  el.title.value = n.title;
  el.content.value = n.content;
  el.content.scrollTop = 0;
  setSaveState('saved');
  showEditor(true);
  applyKind();
  renderList();
  closeDrawer();
}

async function newNote(kind) {
  const folder = el.foldersView.hidden ? null : state.openFolder;
  const folderId = folder?.id ?? null;
  if (!await flushSave()) return;
  try {
    const n = await api.create({ title: '', content: '', kind, language: '', folderId });
    state.notes.unshift(n);
    if (state.filter !== 'all' && state.filter !== kind) setFilter('all');
    await openNote(n.id, { note: n, folder });
    if (state.current?.id === n.id) el.title.focus();
  } catch (e) {
    toast('Não foi possível criar a nota');
  }
}

const folderForm = $('#folder-form');
const folderFormButton = $('#show-folder-form');
const editFolderButton = $('#edit-folder');
const folderColorPreview = $('#folder-color-preview');
const folderSubmit = folderForm.querySelector('[type="submit"]');
const folderGrid = $('#folders-grid');
const folderEmpty = $('#folders-empty');
const folderError = $('#folder-error');
const folderBack = $('#folder-back');
const folderTitle = $('#folders-title');

function addFolderCard(icon, title, subtitle, onClick, folder) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'folder-card';
  card.innerHTML = icon;
  const label = document.createElement('strong');
  const details = document.createElement('small');
  label.textContent = title;
  details.textContent = subtitle;
  card.append(label, details);
  card.addEventListener('click', onClick);
  if (!folder) {
    folderGrid.append(card);
    return;
  }
  card.dataset.color = folder.color || 'default';
  const item = document.createElement('div');
  item.className = 'folder-grid-item';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'icon-btn danger-action folder-grid-remove';
  remove.title = 'Remover pasta';
  remove.setAttribute('aria-label', `Remover pasta ${folder.name}`);
  remove.setAttribute('aria-haspopup', 'dialog');
  remove.innerHTML = ICONS.trash;
  remove.addEventListener('click', () => openRemoveFolderDialog(folder));
  item.append(card, remove);
  folderGrid.append(item);
}

async function openFolders(folder = null) {
  const navigation = ++folderNavigation;
  try {
    const items = await (folder ? api.folderNotes(folder.id) : api.folders());
    if (navigation !== folderNavigation || !await flushSave() || navigation !== folderNavigation) return;
    state.openFolder = folder;
    state.current = null;
    state.noteFolderOrigin = null;
    showEditor(false);
    el.empty.hidden = true;
    el.foldersView.hidden = false;
    el.crumbKind.textContent = folder?.name || 'Pastas';
    folderTitle.textContent = folder?.name || 'Pastas';
    folderBack.hidden = !folder;
    folderFormButton.hidden = Boolean(folder);
    $('#folder-actions').hidden = !folder;
    folderForm.hidden = true;
    folderError.hidden = true;
    folderGrid.replaceChildren();
    folderEmpty.hidden = items.length > 0;
    folderEmpty.textContent = folder ? 'Nenhuma nota ou código nesta pasta.' : 'Nenhuma pasta criada.';
    for (const item of items) {
      if (folder) {
        const kind = item.kind === 'code' ? 'Código' : 'Nota';
        const type = item.pinned ? (item.kind === 'code' ? 'Código · Fixado' : 'Nota · Fixada') : kind;
        const preview = firstLine(item.content);
        addFolderCard(ICONS[item.kind] || ICONS.text, item.title || 'Sem título',
          preview ? `${type} · ${preview}` : type, () => openNote(item.id, { note: item, folder }));
      } else {
        const texts = `${item.textCount} ${item.textCount === 1 ? 'nota' : 'notas'}`;
        const codes = `${item.codeCount} ${item.codeCount === 1 ? 'código' : 'códigos'}`;
        addFolderCard(ICONS.folder, item.name, `${texts} · ${codes}`, () => openFolders(item), item);
      }
    }
    renderList();
    closeDrawer();
    folderTitle.focus();
  } catch {
    if (navigation === folderNavigation) toast('Não foi possível carregar as pastas');
  }
}

$('#show-folders').addEventListener('click', () => openFolders());
$('#folder-new-note').addEventListener('click', () => newNote('text'));
$('#folder-new-code').addEventListener('click', () => newNote('code'));
folderBack.addEventListener('click', () => openFolders());
el.noteFolderBack.addEventListener('click', () => {
  if (state.noteFolderOrigin) return openFolders(state.noteFolderOrigin);
});
function toggleFolderForm(folder = null) {
  folderForm.hidden = !folderForm.hidden;
  if (folderForm.hidden) return;
  folderError.hidden = true;
  folderForm.elements.name.value = folder?.name || '';
  folderForm.elements.color.value = folder?.color || 'default';
  folderColorPreview.dataset.color = folderForm.elements.color.value;
  folderSubmit.textContent = folder ? 'Salvar alterações' : 'Criar pasta';
  folderForm.elements.name.focus();
}
folderFormButton.addEventListener('click', () => toggleFolderForm());
editFolderButton.addEventListener('click', () => toggleFolderForm(state.openFolder));
folderForm.elements.color.addEventListener('change', () => {
  folderColorPreview.dataset.color = folderForm.elements.color.value;
});
folderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (folderSubmit.disabled) return;
  const folder = state.openFolder;
  const { name, color } = Object.fromEntries(new FormData(folderForm));
  const navigation = folderNavigation;
  folderSubmit.disabled = true;
  folderError.hidden = true;
  try {
    const saved = await (folder ? api.updateFolder(folder.id, name, color) : api.createFolder(name, color));
    if (navigation === folderNavigation) {
      await openFolders(folder ? { ...folder, ...saved } : null);
    }
  } catch (error) {
    if (navigation === folderNavigation) {
      folderError.textContent = error.message;
      folderError.hidden = false;
    }
  } finally {
    folderSubmit.disabled = false;
  }
});

const removeFolderDialog = $('#remove-folder-dialog');
const removeFolderForm = $('#remove-folder-form');
const removeFolderName = $('#remove-folder-name');
const removeFolderError = $('#remove-folder-error');
const removeFolderCancel = $('#remove-folder-cancel');
const removeFolderSubmit = removeFolderForm.querySelector('[type="submit"]');
let folderToRemove = null;

function openRemoveFolderDialog(folder) {
  folderToRemove = folder;
  removeFolderName.textContent = folder.name;
  removeFolderError.hidden = true;
  removeFolderDialog.showModal();
}
removeFolderCancel.addEventListener('click', () => removeFolderDialog.close());
removeFolderDialog.addEventListener('cancel', (event) => {
  if (removeFolderSubmit.disabled) event.preventDefault();
});
removeFolderForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const folder = folderToRemove;
  if (!folder || removeFolderSubmit.disabled) return;
  removeFolderSubmit.disabled = removeFolderCancel.disabled = true;
  removeFolderError.hidden = true;
  try {
    await api.removeFolder(folder.id);
    for (const note of state.notes) {
      if (note.folderId === folder.id) note.folderId = null;
    }
    folderToRemove = null;
    removeFolderDialog.close();
    toast('Pasta excluída');
    await openFolders();
  } catch (error) {
    removeFolderError.textContent = error.message;
    removeFolderError.hidden = false;
  } finally {
    removeFolderSubmit.disabled = removeFolderCancel.disabled = false;
  }
});

const moveNoteDialog = $('#move-note-dialog');
const moveNoteTitle = $('#move-note-title');
const moveNoteForm = $('#move-note-form');
const moveNoteSelect = $('#move-note-folder');
const moveNoteNewFolder = $('#move-note-new-folder');
const moveNoteFolderName = $('#move-note-folder-name');
const moveNoteError = $('#move-note-error');
const moveNoteButton = $('#move-note');
const moveNoteCancel = $('#move-note-cancel');
const moveNoteSubmit = moveNoteForm.querySelector('[type="submit"]');

function syncMoveNoteFolder() {
  const creating = moveNoteSelect.value === 'new';
  moveNoteNewFolder.hidden = !creating;
  moveNoteFolderName.disabled = !creating || moveNoteSubmit.disabled;
  moveNoteFolderName.required = creating;
}

moveNoteButton.addEventListener('click', async () => {
  const note = state.current;
  moveNoteButton.disabled = true;
  try {
    const folders = await api.folders();
    if (!note || state.current !== note) return;
    moveNoteTitle.textContent = note.kind === 'code' ? 'Mover código para pasta' : 'Mover nota para pasta';
    moveNoteSelect.replaceChildren(new Option('Sem pasta', ''));
    for (const folder of folders) moveNoteSelect.add(new Option(folder.name, folder.id));
    moveNoteSelect.add(new Option('Criar nova pasta', 'new'));
    moveNoteSelect.value = folders.length ? (note.folderId ?? '') : 'new';
    if (moveNoteSelect.selectedIndex === -1) moveNoteSelect.value = '';
    moveNoteFolderName.value = '';
    syncMoveNoteFolder();
    moveNoteError.hidden = true;
    moveNoteDialog.showModal();
  } catch {
    toast('Não foi possível carregar as pastas');
  } finally {
    moveNoteButton.disabled = false;
  }
});
moveNoteSelect.addEventListener('change', () => {
  moveNoteError.hidden = true;
  syncMoveNoteFolder();
  if (!moveNoteNewFolder.hidden) moveNoteFolderName.focus();
});
moveNoteCancel.addEventListener('click', () => moveNoteDialog.close());
moveNoteDialog.addEventListener('cancel', (event) => {
  if (moveNoteSubmit.disabled) event.preventDefault();
});
moveNoteDialog.addEventListener('close', () => moveNoteButton.focus());
moveNoteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const note = state.current;
  if (moveNoteSubmit.disabled || !note) return;
  const isCode = note.kind === 'code';
  const creating = moveNoteSelect.value === 'new';
  const name = moveNoteFolderName.value.trim();
  moveNoteSubmit.disabled = moveNoteCancel.disabled = moveNoteSelect.disabled = true;
  syncMoveNoteFolder();
  moveNoteError.hidden = true;
  let createdFolder;
  try {
    if (!await flushSave()) {
      throw new Error(isCode
        ? 'O código ainda não foi salvo. Tente novamente.'
        : 'A nota ainda não foi salva. Tente novamente.');
    }
    if (creating) {
      if (!name) throw new Error('Informe o nome da pasta.');
      createdFolder = await api.createFolder(name);
      moveNoteSelect.add(new Option(createdFolder.name, createdFolder.id), moveNoteSelect.options.length - 1);
      moveNoteSelect.value = createdFolder.id;
      syncMoveNoteFolder();
    }
    const destination = moveNoteSelect.value ? Number(moveNoteSelect.value) : null;
    const moved = await api.moveNote(note.id, destination);
    note.folderId = moved.folderId;
    const cachedNote = state.notes.find((item) => item.id === note.id);
    if (cachedNote) cachedNote.folderId = moved.folderId;
    moveNoteDialog.close();
    toast(isCode ? 'Pasta do código atualizada' : 'Pasta da nota atualizada');
  } catch (error) {
    moveNoteError.textContent = createdFolder
      ? `A pasta foi criada. Tente salvar novamente para mover ${isCode ? 'o código' : 'a nota'}.`
      : error.message;
    moveNoteError.hidden = false;
  } finally {
    moveNoteSubmit.disabled = moveNoteCancel.disabled = moveNoteSelect.disabled = false;
    syncMoveNoteFolder();
  }
});

// ---------- Salvamento automático ----------
const SAVE_LABELS = { saved: 'Salvo', editing: 'Editando…', saving: 'Salvando…', error: 'Erro ao salvar — tentando de novo' };
function setSaveState(s) {
  el.saveState.dataset.state = s;
  el.statusText.textContent = SAVE_LABELS[s];
}

function scheduleSave() {
  state.dirty = true;
  setSaveState('editing');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 600);
}

async function save() {
  clearTimeout(state.saveTimer);
  if (state.saveInFlight) return state.saveInFlight;
  if (!state.current || !state.dirty) return true;
  state.dirty = false;
  const note = state.current;
  setSaveState('saving');
  state.saveInFlight = persistNote(note);
  try {
    return await state.saveInFlight;
  } finally {
    state.saveInFlight = null;
    if (state.dirty && el.saveState.dataset.state !== 'error') scheduleSave();
  }
}

async function persistNote(c) {
  const pinnedAtStart = c.pinned;
  try {
    const saved = await api.update(c.id, {
      title: c.title, content: c.content, kind: c.kind, language: c.language,
    });
    if (c.pinned !== pinnedAtStart) saved.pinned = c.pinned;
    state.notes = [saved, ...state.notes.filter((n) => n.id !== saved.id)];
    if (state.current === c) {
      state.current.updatedAt = saved.updatedAt;
      if (!state.dirty) setSaveState('saved');
      renderMeta();
    }
    renderList();
    return true;
  } catch (e) {
    if (state.current === c) {
      clearTimeout(state.saveTimer);
      state.dirty = true;
      setSaveState('error');
      state.saveTimer = setTimeout(save, 3000);
    }
    return false;
  }
}

async function flushSave() {
  while (state.dirty || state.saveInFlight) {
    if (!await save()) return false;
  }
  return true;
}

// ---------- Ações ----------
async function copyContent() {
  try {
    await navigator.clipboard.writeText(el.content.value);
  } catch {
    el.content.select();
    document.execCommand('copy');
  }
  toast('Copiado para a área de transferência');
}

const deleteNoteDialog = $('#delete-note-dialog');
const deleteNoteForm = $('#delete-note-form');
const deleteNoteTitle = $('#delete-note-title');
const deleteNoteName = $('#delete-note-name');
const deleteNoteError = $('#delete-note-error');
const deleteNoteCancel = $('#delete-note-cancel');
const deleteNoteSubmit = deleteNoteForm.querySelector('[type="submit"]');
let noteToDelete = null;

function openDeleteNoteDialog() {
  const note = state.current;
  if (!note) return;
  noteToDelete = note;
  const isCode = note.kind === 'code';
  deleteNoteTitle.textContent = isCode ? 'Excluir código?' : 'Excluir nota?';
  deleteNoteName.textContent = `“${note.title || 'Sem título'}”`;
  deleteNoteSubmit.textContent = isCode ? 'Excluir código' : 'Excluir nota';
  deleteNoteError.hidden = true;
  deleteNoteDialog.showModal();
}

deleteNoteCancel.addEventListener('click', () => deleteNoteDialog.close());
deleteNoteDialog.addEventListener('cancel', (event) => {
  if (deleteNoteSubmit.disabled) event.preventDefault();
});
deleteNoteForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const note = noteToDelete;
  if (!note || deleteNoteSubmit.disabled) return;
  deleteNoteSubmit.disabled = deleteNoteCancel.disabled = true;
  deleteNoteError.hidden = true;
  const isCode = note.kind === 'code';
  try {
    if (state.current === note) {
      await state.saveInFlight;
      if (state.current === note) clearTimeout(state.saveTimer);
    }
    await api.remove(note.id);
  } catch {
    if (state.current === note && state.dirty) scheduleSave();
    deleteNoteError.textContent = isCode ? 'Não foi possível excluir o código.' : 'Não foi possível excluir a nota.';
    deleteNoteError.hidden = false;
    return;
  } finally {
    deleteNoteSubmit.disabled = deleteNoteCancel.disabled = false;
  }
  state.notes = state.notes.filter((n) => n.id !== note.id);
  noteToDelete = null;
  deleteNoteDialog.close();
  toast(isCode ? 'Código excluído' : 'Nota excluída');
  if (state.current !== note) {
    renderList();
    return;
  }
  state.dirty = false;
  state.current = null;
  if (state.split) {
    const { note, folder } = state.split;
    state.split = null;
    renderSplit();
    await openNote(note.id, { note, folder });
  } else if (state.notes.length) {
    openNote(state.notes[0].id);
  } else {
    showEditor(false);
    renderList();
  }
});

function setFilter(f) {
  state.filter = f;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.filter === f));
  renderList();
}

function insertText(text) {
  // execCommand mantém o desfazer (Ctrl+Z); setRangeText é o plano B
  if (!document.execCommand('insertText', false, text)) {
    el.content.setRangeText(text, el.content.selectionStart, el.content.selectionEnd, 'end');
    el.content.dispatchEvent(new Event('input'));
  }
}

// ---------- Eventos ----------
const accountControl = $('#account-control');
const accountToggle = $('#account-toggle');

document.addEventListener('click', (e) => {
  if (accountControl.open && !accountControl.contains(e.target)) accountControl.open = false;
});

$('#collapse').addEventListener('click', () => toggleSidebar(false));
$('#open-sidebar').addEventListener('click', () => toggleSidebar(true));
$('#backdrop').addEventListener('click', closeDrawer);
// ---------- Conta (somente demonstração) ----------
// Login, cadastro e edição de conta ficam só na interface: os diálogos abrem
// e validam os campos, mas nada é enviado ao servidor (não há contas no back-end).
const login = $('#login');
const loginForm = $('#login-form');
const loginCancel = $('#login-cancel');
const loginButton = $('#guest-login');
const registration = $('#registration');
const registrationForm = $('#registration-form');
const registrationError = $('#registration-error');
const registrationCancel = $('#registration-cancel');
const registerButton = $('#guest-register');
const editAccount = $('#edit-account');
const DEMO_MESSAGE = 'Contas ainda não estão disponíveis nesta versão';

function openAccountDialog(dialog, form) {
  accountControl.open = false;
  form.reset();
  form.querySelectorAll('[role="alert"]').forEach((p) => { p.hidden = true; });
  dialog.showModal();
}

function closeAccountDialog(dialog, form) {
  dialog.addEventListener('close', () => {
    form.reset();
    accountToggle.focus();
  });
}

loginButton.addEventListener('click', () => openAccountDialog(login, loginForm));
loginCancel.addEventListener('click', () => login.close());
closeAccountDialog(login, loginForm);
loginForm.addEventListener('submit', (event) => {
  event.preventDefault();
  login.close();
  toast(DEMO_MESSAGE);
});

registerButton.addEventListener('click', () => openAccountDialog(registration, registrationForm));
registrationCancel.addEventListener('click', () => registration.close());
closeAccountDialog(registration, registrationForm);
registrationForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(registrationForm));
  let error = '';
  if (data.email.trim().toLowerCase() !== data.emailConfirmation.trim().toLowerCase()) {
    error = 'Os e-mails precisam coincidir.';
  } else if (data.password !== data.passwordConfirmation) {
    error = 'As senhas precisam coincidir.';
  }
  registrationError.textContent = error;
  registrationError.hidden = !error;
  if (error) return;
  registration.close();
  toast(DEMO_MESSAGE);
});
$('#new-text').addEventListener('click', () => newNote('text'));
$('#new-code').addEventListener('click', () => newNote('code'));
$('#empty-text').addEventListener('click', () => newNote('text'));
$('#empty-code').addEventListener('click', () => newNote('code'));
$('#copy-all').addEventListener('click', copyContent);
el.pinNote.addEventListener('click', async () => {
  const note = state.current;
  if (!note || el.pinNote.disabled) return;
  el.pinNote.disabled = true;
  try {
    const { pinned } = await api.pinNote(note.id, !note.pinned);
    note.pinned = pinned;
    const cached = state.notes.find((item) => item.id === note.id);
    if (cached) cached.pinned = pinned;
    if (state.current?.id === note.id) {
      state.current.pinned = pinned;
      renderMeta();
    }
    renderList();
  } catch {
    toast('Não foi possível alterar a fixação');
  } finally {
    el.pinNote.disabled = false;
  }
});
$('#copy-code').addEventListener('click', copyContent);
deleteButton.addEventListener('click', openDeleteNoteDialog);
$$('.tab').forEach((t) => t.addEventListener('click', () => setFilter(t.dataset.filter)));

el.title.addEventListener('input', () => {
  state.current.title = el.title.value;
  el.crumbTitle.textContent = el.title.value || 'Sem título';
  scheduleSave();
});
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.content.focus(); }
});

el.content.addEventListener('input', () => {
  state.current.content = el.content.value;
  renderHighlight();
  renderStats();
  scheduleSave();
});
el.content.addEventListener('scroll', syncScroll);

el.content.addEventListener('keydown', (e) => {
  if (state.current.kind !== 'code') return;
  if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    insertText('    ');
  } else if (e.key === 'Enter') {
    // mantém a indentação da linha atual
    const v = el.content.value;
    const lineStart = v.lastIndexOf('\n', el.content.selectionStart - 1) + 1;
    const indent = v.slice(lineStart).match(/^[ \t]*/)[0];
    if (indent) {
      e.preventDefault();
      insertText('\n' + indent);
    }
  }
});

$$('.kind-toggle button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!state.current || state.current.kind === b.dataset.kind) return;
    state.current.kind = b.dataset.kind;
    if (b.dataset.kind === 'text') state.current.language = '';
    applyKind();
    scheduleSave();
  })
);

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    if (!await flushSave()) return;
    state.query = el.search.value.trim();
    loadNotes();
  }, 250);
});
el.search.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el.search.value) {
    e.stopPropagation();
    el.search.value = '';
    el.search.dispatchEvent(new Event('input'));
  }
});

document.addEventListener('keydown', (e) => {
  if (splitDialog.open || registration.open || login.open || editAccount.open || moveNoteDialog.open
    || removeFolderDialog.open || deleteNoteDialog.open) return;
  if (e.key === 'Escape' && accountControl.open) {
    accountControl.open = false;
    accountToggle.focus();
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 's') { e.preventDefault(); save(); }
  else if (mod && key === 'b') { e.preventDefault(); toggleSidebar(); }
  else if (mod && key === 'k') {
    e.preventDefault();
    if (isMobile()) toggleSidebar(true);
    else { toggleSidebar(true); el.search.focus(); el.search.select(); }
  }
  else if (e.altKey && key === 'n') { e.preventDefault(); newNote('text'); }
  else if (e.key === 'Escape') closeDrawer();
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty || state.saveInFlight) {
    save();
    e.preventDefault();
  }
});

// Atualiza os tempos relativos ("há 3 min") a cada minuto
setInterval(() => { renderList(); renderMeta(); }, 60000);

// ---------- Início ----------
const sidebarAnimals = ['🐱', '🐶', '🦊', '🐼', '🐰', '🐸', '🐨', '🦉'];
const sidebarAvatarKey = 'locknote.sidebarAvatar';
const previousAvatar = store(sidebarAvatarKey);
const availableAvatars = sidebarAnimals.filter((animal) => animal !== previousAvatar);
const sidebarAvatar = availableAvatars[Math.floor(Math.random() * availableAvatars.length)];
$('#sidebar-avatar').textContent = sidebarAvatar;
store(sidebarAvatarKey, sidebarAvatar);

if (store('locknote.sidebarCollapsed') === '1' && !isMobile()) el.app.classList.add('sidebar-collapsed');
loadNotes().then(() => {
  if (state.notes.length && folderNavigation === 0) openNote(state.notes[0].id);
});
