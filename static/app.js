'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const ICONS = {
  text: '<svg viewBox="0 0 24 24"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" x2="15" y1="20" y2="20"/><line x1="12" x2="12" y1="4" y2="20"/></svg>',
  code: '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
};

// ---------- API ----------
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url}: ${res.status}`);
  return res.status === 204 ? null : res.json();
}
const api = {
  list: (q) => request('GET', '/api/notes' + (q ? '?q=' + encodeURIComponent(q) : '')),
  create: (n) => request('POST', '/api/notes', n),
  update: (id, n) => request('PUT', `/api/notes/${id}`, n),
  remove: (id) => request('DELETE', `/api/notes/${id}`),
};

// ---------- Estado ----------
const state = {
  notes: [],
  current: null,   // nota aberta (cópia local editável)
  filter: 'all',
  query: '',
  saveTimer: null,
  dirty: false,
};

const el = {
  app: $('#app'),
  list: $('#note-list'),
  search: $('#search'),
  empty: $('#empty'),
  editor: $('#editor'),
  tools: $('#note-tools'),
  title: $('#title'),
  content: $('#content'),
  wrap: $('#content-wrap'),
  hl: $('#highlight'),
  hlCode: $('#highlight code'),
  language: $('#language'),
  status: $('#status'),
  copy: $('#copy'),
};

// ---------- Barra lateral ----------
function openDrawer() {
  el.app.classList.add('drawer-open');
  setTimeout(() => el.search.focus(), 50);
}
function closeDrawer() {
  el.app.classList.remove('drawer-open');
}

// ---------- Lista ----------
function relTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function renderList() {
  const items = state.notes.filter((n) => state.filter === 'all' || n.kind === state.filter);
  el.list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = state.query ? 'Nada encontrado.' : 'Nenhuma nota ainda.';
    el.list.append(li);
    return;
  }
  for (const n of items) {
    const li = document.createElement('li');
    if (state.current && state.current.id === n.id) li.classList.add('active');
    li.title = n.kind === 'code' ? 'Código' : 'Texto';

    const icon = document.createElement('span');
    icon.className = 'n-icon';
    icon.innerHTML = ICONS[n.kind] || ICONS.text;

    const title = document.createElement('span');
    title.className = 'n-title' + (n.title ? '' : ' untitled');
    title.textContent = n.title || firstLine(n.content) || 'Sem título';

    const time = document.createElement('span');
    time.className = 'n-time';
    time.textContent = relTime(n.updatedAt);

    li.append(icon, title, time);
    li.addEventListener('click', () => openNote(n.id));
    el.list.append(li);
  }
}

function firstLine(s) {
  return (s.split('\n').find((l) => l.trim()) || '').trim().slice(0, 60);
}

async function loadNotes() {
  try {
    state.notes = await api.list(state.query);
  } catch (e) {
    console.error(e);
    state.notes = [];
  }
  renderList();
}

// ---------- Editor ----------
function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function renderHighlight() {
  if (!state.current || state.current.kind !== 'code') return;
  const text = el.content.value;
  const lang = state.current.language;
  let html;
  if (window.hljs) {
    html = lang && hljs.getLanguage(lang)
      ? hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
      : hljs.highlightAuto(text).value;
  } else {
    html = escapeHtml(text); // sem internet: sem cores, mas funciona
  }
  // linha extra para o <pre> acompanhar o cursor na última linha vazia
  el.hlCode.innerHTML = html + '\n';
  syncScroll();
}

function syncScroll() {
  el.hl.scrollTop = el.content.scrollTop;
  el.hl.scrollLeft = el.content.scrollLeft;
}

function applyKind() {
  const isCode = state.current.kind === 'code';
  $$('.kind-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.current.kind));
  el.wrap.classList.toggle('code', isCode);
  el.language.hidden = !isCode;
  el.copy.hidden = !isCode;
  el.content.spellcheck = !isCode;
  el.content.placeholder = isCode ? '// cole ou escreva seu código' : 'Comece a escrever…';
  el.language.value = state.current.language || '';
  renderHighlight();
}

function showEditor(show) {
  el.empty.hidden = show;
  el.editor.hidden = !show;
  el.tools.hidden = !show;
}

async function openNote(id) {
  await flushSave();
  const n = state.notes.find((x) => x.id === id);
  if (!n) return;
  state.current = { ...n };
  el.title.value = n.title;
  el.content.value = n.content;
  el.content.scrollTop = 0;
  setStatus('');
  showEditor(true);
  applyKind();
  renderList();
  closeDrawer();
}

async function newNote() {
  await flushSave();
  try {
    const kind = state.filter === 'code' ? 'code' : 'text';
    const n = await api.create({ title: '', content: '', kind, language: '' });
    state.notes.unshift(n);
    await openNote(n.id);
    el.title.focus();
  } catch (e) {
    alert('Não foi possível criar a nota.');
  }
}

// ---------- Salvamento automático ----------
function setStatus(text) { el.status.textContent = text; }

function scheduleSave() {
  state.dirty = true;
  setStatus('');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(save, 600);
}

async function save() {
  clearTimeout(state.saveTimer);
  if (!state.current || !state.dirty) return;
  state.dirty = false;
  const c = state.current;
  setStatus('Salvando…');
  try {
    const saved = await api.update(c.id, {
      title: c.title, content: c.content, kind: c.kind, language: c.language,
    });
    state.notes = [saved, ...state.notes.filter((n) => n.id !== saved.id)];
    if (state.current && state.current.id === saved.id) setStatus('Salvo');
    renderList();
  } catch (e) {
    state.dirty = true;
    setStatus('Erro ao salvar');
  }
}

async function flushSave() {
  if (state.dirty) await save();
}

// ---------- Eventos ----------
$('#open-drawer').addEventListener('click', openDrawer);
$('#close-drawer').addEventListener('click', closeDrawer);
$('#backdrop').addEventListener('click', closeDrawer);
$('#new-note').addEventListener('click', newNote);
$('#empty-new').addEventListener('click', newNote);

el.title.addEventListener('input', () => {
  state.current.title = el.title.value;
  scheduleSave();
});
el.title.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); el.content.focus(); }
});

el.content.addEventListener('input', () => {
  state.current.content = el.content.value;
  renderHighlight();
  scheduleSave();
});
el.content.addEventListener('scroll', syncScroll);

el.language.addEventListener('change', () => {
  state.current.language = el.language.value;
  renderHighlight();
  scheduleSave();
});

$$('.kind-toggle button').forEach((b) =>
  b.addEventListener('click', () => {
    if (!state.current || state.current.kind === b.dataset.kind) return;
    state.current.kind = b.dataset.kind;
    applyKind();
    scheduleSave();
  })
);

function insertText(text) {
  // execCommand mantém o desfazer (Ctrl+Z); setRangeText é o plano B
  if (!document.execCommand('insertText', false, text)) {
    el.content.setRangeText(text, el.content.selectionStart, el.content.selectionEnd, 'end');
    el.content.dispatchEvent(new Event('input'));
  }
}

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

el.copy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(el.content.value);
    setStatus('Copiado');
  } catch {
    el.content.select();
    document.execCommand('copy');
  }
});

$('#delete').addEventListener('click', async () => {
  const c = state.current;
  if (!c || !confirm(`Excluir "${c.title || 'Sem título'}"?`)) return;
  clearTimeout(state.saveTimer);
  state.dirty = false;
  try {
    await api.remove(c.id);
  } catch (e) {
    alert('Não foi possível excluir a nota.');
    return;
  }
  state.notes = state.notes.filter((n) => n.id !== c.id);
  state.current = null;
  if (state.notes.length) {
    openNote(state.notes[0].id);
  } else {
    showEditor(false);
    renderList();
  }
});

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    await flushSave();
    state.query = el.search.value.trim();
    loadNotes();
  }, 250);
});

$$('.chip').forEach((c) =>
  c.addEventListener('click', () => {
    state.filter = c.dataset.filter;
    $$('.chip').forEach((x) => x.classList.toggle('active', x === c));
    renderList();
  })
);

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
  else if (mod && e.key.toLowerCase() === 'b') {
    e.preventDefault();
    el.app.classList.contains('drawer-open') ? closeDrawer() : openDrawer();
  }
  else if (e.key === 'Escape') closeDrawer();
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    save();
    e.preventDefault();
  }
});

// Ao abrir, mostra a nota mais recente
loadNotes().then(() => {
  if (state.notes.length) openNote(state.notes[0].id);
});
