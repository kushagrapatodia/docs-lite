import { h, icon } from '../dom.js';
import { Api } from '../api.js';

export function renderAuth(root, { onAuthed }) {
  let mode = 'login';
  const card = h('div', { class: 'auth-card' });

  const demo = h('div', { class: 'demo' },
    h('p', { class: 'muted' }, 'Just reviewing? Jump in as a demo user:'),
    h('div', { class: 'chips' }, ['alice', 'bob', 'carol'].map((u) => h('button', { class: 'chip', type: 'button', onclick: () => submit({ username: u, password: 'demo123' }) }, u[0].toUpperCase() + u.slice(1)))),
    h('p', { class: 'muted small' }, 'Alice owns the sample document, Bob can edit it, Carol has nothing shared yet.'));

  async function submit(values) {
    if (submitBtn.disabled) return; // a second Enter while signing in
    err.textContent = ''; for (const f of [username, password]) { f.removeAttribute('aria-invalid'); f.removeAttribute('aria-describedby'); }
    busy(true);
    try {
      const user = mode === 'login'
        ? await Api.login(values.username, values.password)
        : await Api.register(values.username, values.display_name, values.password);
      onAuthed(user);
    } catch (e) {
      err.textContent = e.message; busy(false);
      for (const f of (/password/i.test(e.message) ? [password] : /user|name/i.test(e.message) ? [username] : [username, password])) { f.setAttribute('aria-invalid', 'true'); f.setAttribute('aria-describedby', 'auth-error'); } // the error is tied to the fields, and not only red
      (mode === 'login' ? password : username).focus(); // fields keep what was typed
    }
  }
  const busy = (on) => { // only the submit button is disabled, so keyboard focus stays where it is
    submitBtn.disabled = on; form.toggleAttribute('aria-busy', on);
    submitBtn.textContent = on ? (mode === 'login' ? 'Signing in…' : 'Creating account…') : (mode === 'login' ? 'Sign in' : 'Create account');
  };

  const username = h('input', { name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: false, maxLength: 24, 'aria-label': 'Username' });
  const display = h('input', { name: 'display_name', autocomplete: 'name', maxLength: 60, 'aria-label': 'Your name' });
  const password = h('input', { name: 'password', type: 'password', required: true, autocomplete: 'current-password', maxLength: 200, 'aria-label': 'Password' });
  const toggle = h('button', { class: 'link-btn', type: 'button', 'aria-pressed': 'false', 'aria-label': 'Show password', onclick: () => { const show = password.type === 'password'; password.type = show ? 'text' : 'password'; toggle.textContent = show ? 'Hide' : 'Show'; toggle.setAttribute('aria-pressed', String(show)); toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); } }, 'Show');
  const err = h('p', { class: 'error', role: 'alert', id: 'auth-error' });
  const nameField = h('label', {}, 'Your name', display);
  const hint = h('p', { class: 'muted small' });
  const submitBtn = h('button', { class: 'btn primary lg', type: 'submit' });
  const form = h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); submit({ username: username.value, display_name: display.value, password: password.value }); } },
    nameField,
    h('label', {}, 'Username', username),
    h('label', {}, h('span', { class: 'row-between' }, 'Password', toggle), password),
    hint, submitBtn, err);

  form.addEventListener('input', () => { err.textContent = ''; });
  const tabs = ['login', 'register'].map((m) => h('button', { type: 'button', class: 'tab', onclick: () => setMode(m) }, m === 'login' ? 'Sign in' : 'Create account'));
  function setMode(m) {
    mode = m;
    tabs.forEach((t, i) => { const on = (i === 0) === (m === 'login'); t.classList.toggle('active', on); t.setAttribute('aria-pressed', String(on)); });
    nameField.hidden = m === 'login';
    display.required = m === 'register';
    password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    submitBtn.textContent = m === 'login' ? 'Sign in' : 'Create account';
    hint.textContent = m === 'login' ? '' : 'Username: 3-24 letters, numbers or underscore. Password: at least 8 characters.';
    err.textContent = '';
  }

  card.append(
    h('div', { class: 'tabs', role: 'group', 'aria-label': 'Sign in or create an account' }, tabs),
    form,
    h('div', { class: 'divider' }, h('span', {}, 'or')),
    demo);
  setMode('login');

  const bullets = [
    ['Rich-text editing', 'Headings, lists, links and formatting that persists exactly as you typed it.'],
    ['Real collaboration', 'Share as editor or viewer, see who is here, watch changes arrive live.'],
    ['Import and export', 'Bring in .docx, .md or .txt. Export to Word, Markdown, HTML or PDF.'],
    ['Never lose work', 'Autosave, version history with one-click restore, and conflict protection.'],
  ];
  root.replaceChildren(h('div', { class: 'auth' },
    h('section', { class: 'auth-hero' },
      h('div', { class: 'brandmark' }, icon('logo', 28), h('span', {}, 'Docs Lite')),
      h('h1', {}, 'Write together, without the clutter.'),
      h('p', { class: 'lead' }, 'A lightweight collaborative document editor built for fast teams.'),
      h('ul', { class: 'features' }, bullets.map(([t, d]) => h('li', {}, icon('check', 16), h('div', {}, h('strong', {}, t), h('span', {}, d)))))),
    h('section', { class: 'auth-panel' }, card)));
  username.focus();
}
