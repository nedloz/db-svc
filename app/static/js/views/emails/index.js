// Вкладка «Письма» — редактирование HTML-текстов писем, которые отправляет auth-svc.
//
// Тексты лежат в core.email_templates. Редактируется чистый HTML в текстовом поле (то, что
// записано в поле, и уходит в письмо, без визуального редактора, который переписывает разметку);
// рядом живой предпросмотр в изолированном iframe, куда вместо {плейсхолдеров} подставляются
// примерные значения. Если строки нет или она пустая, auth-svc отправляет встроенный текст,
// поэтому сломать отправку правкой здесь нельзя.

import { listEmailTemplates, saveEmailTemplate } from '../../api/emails.js';
import { createField, createInput, createSelect } from '../../components/form-controls.js';
import { showToast } from '../../components/toast.js';
import { formatHtml } from '../../utils/html-format.js';

const PLACEHOLDER_RE = /\{(\w+)\}/g;

function sampleValue(name) {
  return name.endsWith('_url') ? `https://example.com/${name.replace(/_url$/, '')}?token=sample` : `[${name}]`;
}

// Неизвестные плейсхолдеры остаются как есть: опечатка в имени видна прямо в предпросмотре.
function fillPlaceholders(html, known) {
  return html.replace(PLACEHOLDER_RE, (m, name) => (known.includes(name) ? sampleValue(name) : m));
}

