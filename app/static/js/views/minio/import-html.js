// Импорт HTML в MinIO для library.documents с content_type='html' и origin_url.
// POST /api/minio/import/html-from-documents (form: dry_run, force, limit).
// Бэк сам скачивает каждую страницу, кладёт в MinIO, обновляет storage_key.
//
// Кнопки: «Dry-run» / «Применить» — независимы; без свежего успешного dry-run
// «Применить» переспрашивает. Флаги: force (перекачать уже загруженные), limit (число).

import { createStore } from '../../state/store.js';
import { createInput } from '../../components/form-controls.js';
import { createErrorView } from '../../components/error-view.js';
import { confirmApplyWithoutDryRun } from '../../components/confirm-no-dry-run.js';
import { toast } from '../../components/toast.js';
import { importHtmlFromDocuments, getHtmlImportPlan } from '../../api/minio.js';

const STATUS_LEVEL = {
  imported:                'success',
  dry_run:                 'success',
  download_failed:         'error',
  upload_failed:           'error',
  db_failed:               'error',
  skipped_non_html_response: 'warning',
};
const TABS = ['success', 'warning', 'error', 'stats'];

export function mountMinioImportHtml(container, { onImported } = {}) {
  const store = createStore({
    dryRun: true,
    force: false,
    limit: '',
    busy: null,
    lastDryRun: null,
    report: null,
    reportKind: null,
    error: null,
    plan: null,
    planView: 'list',   // 'list' | 'json'
    activeTab: 'stats',
  });

  const root = document.createElement('div');
  root.className = 'minio-import-html';
  container.replaceChildren(root);

  const unsubscribe = store.subscribe(render);
  loadPlan();
  render();
  return () => unsubscribe();

  function render() {
    const s = store.get();
    root.replaceChildren();
    root.append(buildPlan(s));
    root.append(buildForm(s));
    root.append(buildActions(s));
    if (s.error) root.append(createErrorView(s.error));
    if (s.report) root.append(buildReport(s));
  }

  function buildPlan(s) {
    const wrap = document.createElement('div');
    wrap.className = 'minio-import-html__plan';
    const head = document.createElement('div');
    head.className = 'minio-import-html__plan-head';
    head.textContent = 'Кандидаты — library.documents с content_type=\'html\' и непустым origin_url.';
    wrap.append(head);

    if (!s.plan) return wrap;

    const summary = s.plan.summary || {};
    const counts = document.createElement('div');
    counts.className = 'minio-import-html__plan-counts';
    counts.textContent =
      `Всего: ${summary.total_html_documents ?? '—'} · ` +
      `ожидают: ${summary.pending ?? '—'} · ` +
      `уже загружено: ${summary.already_loaded ?? '—'}`;
    wrap.append(counts);

    // Переключатель «Список / JSON».
    const toggle = document.createElement('div');
    toggle.className = 'minio-import-html__plan-toggle';
    for (const [mode, label] of [['list', 'Список'], ['json', 'JSON']]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn${s.planView === mode ? ' minio-import-html__tab--active' : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => store.set({ planView: mode }));
      toggle.append(b);
    }
    wrap.append(toggle);

    if (s.planView === 'json') {
      const pre = document.createElement('pre');
      pre.className = 'minio-import-html__plan-pre';
      try { pre.textContent = JSON.stringify(s.plan, null, 2); } catch { pre.textContent = String(s.plan); }
      wrap.append(pre);
    } else {
      wrap.append(buildPlanList('Ожидают загрузки', s.plan.pending || [], 'pending'));
      wrap.append(buildPlanList('Уже загружены', s.plan.already_loaded || [], 'loaded'));
    }
    return wrap;
  }

  function buildPlanList(title, items, kind) {
    const box = document.createElement('div');
    box.className = 'minio-import-html__plan-section';
    const h = document.createElement('div');
    h.className = 'minio-import-html__plan-section-title';
    h.textContent = `${title} (${items.length})`;
    box.append(h);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'minio-import-html__plan-empty';
      empty.textContent = kind === 'pending' ? 'Нет документов в очереди.' : 'Пока ничего не загружено.';
      box.append(empty);
      return box;
    }

    const ul = document.createElement('ul');
    ul.className = 'minio-import-html__plan-items';
    for (const it of items) {
      const li = document.createElement('li');
      li.className = `minio-import-html__plan-item minio-import-html__plan-item--${kind}`;
      const name = document.createElement('div');
      name.className = 'minio-import-html__plan-item-title';
      name.textContent = it.title || it.document_id || '<документ>';
      const url = document.createElement('div');
      url.className = 'minio-import-html__plan-item-url';
      url.textContent = it.origin_url || '';
      url.title = it.origin_url || '';
      li.append(name, url);
      ul.append(li);
    }
    box.append(ul);
    return box;
  }

  function buildForm(s) {
    const wrap = document.createElement('div');
    wrap.className = 'minio-import-html__form';

    const forceLbl = document.createElement('label');
    const forceCb = document.createElement('input');
    forceCb.type = 'checkbox';
    forceCb.checked = s.force;
    forceCb.addEventListener('change', () => store.set({ force: forceCb.checked, lastDryRun: null }));
    forceLbl.append(forceCb, document.createTextNode(' force (переимпортировать уже загруженные)'));
    wrap.append(forceLbl);

    const limitInput = createInput({
      value: s.limit,
      placeholder: 'число (пусто = все)',
      onInput: (val) => store.set({ limit: val, lastDryRun: null }),
    });
    limitInput.type = 'number';
    limitInput.classList.add('minio-import-html__limit');
    const limitLbl = document.createElement('label');
    limitLbl.className = 'minio-import-html__field';
    const sp = document.createElement('span'); sp.textContent = 'Limit: ';
    limitLbl.append(sp, limitInput);
    wrap.append(limitLbl);

    const hint = document.createElement('div');
    hint.className = 'minio-import-html__limit-hint';
    hint.textContent = '⚠ Без лимита обрабатываются ВСЕ документы — даже dry-run может идти долго. Для проверки поставьте 1–2.';
    wrap.append(hint);

    return wrap;
  }

  function buildActions(s) {
    const wrap = document.createElement('div');
    wrap.className = 'minio-import-html__actions';

    const dryBtn = document.createElement('button');
    dryBtn.type = 'button';
    dryBtn.className = 'btn';
    dryBtn.textContent = s.busy === 'dry-run' ? 'Dry-run идёт…' : 'Dry-run';
    dryBtn.disabled = !!s.busy;
    dryBtn.addEventListener('click', () => run(true));

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn--primary';
    applyBtn.textContent = s.busy === 'apply' ? 'Импорт идёт…' : 'Применить';
    const ready = s.lastDryRun && s.lastDryRun.signature === currentSignature();
    applyBtn.disabled = !!s.busy;
    applyBtn.title = ready
      ? 'Dry-run прошёл на этих параметрах — импорт пройдёт так же'
      : 'Dry-run на текущих параметрах не проходил: план не проверен';
    applyBtn.addEventListener('click', () => {
      if (ready) {
        run(false);
        return;
      }
      confirmApplyWithoutDryRun({
        text: 'Dry-run на текущих параметрах не проходил — доступность страниц по origin_url и очистка HTML не проверены.',
        warning: s.force
          ? '⚠ force включён: страницы будут перекачаны и перезаписаны даже для уже загруженных документов.'
          : null,
        onConfirm: () => run(false),
      });
    });

    wrap.append(dryBtn, applyBtn);
    return wrap;
  }

  function buildReport({ report, reportKind, activeTab }) {
    const wrap = document.createElement('div');
    wrap.className = `minio-import-html__report minio-import-html__report--${report.ok ? 'ok' : 'fail'}`;

    const head = document.createElement('div');
    head.className = 'minio-import-html__report-head';
    head.textContent =
      `${report.ok ? '✓' : '✗'} ${reportKind === 'dry-run' ? 'Dry-run' : 'Импорт'} · ` +
      `выбрано: ${report.selected ?? '—'}`;
    wrap.append(head);

    const itemsList = report.items || report.results || report.processed || [];
    const buckets = { success: [], warning: [], error: [] };
    for (const r of itemsList) {
      const lvl = STATUS_LEVEL[r.status] || 'warning';
      buckets[lvl].push(r);
    }
    const counts = {
      success: buckets.success.length,
      warning: buckets.warning.length,
      error:   buckets.error.length,
      stats:   Object.keys(report.stats || {}).length,
    };

    const tabs = document.createElement('div');
    tabs.className = 'minio-import-html__tabs';
    for (const t of TABS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `btn${activeTab === t ? ' minio-import-html__tab--active' : ''}`;
      tab.textContent = `${tabLabel(t)} (${counts[t]})`;
      tab.addEventListener('click', () => store.set({ activeTab: t }));
      tabs.append(tab);
    }
    wrap.append(tabs);

    const body = document.createElement('div');
    body.className = 'minio-import-html__tab-body';
    if (activeTab === 'stats') body.append(renderStats(report.stats));
    else body.append(renderResults(buckets[activeTab]));
    wrap.append(body);
    return wrap;
  }

  // ----- ops -----

  async function loadPlan() {
    try {
      const plan = await getHtmlImportPlan({ trackAs: 'MinIO HTML-plan' });
      store.set({ plan });
    } catch (_e) { /* не блокирует */ }
  }

  function currentSignature() {
    const { force, limit } = store.get();
    return `force=${force}|limit=${limit}`;
  }

  async function run(dryRunFlag) {
    const s = store.get();
    if (s.busy) return;
    const limit = s.limit === '' ? null : Number(s.limit);
    if (s.limit !== '' && !Number.isFinite(limit)) { toast.warn('Limit должен быть числом'); return; }
    store.set({ busy: dryRunFlag ? 'dry-run' : 'apply', report: null, error: null });
    const sig = currentSignature();
    try {
      const report = await importHtmlFromDocuments(
        { dryRun: dryRunFlag, force: s.force, limit },
        { trackAs: dryRunFlag ? 'MinIO HTML dry-run' : 'MinIO HTML import' },
      );
      const next = {
        busy: null,
        report,
        reportKind: dryRunFlag ? 'dry-run' : 'apply',
        activeTab: pickInitialTab(report),
      };
      if (dryRunFlag && report?.ok) next.lastDryRun = { signature: sig };
      if (!dryRunFlag) next.lastDryRun = null;
      store.set(next);
      if (dryRunFlag) toast[report?.ok ? 'success' : 'warn'](report?.ok ? 'Dry-run прошёл' : 'Dry-run нашёл проблемы');
      else { toast[report?.ok ? 'success' : 'error'](report?.ok ? 'Импорт HTML применён' : 'HTML-импорт с ошибками'); onImported?.(); }
      // Перезагрузим plan для счётчиков.
      loadPlan();
    } catch (err) {
      store.set({ busy: null, error: err });
    }
  }
}

