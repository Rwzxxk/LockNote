'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

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
  editor: $('#editor-inner'),
  title: $('#title'),
  content: $('#content'),
  wrap: $('#content-wrap'),
  hl: $('#highlight'),
  hlCode: $('#highlight code'),
  language: $('#language'),
  status: $('#status'),
  copy: $('#copy'),
};

// ---------- Lista ----------
function relTime(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'agora';
  if (diff < 3600) return `${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

function languageLabel(value) {
  const opt = [...el.language.options].find((o) => o.value === value);
  return opt && value ? opt.textContent : 'código';
}

function renderList() {
  const items = state.notes.filter((n) => state.filter === 'all' || n.kind === state.filter);
  el.list.replaceChildren();
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'list-empty';
    li.textContent = state.query ? 'Nenhuma nota encontrada.' : 'Nenhuma nota ainda.';
    el.list.append(li);
    return;
  }
  for (const n of items) {
    const li = document.createElement('li');
    if (state.current && state.current.id === n.id) li.classList.add('active');

    const title = document.createElement('div');
    title.className = 'n-title';
    title.textContent = n.title || 'Sem título';

    const snippet = document.createElement('div');
    snippet.className = 'n-snippet' + (n.kind === 'code' ? ' mono' : '');
    snippet.textContent = n.content.split('\n').find((l) => l.trim()) || '—';

    const meta = document.createElement('div');
    meta.className = 'n-meta';
    if (n.kind === 'code') {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = languageLabel(n.language);
      meta.append(b);
    }
    const t = document.createElement('span');
    t.textContent = relTime(n.updatedAt);
    meta.append(t);

    li.append(title, snippet, meta);
    li.addEventListener('click', () => openNote(n.id));
    el.list.append(li);
  }
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
  // O <pre> precisa de uma linha extra para acompanhar o cursor na última linha vazia
  el.hlCode.innerHTML = html + '\n';
  syncScroll();
}

function syncScroll() {
  el.hl.scrollTop = el.content.scrollTop;
  el.hl.scrollLeft = el.content.scrollLeft;
}

function applyKind() {
  const isCode = state.current.kind === 'code';
  $$('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.kind === state.current.kind));
  el.wrap.classList.toggle('code', isCode);
  el.language.hidden = !isCode;
  el.copy.hidden = !isCode;
  el.content.spellcheck = !isCode;
  el.content.placeholder = isCode ? '// cole ou escreva seu código aqui' : 'Escreva aqui…';
  el.language.value = state.current.language || '';
  renderHighlight();
}

function showEditor(show) {
  el.empty.hidden = show;
  el.editor.hidden = !show;
  el.app.classList.toggle('show-editor', show);
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
  applyKind();
  showEditor(true);
  renderList();
}

async function newNote(kind) {
  await flushSave();
  try {
    const n = await api.create({ title: '', content: '', kind, language: '' });
    state.notes.unshift(n);
    if (state.filter !== 'all' && state.filter !== kind) setFilter('all');
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
  setStatus('Editando…');
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
$('#new-text').addEventListener('click', () => newNote('text'));
$('#new-code').addEventListener('click', () => newNote('code'));

el.title.addEventListener('input', () => {
  state.current.title = el.title.value;
  scheduleSave();
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

$$('.seg button').forEach((b) =>
  b.addEventListener('click', () => {
    if (state.current.kind === b.dataset.kind) return;
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
    setStatus('Copiado!');
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
  showEditor(false);
  renderList();
});

$('#back').addEventListener('click', async () => {
  await flushSave();
  el.app.classList.remove('show-editor');
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

function setFilter(f) {
  state.filter = f;
  $$('.chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === f));
  renderList();
}
$$('.chip').forEach((c) => c.addEventListener('click', () => setFilter(c.dataset.filter)));

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (e) => {
  if (state.dirty) {
    save();
    e.preventDefault();
  }
});

loadNotes();