export const emailsView = {
  title: 'Письма',
  hash: '#/emails',
  mount(container) {
    const root = document.createElement('div');
    root.className = 'emails-view';
    container.replaceChildren(root);

    const card = document.createElement('section');
    card.className = 'card';
    card.innerHTML = `
      <div class="card__header"><h2 class="card__title">Тексты писем</h2></div>
      <div class="card__subtitle">HTML-письма, которые уходят пользователям. Вместо {плейсхолдеров} подставляются значения при отправке.</div>
    `;
    const body = document.createElement('div');
    body.className = 'card__body';
    card.append(body);
    root.append(card);

    let templates = [];
    let current = null;
    let editor = null;
    let disposed = false;
    let selectEl = null;
    let subjectEl = null;
    let chipsEl = null;
    let statusEl = null;
    let previewEl = null;
    let saveBtn = null;
    let resetBtn = null;
    let savedState = { subject: '', body: '' };

    const placeholderNames = () => Object.keys(current?.placeholders || {});
    const currentBody = () => editor ? editor.getContent() : '';
    const isDirty = () => current && (subjectEl.value !== savedState.subject || currentBody() !== savedState.body);

    function updatePreview() {
      if (!previewEl || !current) return;
      const known = placeholderNames();
      const html = fillPlaceholders(currentBody(), known);
      previewEl.srcdoc = `<!doctype html><meta charset="utf-8"><base target="_blank">`
        + `<body style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;margin:16px">${html}</body>`;
      const unknown = [...new Set([...currentBody().matchAll(PLACEHOLDER_RE)].map((m) => m[1]))]
        .filter((n) => !known.includes(n));
      const dirty = isDirty();
      statusEl.textContent = (unknown.length ? `Неизвестные плейсхолдеры: ${unknown.map((n) => `{${n}}`).join(', ')}. ` : '')
        + (dirty ? 'Есть несохранённые изменения.' : 'Сохранено.');
      statusEl.classList.toggle('emails-view__status--warn', unknown.length > 0);
      saveBtn.disabled = !dirty || !subjectEl.value.trim() || !currentBody().trim();
      resetBtn.disabled = !dirty;
    }

    function renderChips() {
      chipsEl.replaceChildren();
      for (const [name, hint] of Object.entries(current?.placeholders || {})) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn btn--sm';
        b.textContent = `{${name}}`;
        b.title = `${hint}. Вставить в место курсора`;
        b.addEventListener('click', () => editor?.insertContent(`{${name}}`));
        chipsEl.append(b);
      }
    }

    function selectTemplate(eventType) {
      current = templates.find((t) => t.event_type === eventType) || null;
      if (!current) return;
      // В БД HTML может лежать одной строкой (так записан сид): показываем отформатированным,
      // и это же считаем исходным состоянием, чтобы письмо не выглядело изменённым.
      savedState = { subject: current.subject_template, body: formatHtml(current.body_html) };
      subjectEl.value = savedState.subject;
      editor?.setContent(savedState.body);
      renderChips();
      updatePreview();
    }

    async function save() {
      saveBtn.disabled = true;
      const payload = { subject_template: subjectEl.value.trim(), body_html: currentBody() };
      try {
        const row = await saveEmailTemplate(current.event_type, { subject_template: payload.subject_template, body_html: payload.body_html });
        Object.assign(current, row || {}, payload);
        savedState = { subject: payload.subject_template, body: payload.body_html };
        showToast({ type: 'success', message: 'Письмо сохранено' });
      } catch (err) {
        showToast({ type: 'error', message: `Не удалось сохранить: ${err.message || err}` });
      }
      updatePreview();
    }

    async function build() {
      try {
        templates = await listEmailTemplates();
      } catch (err) {
        body.textContent = `Не удалось загрузить письма: ${err.message || err}`;
        return;
      }
      if (disposed) return;
      if (!templates.length) {
        body.textContent = 'Шаблонов писем нет. Примените infra/db/migrations/009_email_templates.sql.';
        return;
      }

      selectEl = createSelect({
        value: templates[0].event_type,
        options: templates.map((t) => ({ value: t.event_type, label: t.title || t.event_type })),
        onChange: (v) => {
          if (isDirty() && !window.confirm('Несохранённые изменения будут потеряны. Перейти к другому письму?')) {
            selectEl.value = current.event_type;
            return;
          }
          selectTemplate(v);
        },
      });
      subjectEl = createInput({ placeholder: 'Тема письма', onInput: () => updatePreview() });
      chipsEl = document.createElement('div');
      chipsEl.className = 'emails-view__chips';

      const textarea = document.createElement('textarea');
      textarea.className = 'textarea emails-view__editor';
      textarea.spellcheck = false;
      textarea.placeholder = '<p>Текст письма в HTML</p>';

      previewEl = document.createElement('iframe');
      previewEl.className = 'emails-view__preview';
      previewEl.setAttribute('sandbox', '');   // без скриптов: в предпросмотре исполняться нечему
      previewEl.title = 'Предпросмотр письма';

      statusEl = document.createElement('div');
      statusEl.className = 'emails-view__status';

      saveBtn = document.createElement('button');
      saveBtn.type = 'button';
      saveBtn.className = 'btn btn--primary';
      saveBtn.textContent = 'Сохранить';
      saveBtn.addEventListener('click', save);
      resetBtn = document.createElement('button');
      resetBtn.type = 'button';
      resetBtn.className = 'btn';
      resetBtn.textContent = 'Отменить правки';
      resetBtn.addEventListener('click', () => selectTemplate(current.event_type));
      const formatBtn = document.createElement('button');
      formatBtn.type = 'button';
      formatBtn.className = 'btn';
      formatBtn.textContent = 'Форматировать';
      formatBtn.title = 'Расставить отступы и переносы строк';
      formatBtn.addEventListener('click', () => {
        editor.setContent(formatHtml(editor.getContent()));
        updatePreview();
      });
      const actions = document.createElement('div');
      actions.className = 'emails-view__actions';
      actions.append(saveBtn, resetBtn, formatBtn, statusEl);

      const editorCol = document.createElement('div');
      editorCol.className = 'emails-view__col';
      editorCol.append(createField({ label: 'Тема', control: subjectEl }), chipsEl, textarea);
      const previewCol = document.createElement('div');
      previewCol.className = 'emails-view__col';
      const previewLabel = document.createElement('span');
      previewLabel.className = 'field__label';
      previewLabel.textContent = 'Предпросмотр (с примерными значениями)';
      previewCol.append(previewLabel, previewEl);
      const split = document.createElement('div');
      split.className = 'emails-view__split';
      split.append(editorCol, previewCol);

      body.append(createField({ label: 'Письмо', control: selectEl }), split, actions);

      textarea.addEventListener('input', () => updatePreview());
      textarea.addEventListener('keydown', (e) => {
        // Tab вставляет отступ, а не уводит фокус из поля: иначе HTML не набрать с отступами.
        if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
          e.preventDefault();
          textarea.setRangeText('  ', textarea.selectionStart, textarea.selectionEnd, 'end');
          updatePreview();
        }
      });
      editor = {
        getContent: () => textarea.value,
        setContent: (v) => { textarea.value = v; },
        insertContent: (v) => {
          textarea.focus();
          textarea.setRangeText(v, textarea.selectionStart, textarea.selectionEnd, 'end');
          updatePreview();
        },
      };
      if (disposed) return;
      selectTemplate(templates[0].event_type);
    }

    build();

    return () => {
      disposed = true;
    };
  },
};
