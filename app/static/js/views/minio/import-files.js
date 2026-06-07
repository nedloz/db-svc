// Импорт файлов в MinIO с привязкой к library.documents по title.
// POST /api/minio/import/files (multipart). Бэк возвращает stats + per-file
// results с разными статусами (imported / dry_run / unmatched / type_mismatch /
// upload_failed / db_failed / skipped_unsupported).
//
// UX как у M8: «Dry-run» (всегда доступен), «Применить» (разблокируется только
// после успешного dry-run для текущего набора файлов). Отчёт — табы.

import { createStore } from '../../state/store.js';
import { createErrorView } from '../../components/error-view.js';
import { createFilePicker } from '../../components/form-controls.js';
import { toast } from '../../components/toast.js';
import { importFilesToMinio, getImportPlan } from '../../api/minio.js';

const STATUS_LEVEL = {
  imported:            'success',
  dry_run:             'success',
  unmatched:           'warning',
  type_mismatch:       'warning',
  skipped_unsupported: 'warning',
  upload_failed:       'error',
  db_failed:           'error',
};
const TABS = ['success', 'warning', 'error', 'stats'];

export function mountMinioImportFiles(container, { onImported } = {}) {
  const store = createStore({
    files: [],
    busy: null,                  // null | 'dry-run' | 'apply'
    lastDryRun: null,            // { signature }
    report: null,
    reportKind: null,
    error: null,
    plan: null,
    activeTab: 'stats',
  });

  const root = document.createElement('div');
  root.className = 'minio-import-files';
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
    wrap.className = 'minio-import-files__plan';
    const head = document.createElement('div');
    head.className = 'minio-import-files__plan-head';
    head.textContent = 'План импорта: фронт пошлёт файлы как есть; бэк сам сматчит filename (без расширения) ↔ library.documents.title и проверит content_type.';
    wrap.append(head);
    if (s.plan && typeof s.plan === 'object') {
      const pre = document.createElement('pre');
      pre.className = 'minio-import-files__plan-pre';
      try { pre.textContent = JSON.stringify(s.plan, null, 2); }
      catch (_e) { pre.textContent = String(s.plan); }
      const det = document.createElement('details');
      det.className = 'minio-import-files__plan-details';
      const sum = document.createElement('summary');
      sum.textContent = 'Показать ответ /import-plan';
      det.append(sum, pre);
      wrap.append(det);
    }
    return wrap;
  }

  function buildForm(s) {
    const wrap = document.createElement('div');
    wrap.className = 'minio-import-files__form';

    const lbl = document.createElement('div');
    lbl.className = 'minio-import-files__field';
    const cap = document.createElement('span'); cap.textContent = 'Файлы для импорта: ';
    const picker = createFilePicker({
      multiple: true,
      label: 'Выберите файлы',
      onChange: (files) => {
        store.set({ files: files || [], lastDryRun: null, report: null, error: null });
      },
    });
    lbl.append(cap, picker);
    wrap.append(lbl);

    if (s.files.length) {
      const ul = document.createElement('ul');
      ul.className = 'minio-import-files__list';
      for (const f of s.files) {
        const li = document.createElement('li');
        li.className = 'minio-import-files__list-item';
        const name = document.createElement('span');
        name.textContent = `${f.name} · ${formatBytes(f.size)}`;
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn btn--danger minio-import-files__remove';
        removeBtn.textContent = 'Убрать';
        removeBtn.addEventListener('click', () => {
          const next = s.files.filter((x) => x !== f);
          store.set({ files: next, lastDryRun: null, report: null, error: null });
        });
        li.append(name, removeBtn);
        ul.append(li);
      }
      wrap.append(ul);
    }
    return wrap;
  }

  function buildActions(s) {
    const wrap = document.createElement('div');
    wrap.className = 'minio-import-files__actions';

    const dryBtn = document.createElement('button');
    dryBtn.type = 'button';
    dryBtn.className = 'btn';
    dryBtn.textContent = s.busy === 'dry-run' ? 'Dry-run идёт…' : 'Dry-run';
    dryBtn.disabled = !!s.busy || !s.files.length;
    dryBtn.addEventListener('click', () => run(true));

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn--primary';
    applyBtn.textContent = s.busy === 'apply' ? 'Импорт идёт…' : 'Применить';
    const applyReady = s.lastDryRun && s.lastDryRun.signature === currentSignature();
    applyBtn.disabled = !!s.busy || !applyReady;
    applyBtn.title = applyReady
      ? 'Применить (dry-run прошёл, файлы не менялись)'
      : 'Сначала Dry-run, потом «Применить»';
    applyBtn.addEventListener('click', () => run(false));

    wrap.append(dryBtn, applyBtn);
    return wrap;
  }

  function buildReport({ report, reportKind, activeTab }) {
    const wrap = document.createElement('div');
    wrap.className = `minio-import-files__report minio-import-files__report--${report.ok ? 'ok' : 'fail'}`;
    const head = document.createElement('div');
    head.className = 'minio-import-files__report-head';
    head.textContent =
      `${report.ok ? '✓' : '✗'} ${reportKind === 'dry-run' ? 'Dry-run' : 'Импорт'} · ` +
      `dry_run=${report.stats?.dry_run} · файлов: ${report.stats?.total_files}`;
    wrap.append(head);

    if (report.message) {
      const msg = document.createElement('div');
      msg.className = 'minio-import-files__report-message';
      msg.textContent = report.message;
      wrap.append(msg);
    }
    if (report.duplicate_titles?.length) {
      const dup = document.createElement('div');
      dup.className = 'minio-import-files__dup';
      dup.textContent = `⚠ В library.documents есть дубли по title: ${report.duplicate_titles.join(', ')}`;
      wrap.append(dup);
    }

    const buckets = {
      success: [], warning: [], error: [],
    };
    for (const r of (report.results || [])) {
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
    tabs.className = 'minio-import-files__tabs';
    for (const t of TABS) {
      const tab = document.createElement('button');
      tab.type = 'button';
      tab.className = `btn${activeTab === t ? ' minio-import-files__tab--active' : ''}`;
      tab.textContent = `${tabLabel(t)} (${counts[t]})`;
      tab.addEventListener('click', () => store.set({ activeTab: t }));
      tabs.append(tab);
    }
    wrap.append(tabs);

    const body = document.createElement('div');
    body.className = 'minio-import-files__tab-body';
    if (activeTab === 'stats') body.append(renderStats(report.stats));
    else body.append(renderResults(buckets[activeTab]));
    wrap.append(body);
    return wrap;
  }

  // ----- ops -----

  async function loadPlan() {
    try {
      const plan = await getImportPlan({ trackAs: 'MinIO import-plan' });
      store.set({ plan });
    } catch (_err) {
      // Не блокирующая — план просто не покажется.
    }
  }

  function currentSignature() {
    return store.get().files.map((f) => `${f.name}:${f.size}:${f.lastModified}`).join('|');
  }

  async function run(dryRunFlag) {
    const s = store.get();
    if (s.busy) return;
    if (!s.files.length) { toast.warn('Выберите файлы'); return; }
    store.set({ busy: dryRunFlag ? 'dry-run' : 'apply', report: null, error: null });
    const sig = currentSignature();
    try {
      const report = await importFilesToMinio(
        { files: s.files, dryRun: dryRunFlag },
        { trackAs: dryRunFlag ? 'MinIO import-files dry-run' : 'MinIO import-files' },
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
      else { toast[report?.ok ? 'success' : 'error'](report?.ok ? 'Импорт применён' : 'Импорт завершился с ошибками'); onImported?.(); }
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
  const errors = (report.results || []).filter((r) => STATUS_LEVEL[r.status] === 'error').length;
  const warns  = (report.results || []).filter((r) => STATUS_LEVEL[r.status] === 'warning').length;
  if (errors) return 'error';
  if (warns) return 'warning';
  return 'success';
}

function renderStats(stats) {
  const wrap = document.createElement('div');
  if (!stats) return wrap;
  const t = document.createElement('table');
  t.className = 'minio-import-files__stats';
  const tbody = document.createElement('tbody');
  for (const [k, v] of Object.entries(stats)) {
    const tr = document.createElement('tr');
    const th = document.createElement('th'); th.textContent = k;
    const td = document.createElement('td'); td.textContent = String(v);
    tr.append(th, td);
    tbody.append(tr);
  }
  t.append(tbody);
  wrap.append(t);
  return wrap;
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
  ul.className = 'minio-import-files__results';
  for (const r of items) {
    const li = document.createElement('li');
    li.className = `minio-import-files__result minio-import-files__result--${r.status}`;
    const head = document.createElement('div');
    head.className = 'minio-import-files__result-head';
    head.textContent = `${r.filename || '<no-file>'} · ${r.status}`;
    li.append(head);
    if (r.message) {
      const msg = document.createElement('div');
      msg.className = 'minio-import-files__result-message';
      msg.textContent = r.message;
      li.append(msg);
    }
    const details = document.createElement('details');
    details.className = 'minio-import-files__result-details';
    const sum = document.createElement('summary'); sum.textContent = 'детали';
    const pre = document.createElement('pre');
    try { pre.textContent = JSON.stringify(r, null, 2); } catch { pre.textContent = String(r); }
    details.append(sum, pre);
    li.append(details);
    ul.append(li);
  }
  wrap.append(ul);
  return wrap;
}

function formatBytes(n) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(2)} МБ`;
}
