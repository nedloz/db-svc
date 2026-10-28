// Вкладка «Настройки проекта» — только чтение: активный LLM, эмбеддинги, GraphRAG.
// Значения вставляются через textContent, элементов управления нет.

import { getProjectSettings } from '../../api/settings.js';

const MODE_LABELS = {
  router: 'внешний роутер (router)',
  ollama: 'локальный Ollama (ollama)',
  unknown: 'не определён (config.json llm-proxy не найден или некорректен)',
};

function buildRows(s) {
  return [
    ['Режим LLM', MODE_LABELS[s.llm?.mode] || String(s.llm?.mode ?? '')],
    ['Модель LLM', s.llm?.model || '—'],
    ['Модель эмбеддингов', s.embeddings?.model ?? '—'],
    ['Размерность эмбеддингов', String(s.embeddings?.dimension ?? '—')],
    ['GraphRAG', s.graphrag?.enabled ? 'включён' : 'отключён'],
    ['Пайплайн', s.pipeline ?? '—'],
  ];
}

export const settingsView = {
  title: 'Настройки проекта',
  hash: '#/settings',
  mount(container) {
    const root = document.createElement('div');
    root.className = 'settings-view';
    const card = document.createElement('section');
    card.className = 'card';

    const header = document.createElement('div');
    header.className = 'card__header';
    const title = document.createElement('h2');
    title.className = 'card__title';
    title.textContent = 'Настройки проекта';
    header.append(title);
    const subtitle = document.createElement('div');
    subtitle.className = 'card__subtitle';
    subtitle.textContent = 'Действующие настройки, только для просмотра.';
    const body = document.createElement('div');
    body.className = 'card__body';
    body.textContent = 'Загрузка…';
    card.append(header, subtitle, body);
    root.append(card);
    container.replaceChildren(root);

    let disposed = false;
    getProjectSettings()
      .then((s) => {
        if (disposed) return;
        const dl = document.createElement('dl');
        dl.className = 'settings-view__list';
        for (const [label, value] of buildRows(s)) {
          const dt = document.createElement('dt');
          dt.textContent = label;
          const dd = document.createElement('dd');
          dd.textContent = value;
          dl.append(dt, dd);
        }
        body.replaceChildren(dl);
      })
      .catch((err) => {
        if (!disposed) body.textContent = `Не удалось загрузить настройки: ${err.message || err}`;
      });

    return () => {
      disposed = true;
    };
  },
};