// ===== helpers =====

function tabLabel(t) {
  switch (t) {
    case 'success': return 'Готово';
    case 'warning': return 'Предупреждения';
    case 'error':   return 'Ошибки';
    case 'stats':   return 'Сводка';
    default:        return t;
  }
}

function pickInitialTab(report) {
  const items = report.items || report.results || report.processed || [];
  const errors = items.filter((r) => STATUS_LEVEL[r.status] === 'error').length;
  const warns  = items.filter((r) => STATUS_LEVEL[r.status] === 'warning').length;
  if (errors) return 'error';
  if (warns) return 'warning';
  return 'success';
}

function renderStats(stats) {
  const wrap = document.createElement('div');
  if (!stats) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Бэк не вернул stats.';
    wrap.append(empty); return wrap;
  }
  const t = document.createElement('table');
  t.className = 'minio-import-html__stats';
  const tbody = document.createElement('tbody');
  for (const [k, v] of Object.entries(stats)) {
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.textContent = k;
    const td = document.createElement('td'); td.textContent = String(v);
    tr.append(th, td); tbody.append(tr);
  }
  t.append(tbody); wrap.append(t); return wrap;
}

function renderResults(items) {
  const wrap = document.createElement('div');
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Пусто.';
    wrap.append(empty); return wrap;
  }
  const ul = document.createElement('ul');
  ul.className = 'minio-import-html__results';
  for (const r of items) {
    const li = document.createElement('li');
    li.className = `minio-import-html__result minio-import-html__result--${r.status}`;
    const head = document.createElement('div');
    head.className = 'minio-import-html__result-head';
    const label = r.title || r.document_id || r.url || '<doc>';
    head.textContent = `${label} · ${r.status}`;
    li.append(head);
    if (r.message) {
      const msg = document.createElement('div');
      msg.className = 'minio-import-html__result-message';
      msg.textContent = r.message;
      li.append(msg);
    }
    const det = document.createElement('details');
    const sum = document.createElement('summary'); sum.textContent = 'детали';
    const pre = document.createElement('pre');
    try { pre.textContent = JSON.stringify(r, null, 2); } catch { pre.textContent = String(r); }
    det.append(sum, pre);
    li.append(det);
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}
