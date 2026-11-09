import { h, icon, avatar, toast, wireMenu, parseTs, timeAgo, fullTime, confirmDialog, promptDialog, openDialog, debounce, pluralize } from '../dom.js';
import { TEMPLATES } from '../templates.js';
import { Api, filePayload } from '../api.js';

const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'View only' };

const recencyGroup = (ts) => {
  const d = parseTs(ts); if (isNaN(d)) return 'Earlier';
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(d).setHours(0, 0, 0, 0)) / 86400000);
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : days <= 7 ? 'Previous 7 days' : days <= 30 ? 'Previous 30 days' : 'Older';
};

// "…text [[match]] text…" from the server -> DOM text and <mark> nodes (never innerHTML)
function highlight(snip) { return String(snip).split(/(\[\[|\]\])/).reduce((acc, part) => { if (part === '[[') acc.on = true; else if (part === ']]') acc.on = false; else if (part) acc.out.push(acc.on ? h('mark', {}, part) : part); return acc; }, { out: [], on: false }).out; }

// Small inline illustrations (no external assets; colours come from the theme tokens)
export function illustration(kind) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 120 90'); svg.setAttribute('width', '132'); svg.setAttribute('height', '100'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('class', 'illo');
  const shapes = {
    doc: '<rect x="34" y="8" width="52" height="68" rx="6" class="i-a"/><path d="M44 28h32M44 38h32M44 48h20" class="i-l"/><circle cx="88" cy="68" r="12" class="i-b"/><path d="M88 62v12M82 68h12" class="i-w"/>',
    search: '<rect x="26" y="14" width="52" height="62" rx="6" class="i-a"/><path d="M36 34h30M36 44h22" class="i-l"/><circle cx="82" cy="58" r="14" class="i-n"/><path d="m92 68 12 12" class="i-s"/>',
    star: '<rect x="30" y="10" width="52" height="66" rx="6" class="i-a"/><path d="M40 30h32M40 40h24" class="i-l"/><path d="m88 44 4.500 9.200 10.100 1.500-7.300 7.100 1.700 10.100L88 67l-9 4.900 1.700-10.100-7.300-7.100 10.100-1.500z" class="i-star"/>',
    broken: '<rect x="34" y="8" width="52" height="68" rx="6" class="i-a"/><path d="M44 28h32M44 38h14" class="i-l"/><path d="M44 52h8M64 52h12" class="i-l" stroke-dasharray="2 6"/><circle cx="88" cy="66" r="12" class="i-n"/><path d="m83 61 10 10M93 61 83 71" class="i-s"/>',
    people: '<rect x="22" y="14" width="44" height="58" rx="6" class="i-a"/><path d="M32 32h24M32 42h16" class="i-l"/><circle cx="86" cy="40" r="9" class="i-b"/><path d="M70 70c2-12 8-17 16-17s14 5 16 17" class="i-b"/>',
  };
  svg.innerHTML = shapes[kind] || shapes.doc;
  return svg;
}

