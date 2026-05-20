// Entry-point. Монтирует shell, регистрирует view'ы, разруливает hash-routing,
// держит в шапке поле токена и индикаторы health (API + DB).
//
// Никакой бизнес-логики здесь быть не должно — только склейка слоёв.

import { createStore } from './state/store.js';
import {
  ApiError,
  getToken,
  setToken,
  getHealth,
  getDbConnectionStatus,
} from './api/client.js';
import { toast } from './components/toast.js';
import { createErrorView } from './components/error-view.js';
import { createOperationsIndicator } from './components/operations-indicator.js';

import { dbExplorerView } from './views/db-explorer/index.js';
import { importView } from './views/import/index.js';
import { minioView } from './views/minio/index.js';

const VIEWS = [dbExplorerView, importView, minioView];
const HEALTH_INTERVAL_MS = 30000;

const root = document.getElementById('app');
if (!root) throw new Error('#app root element not found');

const store = createStore({
  activeHash: resolveHash(window.location.hash),
  health: { api: 'unknown', db: 'unknown' },
});

let currentUnmount = null;
let mainRef = null;
let navRef = null;

mountShell();
attachRouter();
refreshHealth();
setInterval(refreshHealth, HEALTH_INTERVAL_MS);

// ---------- Shell ----------

function mountShell() {
  root.replaceChildren(buildHeader(), buildNav(), buildMain());
  renderActiveView();
}

function buildHeader() {
  const header = document.createElement('header');
  header.className = 'app-header';

  const title = document.createElement('h1');
  title.className = 'app-header__title';
  title.textContent = 'db-svc — admin';

  const spacer = document.createElement('div');
  spacer.className = 'app-header__spacer';

  const tokenGroup = document.createElement('div');
  tokenGroup.className = 'app-header__group';
  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.className = 'token-input';
  tokenInput.placeholder = 'Admin token';
  tokenInput.value = getToken();
  tokenInput.autocomplete = 'off';
  tokenInput.addEventListener('change', (e) => {
    const value = e.target.value.trim();
    setToken(value);
    toast.success(value ? 'Токен сохранён' : 'Токен очищен');
    refreshHealth();
  });
  tokenGroup.append(tokenInput);

  const statusGroup = document.createElement('div');
  statusGroup.className = 'app-header__group';
  const apiBadge = makeStatusBadge('API');
  const dbBadge = makeStatusBadge('DB');
  statusGroup.append(apiBadge, dbBadge);

  store.subscribe(({ health }) => {
    apiBadge.update(health.api);
    dbBadge.update(health.db);
  });

  const opsIndicator = createOperationsIndicator();
  header.append(title, spacer, opsIndicator, tokenGroup, statusGroup);
  return header;
}

function makeStatusBadge(label) {
  const el = document.createElement('span');
  el.className = 'status-badge';
  el.textContent = `${label}: …`;
  el.update = (state) => {
    el.classList.remove('status-badge--ok', 'status-badge--error', 'status-badge--warn');
    if (state === 'ok')      el.classList.add('status-badge--ok');
    else if (state === 'error') el.classList.add('status-badge--error');
    else if (state === 'warn')  el.classList.add('status-badge--warn');
    el.textContent = `${label}: ${state}`;
  };
  return el;
}

function buildNav() {
  const nav = document.createElement('nav');
  nav.className = 'app-nav';
  for (const view of VIEWS) {
    const tab = document.createElement('button');
    tab.className = 'app-nav__tab';
    tab.type = 'button';
    tab.textContent = view.title;
    tab.dataset.hash = view.hash;
    tab.addEventListener('click', () => {
      if (window.location.hash === view.hash) return;
      window.location.hash = view.hash;
    });
    nav.append(tab);
  }
  store.subscribe(({ activeHash }) => {
    nav.querySelectorAll('.app-nav__tab').forEach((tab) => {
      tab.classList.toggle('app-nav__tab--active', tab.dataset.hash === activeHash);
    });
  });
  navRef = nav;
  return nav;
}

function buildMain() {
  const main = document.createElement('main');
  main.className = 'app-main';
  main.id = 'app-main';
  mainRef = main;
  return main;
}

// ---------- Routing ----------

function resolveHash(hash) {
  return VIEWS.find((v) => v.hash === hash)?.hash || VIEWS[0].hash;
}

function attachRouter() {
  window.addEventListener('hashchange', () => {
    const next = resolveHash(window.location.hash);
    store.set({ activeHash: next });
    renderActiveView();
  });
  if (!window.location.hash) {
    history.replaceState(null, '', VIEWS[0].hash);
  }
  // Синхронизируем подсветку таба после первого рендера навигации.
  store.set({ activeHash: store.get().activeHash });
}

function renderActiveView() {
  if (!mainRef) return;
  if (currentUnmount) {
    try { currentUnmount(); } catch (_e) { /* swallow */ }
    currentUnmount = null;
  }
  const view = VIEWS.find((v) => v.hash === store.get().activeHash) || VIEWS[0];
  try {
    const result = view.mount(mainRef);
    currentUnmount = typeof result === 'function' ? result : null;
  } catch (err) {
    mainRef.replaceChildren(createErrorView(err));
  }
}

// ---------- Health ----------

async function refreshHealth() {
  const next = { api: 'unknown', db: 'unknown' };
  try {
    await getHealth({ timeout: 5000 });
    next.api = 'ok';
  } catch (_e) {
    next.api = 'error';
  }
  try {
    const status = await getDbConnectionStatus({ timeout: 5000 });
    next.db = status?.ok ? 'ok' : 'error';
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
      next.db = 'warn';
    } else {
      next.db = 'error';
    }
  }
  store.set({ health: next });
}
