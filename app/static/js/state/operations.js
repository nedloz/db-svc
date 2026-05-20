// Глобальный реестр активных операций. Любой долгий запрос / импорт / задача
// регистрируется здесь, чтобы шапка показала счётчик и попап со списком +
// дала пользователю отменить через AbortController.
//
// Реестр глобальный (не привязан к view), потому что операции переживают
// переключение вкладок.

let nextId = 1;
const operations = new Map(); // id -> { id, label, startedAt, controller }
const listeners = new Set();

function snapshot() {
  return Array.from(operations.values());
}
function notify() {
  const list = snapshot();
  listeners.forEach((fn) => fn(list));
}

export function startOperation({ label = 'Операция', controller = null } = {}) {
  const id = nextId++;
  operations.set(id, { id, label, startedAt: Date.now(), controller });
  notify();
  return {
    id,
    finish() {
      if (operations.delete(id)) notify();
    },
  };
}

export function cancelOperation(id) {
  const op = operations.get(id);
  op?.controller?.abort();
  // finish() не зовём здесь: вызывающий код словит AbortError и сам закроет
  // операцию через handle.finish() в finally.
}

export function listOperations() {
  return snapshot();
}

export function subscribeOperations(fn) {
  listeners.add(fn);
  fn(snapshot());
  return () => listeners.delete(fn);
}

// Обёртка для async-задач, не идущих через request() (например, локальные
// тяжёлые вычисления или многошаговые мок-операции). Сама создаёт AbortController.
export async function trackOperation(label, fn) {
  const controller = new AbortController();
  const handle = startOperation({ label, controller });
  try {
    return await fn(controller.signal);
  } finally {
    handle.finish();
  }
}
