// Импорт HTML в MinIO для library.documents с content_type='html' и origin_url.
// POST /api/minio/import/html-from-documents (form: dry_run, force, limit).
// Бэк сам скачивает каждую страницу, кладёт в MinIO, обновляет storage_key.
//
// Кнопки: «Dry-run» / «Применить» (после успешного dry-run для текущих флагов).
// Флаги: dry_run, force (переимпортировать уже загруженные), limit (число).

import { createStore } from '../../state/store.js';
import { createInput } from '../../components/form-controls.js';
import { createErrorView } from '../../components/error-view.js';
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
    if (s.plan?.counts) {
      const counts = document.createElement('div');
      counts.className = 'minio-import-html__plan-counts';
      counts.textContent = `Всего: ${s.plan.counts.total} · ожидают: ${s.plan.counts.pending} · уже загружено: ${s.plan.counts.already_loaded}`;
      wrap.append(counts);
    } else if (s.plan) {
      const pre = document.createElement('pre');
      pre.className = 'minio-import-html__plan-pre';
      try { pre.textContent = JSON.stringify(s.plan, null, 2); } catch { pre.textContent = String(s.plan); }
      const det = document.createElement('details');
      const sum = document.createElement('summary'); sum.textContent = 'Показать план';
      det.append(sum, pre);
      wrap.append(det);
    }
    return wrap;
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
    applyBtn.disabled = !!s.busy || !ready;
    applyBtn.title = ready ? 'Применить (dry-run прошёл)' : 'Сначала Dry-run, потом Применить';
    applyBtn.addEventListener('click', () => run(false));

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
