// Список сущностей слева, карточка выбранной справа.
//
// Карточка показывает не только связи, но и чанки-источники с текстом: без исходного текста
// куратор не может судить, корректно ли извлечена сущность, и правка превращается в угадайку.
//
// Склейка выполняется выбором двух записей: «отметить как цель» на одной, «склеить сюда»
// на другой. Имя склеиваемой сущности сервис записывает алиасом целевой, поэтому операция
// переживает пересборку графа.

import {
  searchEntities,
  getEntity,
  patchEntity,
  mergeEntity,
  addAlias,
  deleteAlias,
  deleteEntity,
  deleteRelation,
} from '../../api/graph.js';
import { toast } from '../../components/toast.js';

const PAGE_SIZE = 50;

export function mountEntityBrowser(host, { onChanged } = {}) {
  const root = document.createElement('div');
  root.className = 'graph-browser';
  host.replaceChildren(root);

  const listPane = document.createElement('div');
  listPane.className = 'graph-browser__list';
  const cardPane = document.createElement('div');
  cardPane.className = 'graph-browser__card';
  root.append(listPane, cardPane);

  let mergeTarget = null;   // {id, name} — цель склейки
  let selectedId = null;

  // ---------- список ----------

  const controls = document.createElement('div');
  controls.className = 'graph-browser__controls';

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'input';
  search.placeholder = 'Поиск по имени и алиасам';

  const typeFilter = document.createElement('input');
  typeFilter.type = 'text';
  typeFilter.className = 'input';
  typeFilter.placeholder = 'Тип (например, unknown)';

  const findBtn = document.createElement('button');
  findBtn.type = 'button';
  findBtn.className = 'btn';
  findBtn.textContent = 'Найти';

  controls.append(search, typeFilter, findBtn);

  const mergeBanner = document.createElement('div');
  mergeBanner.className = 'graph-browser__merge-banner';
  mergeBanner.hidden = true;

  const listBox = document.createElement('div');
  listBox.className = 'graph-browser__items';

  listPane.append(controls, mergeBanner, listBox);

  async function loadList() {
    listBox.textContent = 'Загрузка…';
    try {
      const items = await searchEntities({
        q: search.value.trim(),
        entityType: typeFilter.value.trim(),
        limit: PAGE_SIZE,
      });
      renderList(items);
    } catch (err) {
      listBox.textContent = `Ошибка: ${err?.payload?.detail || err.message}`;
    }
  }

  function renderList(items) {
    listBox.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Ничего не найдено';
      listBox.append(empty);
      return;
    }

    items.forEach((item) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'graph-browser__item';
      if (item.id === selectedId) row.classList.add('is-selected');

      const name = document.createElement('span');
      name.className = 'graph-browser__item-name';
      name.textContent = item.canonical_name;

      const type = document.createElement('span');
      type.className = 'graph-browser__item-type';
      type.textContent = item.entity_type;
      if (item.entity_type === 'unknown') type.classList.add('is-unknown');

      row.append(name, type);
      if (item.curated) {
        const flag = document.createElement('span');
        flag.className = 'graph-browser__item-flag';
        flag.textContent = 'curated';
        row.append(flag);
      }

      row.addEventListener('click', () => {
        selectedId = item.id;
        renderList(items);
        openCard(item.id);
      });
      listBox.append(row);
    });
  }

  function renderMergeBanner() {
    if (!mergeTarget) {
      mergeBanner.hidden = true;
      mergeBanner.replaceChildren();
      return;
    }
    mergeBanner.hidden = false;
    mergeBanner.replaceChildren();
    const text = document.createElement('span');
    text.textContent = `Цель склейки: ${mergeTarget.name}`;
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn--ghost';
    cancel.textContent = 'Отменить';
    cancel.addEventListener('click', () => { mergeTarget = null; renderMergeBanner(); if (selectedId) openCard(selectedId); });
    mergeBanner.append(text, cancel);
  }

  // ---------- карточка ----------

  async function openCard(entityId) {
    cardPane.textContent = 'Загрузка…';
    try {
      const data = await getEntity(entityId);
      renderCard(data);
    } catch (err) {
      cardPane.textContent = `Ошибка: ${err?.payload?.detail || err.message}`;
    }
  }

  function renderCard(data) {
    cardPane.replaceChildren();

    const title = document.createElement('h3');
    title.className = 'graph-card__title';
    title.textContent = data.canonical_name;
    cardPane.append(title);

    // --- правка имени и типа ---
    const editRow = document.createElement('div');
    editRow.className = 'graph-card__row';

    const nameInput = document.createElement('input');
    nameInput.className = 'input';
    nameInput.value = data.canonical_name;

    const typeInput = document.createElement('input');
    typeInput.className = 'input';
    typeInput.value = data.entity_type;

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'btn btn--primary';
    saveBtn.textContent = 'Сохранить';
    saveBtn.addEventListener('click', async () => {
      try {
        await patchEntity(data.id, {
          canonical_name: nameInput.value.trim(),
          entity_type: typeInput.value.trim(),
        });
        toast.success('Сущность обновлена');
        await Promise.all([loadList(), openCard(data.id)]);
        onChanged?.();
      } catch (err) {
        toast.error(err?.payload?.detail || err.message);
      }
    });

    editRow.append(nameInput, typeInput, saveBtn);
    cardPane.append(editRow);

    // --- склейка ---
    const mergeRow = document.createElement('div');
    mergeRow.className = 'graph-card__row';

    const markBtn = document.createElement('button');
    markBtn.type = 'button';
    markBtn.className = 'btn';
    markBtn.textContent = 'Отметить как цель склейки';
    markBtn.addEventListener('click', () => {
      mergeTarget = { id: data.id, name: data.canonical_name };
      renderMergeBanner();
      toast.info(`Цель склейки: ${data.canonical_name}`);
    });
    mergeRow.append(markBtn);

    if (mergeTarget && mergeTarget.id !== data.id) {
      const mergeBtn = document.createElement('button');
      mergeBtn.type = 'button';
      mergeBtn.className = 'btn btn--primary';
      mergeBtn.textContent = `Склеить в «${mergeTarget.name}»`;
      mergeBtn.addEventListener('click', async () => {
        if (!window.confirm(
          `Склеить «${data.canonical_name}» в «${mergeTarget.name}»?\n\n`
          + 'Связи и источники переедут на целевую сущность, а имя склеиваемой станет её алиасом.',
        )) return;
        try {
          const res = await mergeEntity(data.id, mergeTarget.id);
          toast.success(`Склеено. Добавлен алиас: ${res.alias_added}`);
          const target = mergeTarget.id;
          mergeTarget = null;
          selectedId = target;
          renderMergeBanner();
          await Promise.all([loadList(), openCard(target)]);
          onChanged?.();
        } catch (err) {
          toast.error(err?.payload?.detail || err.message);
        }
      });
      mergeRow.append(mergeBtn);
    }
    cardPane.append(mergeRow);

    // --- алиасы ---
    cardPane.append(sectionTitle('Алиасы'));
    const aliasList = document.createElement('div');
    aliasList.className = 'graph-card__aliases';
    (data.aliases || []).forEach((alias) => {
      const chip = document.createElement('span');
      chip.className = 'graph-card__chip';
      chip.textContent = alias.alias;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'graph-card__chip-remove';
      del.textContent = '×';
      del.title = 'Удалить алиас';
      del.addEventListener('click', async () => {
        try {
          await deleteAlias(data.id, alias.id);
          await openCard(data.id);
        } catch (err) {
          toast.error(err?.payload?.detail || err.message);
        }
      });
      chip.append(del);
      aliasList.append(chip);
    });

    const aliasInput = document.createElement('input');
    aliasInput.className = 'input';
    aliasInput.placeholder = 'Новый алиас';
    const aliasBtn = document.createElement('button');
    aliasBtn.type = 'button';
    aliasBtn.className = 'btn';
    aliasBtn.textContent = 'Добавить';
    aliasBtn.addEventListener('click', async () => {
      const value = aliasInput.value.trim();
      if (!value) return;
      try {
        await addAlias(data.id, value);
        aliasInput.value = '';
        await openCard(data.id);
      } catch (err) {
        toast.error(err?.payload?.detail || err.message);
      }
    });
    const aliasRow = document.createElement('div');
    aliasRow.className = 'graph-card__row';
    aliasRow.append(aliasInput, aliasBtn);
    cardPane.append(aliasList, aliasRow);

    // --- связи ---
    cardPane.append(sectionTitle(`Связи (${(data.relations || []).length})`));
    const relList = document.createElement('div');
    relList.className = 'graph-card__relations';
    (data.relations || []).forEach((rel) => {
      const row = document.createElement('div');
      row.className = 'graph-card__relation';
      const text = document.createElement('span');
      text.textContent = `${rel.subject.name} — ${rel.relation} → ${rel.object.name}`;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'btn btn--ghost';
      del.textContent = 'Удалить';
      del.addEventListener('click', async () => {
        if (!window.confirm('Удалить связь?')) return;
        try {
          await deleteRelation(rel.id);
          await openCard(data.id);
          onChanged?.();
        } catch (err) {
          toast.error(err?.payload?.detail || err.message);
        }
      });
      row.append(text, del);
      relList.append(row);
    });
    cardPane.append(relList);

    // --- источники ---
    cardPane.append(sectionTitle(`Чанки-источники (${(data.source_chunks || []).length})`));
    const chunkList = document.createElement('div');
    chunkList.className = 'graph-card__chunks';
    (data.source_chunks || []).forEach((chunk) => {
      const item = document.createElement('details');
      item.className = 'graph-card__chunk';
      const summary = document.createElement('summary');
      summary.textContent = chunk.doc_title || chunk.doc_id;
      const body = document.createElement('div');
      body.className = 'graph-card__chunk-text';
      body.textContent = chunk.text;
      item.append(summary, body);
      chunkList.append(item);
    });
    if (!(data.source_chunks || []).length) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'Источников нет — сущность извлечена из текста, которого в базе больше нет.';
      chunkList.append(empty);
    }
    cardPane.append(chunkList);

    // --- удаление ---
    const dangerRow = document.createElement('div');
    dangerRow.className = 'graph-card__row graph-card__row--danger';
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn--danger';
    delBtn.textContent = 'Удалить и внести в стоп-лист';
    delBtn.addEventListener('click', async () => {
      if (!window.confirm(
        `Удалить «${data.canonical_name}»?\n\n`
        + 'Имена сущности попадут в стоп-лист, иначе следующая пересборка графа создаст её заново.',
      )) return;
      try {
        await deleteEntity(data.id, { blocklist: true, reason: 'ручное курирование' });
        toast.success('Удалено');
        selectedId = null;
        cardPane.replaceChildren();
        await loadList();
        onChanged?.();
      } catch (err) {
        toast.error(err?.payload?.detail || err.message);
      }
    });
    dangerRow.append(delBtn);
    cardPane.append(dangerRow);
  }

  findBtn.addEventListener('click', () => { loadList().catch(() => {}); });
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') loadList().catch(() => {}); });

  loadList().catch(() => {});

  return {
    unmount() {
      root.replaceChildren();
    },
  };
}

function sectionTitle(text) {
  const el = document.createElement('div');
  el.className = 'graph-card__section';
  el.textContent = text;
  return el;
}
