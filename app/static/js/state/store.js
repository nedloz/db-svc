// Минимальный store: plain-object состояние + pub/sub.
// Без фреймворков. Не делает fetch, не трогает DOM.

export function createStore(initial = {}) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    get() {
      return state;
    },
    set(patch) {
      state = { ...state, ...patch };
      listeners.forEach((fn) => fn(state));
    },
    update(updater) {
      state = updater(state);
      listeners.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
