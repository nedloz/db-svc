// Entry-point. Монтирует shell (header-card + main), регистрирует view'ы,
// разруливает hash-routing, держит состояние health (API + DB) и token.
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
  health: { api: 'unknown', db: 'unknown', lastSync: null },
  tokenStatus: getToken() ? 'saved' : 'empty',
});

let currentUnmount = null;
let mainRef = null;

mountShell();
attachRouter();
refreshHealth();
setInterval(refreshHealth, HEALTH_INTERVAL_MS);

// ---------- Shell ----------

function mountShell() {
  root.replaceChildren(buildHeaderCard(), buildMain());
  renderActiveView();
}

function buildHeaderCard() {
  // Grid 3×2 (см. layout.css). Дочерние элементы сами расставляются по
  // grid-column/grid-row через свои классы — порядок append'а неважен.
  const header = document.createElement('header');
  header.className = 'app-header';

  // ─── Строка 1 ───
  const title = document.createElement('h1');
  title.className = 'app-header__title';
  title.textContent = 'ADMIN CONSOLE';

  const statuses = document.createElement('div');
  statuses.className = 'app-header__status-group';
  const apiBadge = makeStatusBadge('API', { onlineLabel: 'API Online', offlineLabel: 'API не подключен' });
  const dbBadge = makeStatusBadge('DB', { onlineLabel: 'DB подключен', offlineLabel: 'DB не подключен' });
  const syncBadge = makeSyncBadge();
  statuses.append(apiBadge.el, dbBadge.el, syncBadge.el);

  store.subscribe(({ health }) => {
    apiBadge.update(health.api);
    dbBadge.update(health.db);
    syncBadge.update(health.lastSync);
  });

  const topActions = document.createElement('div');
  topActions.className = 'app-header__actions';

  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn';
  refreshBtn.textContent = 'Обновить';
  refreshBtn.addEventListener('click', () => {
    refreshHealth();
    renderActiveView();
  });

  const logoutBtn = document.createElement('button');
  logoutBtn.type = 'button';
  logoutBtn.className = 'btn';
  logoutBtn.textContent = 'Выйти';
  logoutBtn.addEventListener('click', () => {
    setToken('');
    store.set({ tokenStatus: 'empty' });
    toast.success('Токен очищен');
    refreshHealth();
  });

  // operations-indicator скрыт по дизайну (дизайнер не нарисовал бейдж).
  // Логика операций живёт в state/operations.js — функционал не удаляем.
  // Когда дизайн добавит индикатор — раскомментировать строку ниже.
  // const opsIndicator = createOperationsIndicator();

  topActions.append(refreshBtn, logoutBtn);

  // ─── Строка 2 ───
  const nav = document.createElement('nav');
  nav.className = 'app-nav';
  for (const view of VIEWS) {
    const tab = document.createElement('button');
    tab.className = 'tab';
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
    nav.querySelectorAll('.tab').forEach((tab) => {
      tab.classList.toggle('tab--active', tab.dataset.hash === activeHash);
    });
  });

  // Token group (input + статус-текст под ним)
  const tokenGroup = document.createElement('div');
  tokenGroup.className = 'app-header__token-group';

  const tokenInput = document.createElement('input');
  tokenInput.type = 'password';
  tokenInput.className = 'input input--pill';
  tokenInput.placeholder = 'Введите токен';
  tokenInput.value = getToken();
  tokenInput.autocomplete = 'off';

  const tokenStatus = document.createElement('div');
  tokenStatus.className = 'app-header__token-status';
  store.subscribe(({ tokenStatus: s }) => {
    tokenStatus.textContent = s === 'saved' ? 'Статус: токен сохранён' : 'Статус: не сохранён';
  });

  tokenGroup.append(tokenInput, tokenStatus);

  // Token buttons (отдельная ячейка grid, правая колонка строки 2)
  const tokenButtons = document.createElement('div');
  tokenButtons.className = 'app-header__token-buttons';

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'btn btn--primary';
  saveBtn.textContent = 'Сохранить';
  saveBtn.addEventListener('click', () => {
    const value = tokenInput.value.trim();
    setToken(value);
    store.set({ tokenStatus: value ? 'saved' : 'empty' });
    toast.success(value ? 'Токен сохранён' : 'Токен очищен');
    refreshHealth();
  });

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'btn';
  clearBtn.textContent = 'Очистить';
  clearBtn.addEventListener('click', () => {
    tokenInput.value = '';
    setToken('');
    store.set({ tokenStatus: 'empty' });
    toast.success('Токен очищен');
    refreshHealth();
  });

  tokenButtons.append(saveBtn, clearBtn);

  header.append(title, statuses, topActions, nav, tokenGroup, tokenButtons);
  return header;
}

function makeStatusBadge(label, { onlineLabel, offlineLabel }) {
  const el = document.createElement('span');
  el.className = 'status-badge';
  el.textContent = `${label}: …`;
  return {
    el,
    update(state) {
      el.classList.remove('status-badge--ok', 'status-badge--error', 'status-badge--warn');
      if (state === 'ok') {
        el.classList.add('status-badge--ok');
        el.textContent = onlineLabel;
      } else if (state === 'warn') {
        el.classList.add('status-badge--warn');
        el.textContent = offlineLabel;
      } else if (state === 'error') {
        el.classList.add('status-badge--error');
        el.textContent = offlineLabel;
      } else {
        el.textContent = `${label}: …`;
      }
    },
  };
}

function makeSyncBadge() {
  const el = document.createElement('span');
  el.className = 'status-badge status-badge--plain';
  el.textContent = 'Last sync: —';
  return {
    el,
    update(ts) {
      if (!ts) { el.textContent = 'Last sync: —'; return; }
      const diff = Date.now() - ts;
      if (diff < 30000) el.textContent = 'Last sync: Just now';
      else if (diff < 60000) el.textContent = 'Last sync: <1 min ago';
      else el.textContent = `Last sync: ${Math.floor(diff / 60000)} min ago`;
    },
  };
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
  const next = { api: 'unknown', db: 'unknown', lastSync: store.get().health.lastSync };
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
  next.lastSync = Date.now();
  store.set({ health: next });
}
