// Сводка по графу: сущности по типам, связи, последние прогоны построения.
// Количество сущностей с типом unknown вынесено отдельно — это основная очередь на
// ручную типизацию (автоклассификатор ставит unknown всему, что не совпало с онтологией).

import { getGraphStats, startGraphBuild } from '../../api/graph.js';
import { downloadGraphArchive, downloadChunksArchive } from '../../api/export.js';
import { toast } from '../../components/toast.js';

export function mountGraphStats(host) {
  const root = document.createElement('div');
  root.className = 'graph-stats';
  host.replaceChildren(root);

  async function refresh() {
    root.textContent = 'Загрузка…';
    try {
      const data = await getGraphStats();
      render(data);
    } catch (err) {
      root.textContent = '';
      const msg = document.createElement('div');
      msg.className = 'muted';
      msg.textContent = `Не удалось получить состояние графа: ${err?.payload?.detail || err.message}`;
      root.append(msg);
    }
  }

  function render(data) {
    root.replaceChildren();

    const unknown = (data.entities_by_type || []).find((r) => r.entity_type === 'unknown');
    const summary = document.createElement('div');
    summary.className = 'graph-stats__summary';
    summary.append(
      metric('Сущностей', data.entities_total ?? 0),
      metric('Связей', data.relations_total ?? 0),
      metric('Алиасов', data.aliases_total ?? 0),
      metric('Без типа (unknown)', unknown ? unknown.count : 0),
      metric('В стоп-листе', data.blocklist_total ?? 0),
    );
    root.append(summary);

    if ((data.entities_by_type || []).length) {
      root.append(buildTable(
        ['Тип', 'Сущностей'],
        data.entities_by_type.map((r) => [r.entity_type, String(r.count)]),
      ));
    }

    if ((data.recent_runs || []).length) {
      const title = document.createElement('div');
      title.className = 'graph-stats__subtitle';
      title.textContent = 'Последние прогоны построения';
      root.append(title);
      root.append(buildTable(
        ['Тип', 'Статус', 'Онтология', 'Начало', 'Триплетов'],
        data.recent_runs.map((run) => [
          run.run_type,
          run.status,
          run.ontology_version || '—',
          run.started_at ? run.started_at.replace('T', ' ').slice(0, 19) : '—',
          String(run.stats?.triplets_extracted ?? '—'),
        ]),
      ));
    }

    const actions = document.createElement('div');
    actions.className = 'graph-stats__actions';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.className = 'btn';
    reload.textContent = 'Обновить';
    reload.addEventListener('click', () => { refresh().catch(() => toast.error('Не удалось обновить')); });
    actions.append(reload);

    // Пересборка графа. Прогон один на всю систему, поэтому кнопка блокируется, пока
    // сервис сообщает о запущенном прогоне: параллельный запуск он всё равно отклонит (409),
    // но лучше не давать нажать, чем показывать ошибку.
    const running = (data.recent_runs || []).some((run) => run.status === 'running');
    const build = document.createElement('button');
    build.type = 'button';
    build.className = 'btn btn--danger';
    build.textContent = running ? 'Сборка идёт…' : 'Собрать граф заново';
    build.disabled = running;
    build.addEventListener('click', onBuildClick);
    actions.append(build);

    // Выгрузки. Граф и чанки — разные архивы: у них разный жизненный цикл (граф
    // пересобирается, чанки переиндексируются) и сильно разный объём.
    actions.append(
      downloadButton('Скачать граф', () => downloadGraphArchive()),
      downloadButton('Скачать чанки', () => downloadChunksArchive({ embeddings: true })),
    );

    const note = document.createElement('div');
    note.className = 'muted';
    note.textContent = running
      ? 'Идёт пересборка. Состояние обновляется автоматически.'
      : 'Полная пересборка по всем проиндексированным документам. Занимает время и заменяет текущий граф.';
    root.append(actions, note);

    if (running) scheduleAutoRefresh();
  }

  // Кнопка блокируется на время скачивания: архив собирается на сервере, и повторное
  // нажатие запустило бы вторую сборку впустую.
  function downloadButton(label, run) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn';
    btn.textContent = label;
    btn.addEventListener('click', async () => {
      const original = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Готовим архив…';
      try {
        const res = await run();
        const mb = res?.size ? (res.size / 1024 / 1024).toFixed(1) : null;
        toast.success(mb ? `Архив скачан, ${mb} МБ, строк: ${res.rows ?? '—'}` : 'Архив скачан');
      } catch (err) {
        toast.error(err?.payload?.detail || err.message || 'Не удалось выгрузить');
      } finally {
        btn.disabled = false;
        btn.textContent = original;
      }
    });
    return btn;
  }

  async function onBuildClick() {
    const ok = window.confirm(
      'Запустить полную пересборку графа?\n\n'
      + 'Граф будет построен заново по всем проиндексированным документам. '
      + 'Операция длительная, во время неё запустить вторую нельзя.',
    );
    if (!ok) return;
    try {
      const res = await startGraphBuild();
      toast.success(res?.run_type === 'full_rebuild' ? 'Пересборка запущена' : 'Сборка запущена');
      await refresh();
    } catch (err) {
      // 409 — прогон уже идёт, 403 — запуск через API выключен в конфигурации сервиса.
      toast.error(err?.payload?.detail || err.message || 'Не удалось запустить сборку');
      await refresh().catch(() => {});
    }
  }

  // Пока прогон идёт, сводка обновляется сама: иначе за долгой сборкой пришлось бы следить
  // кнопкой «Обновить». Таймер один — повторный вызов его пересоздаёт.
  let autoTimer = null;
  function scheduleAutoRefresh() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      autoTimer = null;
      refresh().catch(() => {});
    }, 5000);
  }

  refresh();

  return {
    refresh,
    unmount() {
      if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
      root.replaceChildren();
    },
  };
}

function metric(label, value) {
  const box = document.createElement('div');
  box.className = 'graph-stats__metric';
  const v = document.createElement('div');
  v.className = 'graph-stats__metric-value';
  v.textContent = String(value);
  const l = document.createElement('div');
  l.className = 'graph-stats__metric-label';
  l.textContent = label;
  box.append(v, l);
  return box;
}

function buildTable(headers, rows) {
  const wrap = document.createElement('div');
  wrap.className = 'graph-stats__table-wrap';
  const table = document.createElement('table');
  table.className = 'table';

  const thead = document.createElement('thead');
  const hrow = document.createElement('tr');
  headers.forEach((h) => {
    const th = document.createElement('th');
    th.textContent = h;
    hrow.append(th);
  });
  thead.append(hrow);

  const tbody = document.createElement('tbody');
  rows.forEach((cells) => {
    const tr = document.createElement('tr');
    cells.forEach((c) => {
      const td = document.createElement('td');
      td.textContent = c;
      tr.append(td);
    });
    tbody.append(tr);
  });

  table.append(thead, tbody);
  wrap.append(table);
  return wrap;
}
