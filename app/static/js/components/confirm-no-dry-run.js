// Подтверждение запуска импорта без предварительного dry-run.
//
// Сам dry-run необязателен: «Применить» доступно всегда. Но непроверенный план падает уже
// на реальной операции, поэтому переспрашиваем — один диалог вместо заблокированной кнопки.
import { openModal } from './modal.js';

export function confirmApplyWithoutDryRun({ text, warning = null, onConfirm }) {
  const body = document.createElement('div');

  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  body.append(paragraph);

  if (warning) {
    const warn = document.createElement('p');
    warn.className = 'confirm-no-dry-run__warning';
    warn.textContent = warning;
    body.append(warn);
  }

  return openModal({
    title: 'Запуск без dry-run',
    body,
    actions: [
      { label: 'Отмена', onClick: (close) => close() },
      {
        label: 'Запустить',
        variant: 'danger',
        onClick: (close) => {
          close();
          onConfirm();
        },
      },
    ],
  });
}