export function renderList(root, { user, navigate }) {
  const state = { data: { owned: [], shared: [] }, trash: [], tab: 'all', sort: 'recent', q: '', loading: true };
  let alive = true;

  const search = h('input', { type: 'search', placeholder: 'Search documents', 'aria-label': 'Search documents', autocomplete: 'off' });
  const grid = h('div', { class: 'cards' });
  const counter = h('span', { class: 'muted', 'aria-live': 'polite' }); // announces the result of a filter without re-reading every card
  const fileInput = h('input', { type: 'file', accept: '.txt,.md,.markdown,.docx', multiple: true, hidden: true, 'aria-label': 'Choose files to import', onchange: (e) => { importFiles([...e.target.files]); e.target.value = ''; } });
  const dropHint = h('div', { class: 'drop-hint', hidden: true }, icon('upload', 32), h('strong', {}, 'Drop to import'), h('span', {}, '.docx, .md or .txt files become editable documents'));

  const tabDefs = [['all', 'All'], ['owned', 'Owned by me'], ['shared', 'Shared with me'], ['starred', 'Starred'], ['trash', 'Trash']];
  const tabBtns = tabDefs.map(([id, label]) => h('button', { class: 'tab', type: 'button', 'aria-pressed': 'false', onclick: () => { state.tab = id; if (id === 'trash') loadTrash(); else draw(); } }, label));
  // First-run tips: shown until dismissed (remembered in this browser)
  let guideSeen = false; try { guideSeen = localStorage.getItem('docs-lite:guide') === '1'; } catch { /* ignore */ }
  const tip = (key, text) => h('li', {}, h('kbd', {}, key), h('span', {}, text));
  const guide = h('aside', { class: 'guide', hidden: guideSeen, 'aria-label': 'Getting started' },
    h('div', { class: 'guide-head' }, h('strong', {}, 'Getting started'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss tips', onclick: () => { guideSeen = true; guide.hidden = true; try { localStorage.setItem('docs-lite:guide', '1'); } catch { /* ignore */ } } }, icon('close', 16))),
    h('ul', { class: 'guide-tips' },
      tip('New', 'Start from a template: meeting notes, project brief, resume and more.'),
      tip('/', 'Type / in a document to insert headings, lists, tables, pictures and drawings.'),
      tip('Ctrl+Shift+P', 'Open the command palette in a document to do anything from the keyboard.'),
      tip('Share', 'Share with a teammate, then open a second window to see edits and cursors live.')));
  const viewBtn = h('button', { class: 'icon-btn view-toggle', type: 'button', onclick: () => setView(state.view === 'grid' ? 'list' : 'grid') });
  const sortSel = h('select', { 'aria-label': 'Sort documents', onchange: (e) => { state.sort = e.target.value; draw(); } },
    h('option', { value: 'recent' }, 'Recently edited'), h('option', { value: 'title' }, 'Title A-Z'));

  async function load(quiet = false) {
    if (!quiet) { state.loading = true; draw(); }
    const seq = (load.seq = (load.seq || 0) + 1);
    let res = null;
    try { res = await Api.list(state.q); } catch (e) { toast(e.message, 'error'); }
    if (!alive || seq !== load.seq) return; // a newer search is in flight; drop this stale answer
    if (res) {
      const sig = JSON.stringify(res);
      if (quiet && sig === load.sig) return; // unchanged: keep the DOM (and keyboard focus) as it is
      load.sig = sig; state.data = res;
    }
    state.loading = false; draw();
  }
  async function loadTrash() {
    try { state.trash = await Api.trash(); } catch (e) { toast(e.message, 'error'); }
    draw();
  }
  const onSearch = debounce(() => { state.q = search.value.trim(); load(); }, 250);
  search.addEventListener('input', onSearch);

  function items() {
    const owned = state.data.owned.map((d) => ({ ...d, role: 'owner' }));
    const shared = state.data.shared;
    let all = state.tab === 'owned' ? owned : state.tab === 'shared' ? shared : [...owned, ...shared];
    if (state.tab === 'starred') all = all.filter((d) => d.starred);
    if (state.sort === 'title') all = [...all].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }));
    else all = [...all].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.id - a.id));
    return all;
  }

  function card(d) {
    const isOwner = d.role === 'owner';
    const open = () => navigate(`#/doc/${d.id}`);
    const menu = h('div', { class: 'menu', hidden: true, role: 'menu' },
      h('button', { role: 'menuitem', type: 'button', onclick: (e) => { e.stopPropagation(); open(); } }, icon('file'), 'Open'),
      h('button', { role: 'menuitem', type: 'button', onclick: async (e) => { e.stopPropagation(); closeMenus(); try { const c = await Api.duplicate(d.id); toast('Copy created'); navigate(`#/doc/${c.id}`); } catch (err) { toast(err.message, 'error'); } } }, icon('copy'), 'Make a copy'),
      d.role !== 'viewer' && h('button', { role: 'menuitem', type: 'button', onclick: async (e) => { e.stopPropagation(); closeMenus(); const t = await promptDialog({ title: 'Rename document', label: 'Title', value: d.title, confirmLabel: 'Rename', maxLength: 200 }); if (!t || t === d.title) return; try { await Api.save(d.id, { title: t, base_version: d.version }); toast('Renamed'); load(true); } catch (err) { toast(err.message, 'error'); } } }, icon('tag'), 'Rename'),
      isOwner && h('button', { role: 'menuitem', type: 'button', onclick: (e) => { e.stopPropagation(); closeMenus(); try { sessionStorage.setItem('docs-lite:open-share', String(d.id)); } catch { /* ignore */ } open(); } }, icon('share'), 'Share…'),
      isOwner && h('button', { class: 'danger', role: 'menuitem', type: 'button', onclick: (e) => { e.stopPropagation(); closeMenus(); remove(d); } }, icon('trash'), 'Delete'));
    const kebab = h('button', { class: 'icon-btn kebab', type: 'button', 'aria-label': `Actions for ${d.title}`, 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, icon('more'));
    wireMenu(kebab, menu, { beforeOpen: closeMenus });
    const starBtn = h('button', { class: `icon-btn star${d.starred ? ' on' : ''}`, type: 'button', 'aria-pressed': String(Boolean(d.starred)), 'aria-label': `${d.starred ? 'Unstar' : 'Star'} ${d.title}`, title: d.starred ? 'Remove star' : 'Add star', onclick: async (e) => {
      e.stopPropagation();
      const next = !d.starred;
      const setStar = (v) => { d.starred = v; for (const x of [...state.data.owned, ...state.data.shared]) if (x.id === d.id) x.starred = v; starBtn.classList.toggle('on', v); starBtn.setAttribute('aria-pressed', String(v)); starBtn.setAttribute('aria-label', `${v ? 'Unstar' : 'Star'} ${d.title}`); starBtn.title = v ? 'Remove star' : 'Add star'; };
      setStar(next); try { await Api.star(d.id, next); if (state.tab === 'starred') draw(); }
      catch (err) { setStar(!next); toast(err.message, 'error'); }
    } }, icon('star', 16));
    const el = h('article', { class: `card${d.snippet ? ' has-snippet' : ''}`, onclick: (e) => { if (!e.target.closest('button, a, .menu')) open(); } },
      h('div', { class: 'card-top' }, h('span', { class: 'pills' }, d.unseen && h('span', { class: 'pill new' }, 'New'), h('span', { class: `role-pill ${d.role}` }, d.role === 'viewer' ? icon('eye', 13) : d.role === 'editor' ? icon('users', 13) : icon('lock', 13), ROLE_LABEL[d.role])), h('div', { class: 'card-menu' }, starBtn, kebab, menu)),
      h('div', { class: 'card-thumb', 'aria-hidden': 'true' }),
      h('h3', { class: 'card-title' }, h('a', { class: 'card-link', href: `#/doc/${d.id}`, 'aria-label': `${d.title}, ${ROLE_LABEL[d.role]}` }, d.title)),
      d.snippet ? h('p', { class: 'card-preview' }, highlight(d.snippet)) : h('p', { class: 'card-preview' }, d.preview || 'Empty document'),
      h('div', { class: 'card-foot' },
        avatar(isOwner ? user.display_name : d.owner_name, 'sm'),
        h('span', { class: 'muted', title: fullTime(d.updated_at) }, isOwner ? `Edited ${timeAgo(d.updated_at)}` : `${d.owner_name} · ${timeAgo(d.updated_at)}`),
        d.source_file && h('span', { class: 'src', title: `Imported from ${d.source_file}` }, icon('upload', 12), d.source_file.split('.').pop().toUpperCase()),
        h('span', { class: 'muted words' }, pluralize(d.words, 'word'))));
    const th = el.querySelector('.card-thumb'); th.innerHTML = d.thumb || ''; if (!d.thumb) th.classList.add('blank');
    return el;
  }
  const closeMenus = () => root.querySelectorAll('.menu').forEach((m) => { m.hidden = true; });
  const onDocClick = () => closeMenus();
  document.addEventListener('click', onDocClick);
  // Keep the list fresh: refetch when the tab regains focus and every 30 seconds while visible.
  const refresh = () => { if (!document.hidden && !state.loading && !document.querySelector('dialog[open]')) load(true); };
  window.addEventListener('focus', refresh);
  const refreshTimer = setInterval(refresh, 30000);

  async function remove(d) {
    try {
      await Api.remove(d.id);
      toast(`"${d.title.length > 40 ? d.title.slice(0, 40) + '…' : d.title}" moved to Trash`, 'info', 7000, { label: 'Undo', onClick: async () => { try { await Api.restoreFromTrash(d.id); toast('Restored', 'success', 2000); load(true); } catch (e) { toast(e.message, 'error'); } } });
      load(true);
    } catch (e) { toast(e.message, 'error'); }
  }
  function trashCard(d) {
    const restoreBtn = h('button', { class: 'btn sm', type: 'button', onclick: async () => { try { await Api.restoreFromTrash(d.id); toast('Document restored', 'success'); loadTrash(); } catch (e) { toast(e.message, 'error'); } } }, icon('restore', 14), 'Restore');
    const eraseBtn = h('button', { class: 'btn sm danger', type: 'button', onclick: async () => {
      if (!(await confirmDialog({ title: 'Delete forever?', message: `"${d.title}" will be permanently erased, including its history and comments. This cannot be undone.`, confirmLabel: 'Delete forever', danger: true }))) return;
      try { await Api.eraseFromTrash(d.id); toast('Erased'); loadTrash(); } catch (e) { toast(e.message, 'error'); }
    } }, icon('trash', 14), 'Delete forever');
    return h('article', { class: 'card trash-card' },
      h('h3', { class: 'card-title' }, d.title),
      h('p', { class: 'card-preview' }, d.preview || 'Empty document'),
      h('div', { class: 'card-foot' }, h('span', { class: 'muted', title: fullTime(d.deleted_at) }, `Deleted ${timeAgo(d.deleted_at)} · kept ${d.days_left} days`)),
      h('div', { class: 'trash-actions' }, restoreBtn, eraseBtn));
  }

  function drawTrash() {
    guide.hidden = true;
    const tq = state.q.trim().toLowerCase();
    const shownTrash = tq ? state.trash.filter((t) => t.title.toLowerCase().includes(tq)) : state.trash;
    counter.textContent = pluralize(shownTrash.length, 'document');
    grid.replaceChildren(...(shownTrash.length ? shownTrash.map(trashCard) : [h('div', { class: 'empty' }, icon('trash', 40), h('h3', {}, 'Trash is empty'), h('p', { class: 'muted' }, 'Deleted documents stay here for 30 days so you can restore them.'))]));
  }

  function draw() {
    guide.hidden = guideSeen || state.data.owned.length > 3; // tips are for people just starting out
    tabBtns.forEach((b, i) => { const on = tabDefs[i][0] === state.tab; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    if (state.tab === 'trash') { drawTrash(); return; }
    const list = items();
    const total = state.data.owned.length + state.data.shared.length;
    counter.textContent = state.loading ? '' : pluralize(list.length, 'document');
    if (state.loading && !total) { grid.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'card skeleton' }, h('i'), h('i'), h('i')))); return; }
    if (!list.length) {
      const searching = Boolean(state.q);
      grid.replaceChildren(h('div', { class: 'empty' },
        illustration(searching ? 'search' : state.tab === 'starred' ? 'star' : state.tab === 'shared' ? 'people' : 'doc'),
        h('h3', {}, searching ? 'No matches' : state.tab === 'shared' ? 'Nothing shared with you yet' : state.tab === 'starred' ? 'No starred documents' : 'No documents yet'),
        h('p', { class: 'muted' }, searching ? `Nothing matches "${state.q}".` : state.tab === 'shared' ? 'When someone shares a document with you it will show up here.' : state.tab === 'starred' ? 'Star a document with the star on its card to find it quickly here.' : 'Create a document, or drop a .docx, .md or .txt file here to import it.'),
        !searching && state.tab !== 'shared' && state.tab !== 'starred' && h('button', { class: 'btn primary', type: 'button', onclick: newDoc }, icon('plus'), 'New document')));
      return;
    }
    if (state.sort === 'recent') { // group by recency so 100+ documents are not one endless wall
      const out = []; let last = null;
      for (const d of list) { const g = recencyGroup(d.updated_at); if (g !== last) { last = g; out.push(h('h2', { class: 'group-head' }, g)); } out.push(card(d)); }
      grid.replaceChildren(...out);
    } else grid.replaceChildren(...list.map(card));
  }

  function newDoc() {
    let picked = TEMPLATES[0];
    let nameTouched = false;
    const name = h('input', { type: 'text', value: picked.title, maxLength: 200, required: true, 'aria-label': 'Document name', oninput: () => { nameTouched = true; } });
    const select = (t) => { picked = t; if (!nameTouched) name.value = t.title; cards.forEach((c, i) => { const on = TEMPLATES[i] === t; c.classList.toggle('selected', on); c.setAttribute('aria-checked', String(on)); c.tabIndex = on ? 0 : -1; }); };
    const cards = TEMPLATES.map((t) => h('button', { class: `tpl${t === picked ? ' selected' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(t === picked), tabIndex: t === picked ? 0 : -1, 'data-kind': t.id, onclick: () => select(t) },
      h('span', { class: 'tpl-thumb', 'aria-hidden': 'true' }), h('strong', {}, t.name), h('span', { class: 'muted small' }, t.desc)));
    const group = h('div', { class: 'tpl-grid', role: 'radiogroup', 'aria-label': 'Start with' }, cards);
    group.addEventListener('keydown', (e) => { // arrow keys move through the choices (one tab stop for the group)
      const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!k) return;
      e.preventDefault(); const i = TEMPLATES.indexOf(picked); const next = TEMPLATES[(i + k + TEMPLATES.length) % TEMPLATES.length]; select(next); cards[TEMPLATES.indexOf(next)].focus();
    });
    const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); create(); } },
      h('div', { class: 'stack tight' }, h('span', { class: 'field-label' }, 'Start with'), group),
      h('label', {}, 'Name ', h('span', { class: 'muted small' }, '(you can change it later)'), name));
    let creating = false;
    async function create() {
      const title = name.value.trim();
      if (!title) { name.focus(); return; }
      if (creating) return;
      creating = true;
      try { const html = picked.html(); const d = await Api.create(title, html || undefined); dlg.close(true); navigate(`#/doc/${d.id}`); } catch (e) { creating = false; toast(e.message, 'error'); }
    }
    const dlg = openDialog({ title: 'New document', wide: true, body: form, actions: [{ label: 'Cancel', value: null }, { label: 'Create', kind: 'primary', onClick: () => form.requestSubmit() }] });
    cards[0].focus();
  }

  async function importFiles(files) {
    if (!files.length) return;
    let last = null;
    for (const f of files) {
      try {
        if (f.size > 2_000_000) throw new Error(`${f.name} is too large (2 MB max)`);
        last = await Api.importFile(await filePayload(f));
        toast(`Imported ${f.name}`, 'success');
      } catch (e) { toast(`${f.name}: ${e.message}`, 'error', 6000); }
    }
    if (files.length === 1 && last) navigate(`#/doc/${last.id}`); else load();
  }

  // drag and drop import
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  const dnd = {
    dragenter: (e) => { if (hasFiles(e)) { depth++; dropHint.hidden = false; } },
    dragleave: () => { depth = Math.max(0, depth - 1); if (!depth) dropHint.hidden = true; },
    dragover: (e) => { if (hasFiles(e)) e.preventDefault(); },
    drop: (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth = 0; dropHint.hidden = true; importFiles([...e.dataTransfer.files]); },
  };
  for (const [ev, fn] of Object.entries(dnd)) window.addEventListener(ev, fn);
  const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.querySelector('dialog[open]');
  let chord = null;
  const onKey = (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || typing()) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && document.activeElement !== document.body && !grid.contains(document.activeElement)) return; // arrows keep scrolling and moving focus elsewhere
    const cards = () => [...grid.querySelectorAll('.card-link')];
    const move = (dir) => { const c = cards(); if (!c.length) return; const i = c.indexOf(document.activeElement); c[Math.max(0, Math.min(c.length - 1, i < 0 ? (dir > 0 ? 0 : c.length - 1) : i + dir))].focus(); };
    if (chord === 'g') { // two-key shortcuts: g then a / o / s / t / f
      chord = null;
      const tab = { a: 'all', o: 'owned', s: 'shared', f: 'starred', t: 'trash' }[e.key];
      if (tab) { e.preventDefault(); state.tab = tab; if (tab === 'trash') loadTrash(); else draw(); }
      return;
    }
    if (e.key === '/') { e.preventDefault(); search.focus(); }
    else if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(e.key === 'j' || state.view === 'list' ? 1 : 3); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(e.key === 'k' || state.view === 'list' ? -1 : -3); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); move(1); } else if (e.key === 'ArrowLeft') { e.preventDefault(); move(-1); }
    else if (e.key === 'n') { e.preventDefault(); newDoc(); }
    else if (e.key === 'g') { chord = 'g'; setTimeout(() => { chord = null; }, 1000); }
    else if (e.key === 'v') { e.preventDefault(); setView(state.view === 'grid' ? 'list' : 'grid'); }
    else if (e.key === '?') { e.preventDefault(); showKeys(); }
  };
  function showKeys() {
    const rows = [['Move between documents', 'j / k  or  arrow keys'], ['Open the focused document', 'Enter'], ['New document', 'n'], ['Search', '/'], ['Switch grid / list view', 'v'], ['Go to All, Owned, Shared, Starred, Trash', 'g then a, o, s, f, t'], ['This help', '?']];
    openDialog({ title: 'Keyboard shortcuts', body: h('table', { class: 'shortcuts' }, rows.map(([a, b]) => h('tr', {}, h('td', {}, a), h('td', {}, h('kbd', {}, b))))), actions: [{ label: 'Done', kind: 'primary', value: true }] });
  }
  function setView(v) { state.view = v; try { localStorage.setItem('docs-lite:view', v); } catch { /* ignore */ } grid.classList.toggle('as-list', v === 'list'); viewBtn.replaceChildren(icon(v === 'list' ? 'ul' : 'table', 16)); viewBtn.title = v === 'list' ? 'Switch to grid view (v)' : 'Switch to list view (v)'; viewBtn.setAttribute('aria-label', viewBtn.title); }
  window.addEventListener('keydown', onKey);

  root.replaceChildren(h('div', { class: 'page-wrap' },
    h('div', { class: 'list-head' },
      h('div', {}, h('h1', {}, `Hello, ${user.display_name.split(' ')[0]}`), h('p', { class: 'muted' }, 'Your documents, and the ones shared with you.')),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('upload'), 'Import file'),
        h('button', { class: 'btn primary', type: 'button', onclick: newDoc }, icon('plus'), 'New document'), fileInput)),
    h('div', { class: 'toolbar-row' },
      h('div', { class: 'search' }, icon('search', 16), search),
      h('div', { class: 'tabs', role: 'group', 'aria-label': 'Show documents' }, tabBtns),
      sortSel, viewBtn),
    h('div', { class: 'row-between sub' }, counter, h('span', { class: 'muted small' }, 'Drag a .docx, .md, .markdown or .txt file here to import it · press ? for shortcuts')),
    guide, grid, dropHint));
  { let v = 'grid'; try { v = localStorage.getItem('docs-lite:view') === 'list' ? 'list' : 'grid'; } catch { /* ignore */ } state.view = v; setView(v); }
  load();

  return () => {
    alive = false;
    document.removeEventListener('click', onDocClick);
    window.removeEventListener('focus', refresh); clearInterval(refreshTimer);
    window.removeEventListener('keydown', onKey);
    for (const [ev, fn] of Object.entries(dnd)) window.removeEventListener(ev, fn);
  };
}
