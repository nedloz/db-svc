const $ = (id) => document.getElementById(id);

const state = {
  tokenKey: "dbsvc_token",
  schemas: [],
  tablesBySchema: new Map(),
  openSchemas: new Set(),
  currentSchema: null,
  currentTable: null,
  currentColumns: [],
  currentRows: [],
  currentTotal: 0,
};

function getToken() { return localStorage.getItem(state.tokenKey) || ""; }
function setToken(value) { localStorage.setItem(state.tokenKey, value); }
function clearToken() { localStorage.removeItem(state.tokenKey); }

function toast(message) {
  const node = $("toast");
  node.textContent = message;
  node.classList.remove("hidden");
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.add("hidden"), 3500);
}

function pretty(value) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function setBadge(el, text, type = "neutral") {
  el.textContent = text;
  el.className = `badge badge-${type}`;
}

function renderResult(el, data) {
  if (typeof data === "string") {
    el.textContent = data;
    return;
  }
  if (data && Array.isArray(data.logs)) {
    const parts = [pretty({ ...data, logs: undefined }), "", "Логи:", ...data.logs];
    el.textContent = parts.join("\n");
    return;
  }
  el.textContent = pretty(data);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = getToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => "");

  if (!response.ok) {
    const detail = typeof payload === "string" ? payload : pretty(payload);
    const error = new Error(`${response.status}: ${detail || response.statusText}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function updateTokenUI() {
  const token = getToken();
  $("token-input").value = token;
  $("token-status").textContent = token
    ? "Токен сохранён в localStorage и автоматически подставляется в Authorization header."
    : "Токен пока не сохранён. Если backend защищён, запросы к /api/* вернут 401.";
}

async function refreshHealth() {
  const badge = $("health-badge");
  const dbBadge = $("db-badge");
  const dbText = $("db-status-text");

  setBadge(badge, "Проверка API…", "neutral");
  setBadge(dbBadge, "Проверка БД…", "neutral");
  dbText.textContent = "";

  try {
    await api("/health");
    setBadge(badge, "API доступен", "ok");
  } catch (error) {
    setBadge(badge, "API недоступен", "error");
    toast(`Health check не прошёл: ${error.message}`);
  }

  try {
    const db = await api("/api/db/connection/status");
    if (db.ok) {
      setBadge(dbBadge, "БД подключена", "ok");
      dbText.textContent = `Подключено к ${db.database} как ${db.user} (${db.host}:${db.port})`;
    } else {
      setBadge(dbBadge, "БД недоступна", "error");
      dbText.textContent = db.error || "Не удалось подключиться к PostgreSQL";
    }
  } catch (error) {
    setBadge(dbBadge, "БД недоступна", "error");
    dbText.textContent = error.message;
  }
}

function setCurrentTable(schema, table) {
  state.currentSchema = schema;
  state.currentTable = table;
  $("current-table").textContent = `${schema}.${table}`;
  $("info-schema").textContent = schema;
  $("info-table").textContent = table;
  $("import-target").value = `${schema}.${table}`;

  document.querySelectorAll(".table-item").forEach((node) => {
    node.classList.toggle("active", node.dataset.schema === schema && node.dataset.table === table);
  });
}

function renderTables(container, schema, tables) {
  container.innerHTML = "";
  if (!tables.length) {
    container.innerHTML = `<div class="muted">В этой схеме нет таблиц</div>`;
    return;
  }

  for (const table of tables) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "table-item";
    item.dataset.schema = schema;
    item.dataset.table = table;
    item.textContent = table;
    if (schema === state.currentSchema && table === state.currentTable) item.classList.add("active");
    item.addEventListener("click", async () => {
      setCurrentTable(schema, table);
      $("rows-offset").value = "0";
      await loadColumns();
      await loadRows();
    });
    container.appendChild(item);
  }
}

async function toggleSchema(schema, wrap, body, caret) {
  const opening = !wrap.classList.contains("open");
  wrap.classList.toggle("open", opening);
  caret.textContent = opening ? "▴" : "▾";
  if (!opening) {
    state.openSchemas.delete(schema);
    return;
  }
  state.openSchemas.add(schema);
  if (state.tablesBySchema.has(schema)) {
    renderTables(body, schema, state.tablesBySchema.get(schema) || []);
    return;
  }
  body.innerHTML = `<div class="muted">Загрузка…</div>`;
  try {
    const data = await api(`/api/db/${encodeURIComponent(schema)}/tables`);
    state.tablesBySchema.set(schema, data.tables || []);
    renderTables(body, schema, data.tables || []);
  } catch (error) {
    body.innerHTML = `<div class="empty-state">Не удалось загрузить таблицы</div>`;
    toast(`Ошибка загрузки таблиц схемы ${schema}: ${error.message}`);
  }
}

function renderSchemas() {
  const root = $("schema-list");
  const filter = ($("schema-filter").value || "").trim().toLowerCase();
  root.innerHTML = "";

  const schemas = state.schemas.filter((schema) => schema.toLowerCase().includes(filter));
  if (!schemas.length) {
    root.innerHTML = `<div class="empty-state">По фильтру ничего не найдено</div>`;
    return;
  }

  for (const schema of schemas) {
    const wrap = document.createElement("div");
    wrap.className = "schema-item";
    if (state.openSchemas.has(schema)) wrap.classList.add("open");

    const trigger = document.createElement("button");
    trigger.className = "schema-trigger";
    trigger.type = "button";
    const caret = document.createElement("span");
    caret.textContent = state.openSchemas.has(schema) ? "▴" : "▾";
    trigger.innerHTML = `<span>${schema}</span>`;
    trigger.appendChild(caret);

    const body = document.createElement("div");
    body.className = "schema-body";
    if (state.tablesBySchema.has(schema)) {
      renderTables(body, schema, state.tablesBySchema.get(schema) || []);
    } else {
      body.innerHTML = `<div class="muted">Нажми, чтобы загрузить таблицы</div>`;
    }

    trigger.addEventListener("click", () => toggleSchema(schema, wrap, body, caret));

    wrap.appendChild(trigger);
    wrap.appendChild(body);
    root.appendChild(wrap);
  }
}

async function loadSchemas() {
  const data = await api("/api/db/schemas");
  state.schemas = data.schemas || [];
  renderSchemas();
}

async function loadColumns() {
  if (!state.currentSchema || !state.currentTable) return;
  const data = await api(`/api/db/${encodeURIComponent(state.currentSchema)}/${encodeURIComponent(state.currentTable)}/columns`);
  state.currentColumns = data.columns || [];
  $("info-columns").textContent = state.currentColumns.length;

  const root = $("columns-wrap");
  root.innerHTML = "";
  if (!state.currentColumns.length) {
    root.classList.add("empty-state");
    root.textContent = "У таблицы нет колонок";
    return;
  }
  root.classList.remove("empty-state");

  for (const column of state.currentColumns) {
    const chip = document.createElement("div");
    chip.className = "chip";
    chip.innerHTML = `<strong>${column.name}</strong><span class="type">${column.type}</span><span class="nullable">${column.nullable ? "nullable" : "not null"}</span>`;
    root.appendChild(chip);
  }
}

function renderRows() {
  const wrap = $("table-wrap");
  const search = ($("rows-search").value || "").trim().toLowerCase();
  const columns = state.currentColumns.map((c) => c.name || c);
  let rows = [...state.currentRows];
  if (search) {
    rows = rows.filter((row) => columns.some((col) => String(row[col] ?? "").toLowerCase().includes(search)));
  }

  $("rows-summary").textContent = `Всего в таблице: ${state.currentTotal}. На странице: ${state.currentRows.length}. После фильтра: ${rows.length}.`;
  $("info-total").textContent = state.currentTotal;

  if (!columns.length) {
    wrap.className = "table-wrap empty-state";
    wrap.textContent = "Нет колонок для отображения";
    return;
  }
  if (!rows.length) {
    wrap.className = "table-wrap empty-state";
    wrap.textContent = search ? "По текущему фильтру ничего не найдено" : "Нет строк для отображения";
    return;
  }

  wrap.className = "table-wrap";
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const column of columns) {
    const th = document.createElement("th");
    th.textContent = column;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    for (const column of columns) {
      const td = document.createElement("td");
      const value = row[column];
      td.textContent = value == null ? "" : (typeof value === "object" ? pretty(value) : String(value));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.innerHTML = "";
  wrap.appendChild(table);
}

async function loadRows() {
  if (!state.currentSchema || !state.currentTable) {
    toast("Сначала выбери таблицу");
    return;
  }
  const limit = Math.max(1, Math.min(500, Number($("rows-limit").value || 50)));
  const offset = Math.max(0, Number($("rows-offset").value || 0));
  const orderBy = ($("rows-order").value || "").trim();
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (orderBy) params.set("order_by", orderBy);
  const data = await api(`/api/db/${encodeURIComponent(state.currentSchema)}/${encodeURIComponent(state.currentTable)}/rows?${params.toString()}`);
  state.currentRows = data.rows || [];
  state.currentTotal = Number(data.total || 0);
  if (!state.currentColumns.length && Array.isArray(data.columns)) {
    state.currentColumns = data.columns.map((name) => ({ name, type: "", nullable: true }));
  }
  renderRows();
}

async function runCsvImport() {
  if (!state.currentSchema || !state.currentTable) {
    toast("Сначала выбери таблицу в разделе «База данных»");
    return;
  }
  const file = $("csv-file").files?.[0];
  if (!file) {
    toast("Выбери CSV файл");
    return;
  }
  const fd = new FormData();
  fd.append("file", file);
  fd.append("schema", state.currentSchema);
  fd.append("table", state.currentTable);
  fd.append("mode", $("csv-mode").value);
  fd.append("delimiter", $("csv-delimiter").value || ",");
  fd.append("encoding", $("csv-encoding").value || "utf-8");

  $("csv-import-result").textContent = "Импорт выполняется…";
  try {
    const data = await api("/api/db/import/csv", { method: "POST", body: fd });
    renderResult($("csv-import-result"), data);
    toast("CSV импорт завершён");
    await loadRows();
  } catch (error) {
    $("csv-import-result").textContent = error.message;
    toast("CSV импорт завершился с ошибкой");
  }
}

async function checkDatasetRoute() {
  const badge = $("dataset-status");
  setBadge(badge, "Проверка роута…", "neutral");
  try {
    const data = await api("/api/db/import/dataset/status");
    setBadge(badge, "Роут доступен", "ok");
    renderResult($("dataset-import-result"), data);
  } catch (error) {
    setBadge(badge, "Роут недоступен", "warn");
    $("dataset-import-result").textContent = error.message;
  }
}

function collectDatasetFiles() {
  return {
    universities: $("dataset-universities").files?.[0],
    campuses: $("dataset-campuses").files?.[0],
    faculties: $("dataset-faculties").files?.[0],
    buildings: $("dataset-buildings").files?.[0],
    programs: $("dataset-programs").files?.[0],
    topics: $("dataset-topics").files?.[0],
    documents: $("dataset-documents").files?.[0],
    document_relations: $("dataset-relations").files?.[0],
  };
}

async function runDatasetImport() {
  const files = collectDatasetFiles();
  const missing = Object.entries(files).filter(([, file]) => !file).map(([key]) => key);
  if (missing.length) {
    toast(`Не хватает файлов: ${missing.join(", ")}`);
    return;
  }

  const fd = new FormData();
  for (const [key, file] of Object.entries(files)) fd.append(key, file);
  fd.append("replace_mode", String($("dataset-replace").checked));
  fd.append("dry_run", String($("dataset-dry-run").checked));

  $("dataset-import-result").textContent = "Связанный импорт выполняется…";
  try {
    const data = await api("/api/db/import/dataset", { method: "POST", body: fd });
    renderResult($("dataset-import-result"), data);
    toast(data.ok ? "Связанный импорт завершён" : "Импорт завершился с ошибками");
    await loadSchemas();
    if (state.currentSchema && state.currentTable) {
      await loadColumns();
      await loadRows();
    }
  } catch (error) {
    $("dataset-import-result").textContent = error.message;
    toast("Связанный импорт завершился с ошибкой");
  }
}

function renderMinio(items) {
  const root = $("minio-list");
  root.innerHTML = "";
  if (!items.length) {
    root.className = "object-list empty-state";
    root.textContent = "Бакет пуст или список ещё не загружен";
    return;
  }
  root.className = "object-list";
  for (const item of items) {
    const row = document.createElement("div");
    row.className = "object-item";
    const meta = document.createElement("div");
    meta.className = "object-meta";
    meta.innerHTML = `<div class="object-key">${item.key}</div><div class="object-sub">${item.size} bytes${item.last_modified ? ` • ${item.last_modified}` : ""}</div>`;
    const actions = document.createElement("div");
    actions.className = "object-actions";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "btn btn-secondary";
    downloadBtn.textContent = "Скачать";
    downloadBtn.addEventListener("click", async () => {
      try {
        const data = await api(`/api/minio/presign/download?key=${encodeURIComponent(item.key)}`);
        window.open(data.url, "_blank", "noopener,noreferrer");
      } catch (error) {
        toast(`Не удалось получить ссылку на скачивание: ${error.message}`);
      }
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn btn-secondary";
    deleteBtn.textContent = "Удалить";
    deleteBtn.addEventListener("click", async () => {
      try {
        await api(`/api/minio/object?key=${encodeURIComponent(item.key)}`, { method: "DELETE" });
        toast("Файл удалён");
        await loadMinioObjects();
      } catch (error) {
        toast(`Не удалось удалить объект: ${error.message}`);
      }
    });

    actions.append(downloadBtn, deleteBtn);
    row.append(meta, actions);
    root.appendChild(row);
  }
}

async function loadMinioObjects() {
  try {
    const data = await api("/api/minio/objects");
    renderMinio(data.items || []);
  } catch (error) {
    $("minio-list").className = "object-list empty-state";
    $("minio-list").textContent = `Не удалось загрузить список объектов: ${error.message}`;
  }
}

async function loadMinioPlan() {
  try {
    const data = await api("/api/minio/import-plan");
    renderResult($("minio-plan-result"), data);
  } catch (error) {
    $("minio-plan-result").textContent = error.message;
  }
}


async function loadHtmlImportPlan() {
  try {
    const data = await api("/api/minio/import/html-plan");
    renderResult($("html-import-plan-result"), data);
  } catch (error) {
    $("html-import-plan-result").textContent = error.message;
  }
}

async function runMinioUpload() {
  const key = ($("minio-key").value || "").trim();
  const file = $("minio-file").files?.[0];
  if (!key) return toast("Укажи key для MinIO");
  if (!file) return toast("Выбери файл для загрузки");

  $("minio-upload-result").textContent = "Получение presigned URL…";
  try {
    const data = await api(`/api/minio/presign/upload?key=${encodeURIComponent(key)}&content_type=${encodeURIComponent(file.type || "application/octet-stream")}`, { method: "POST" });
    const uploadResponse = await fetch(data.url, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file });
    if (!uploadResponse.ok) throw new Error(`PUT ${uploadResponse.status}`);
    renderResult($("minio-upload-result"), { ok: true, key });
    toast("Файл загружен в MinIO");
    await loadMinioObjects();
  } catch (error) {
    $("minio-upload-result").textContent = error.message;
    toast("Не удалось загрузить файл в MinIO");
  }
}

async function runMinioImport() {
  const files = Array.from($("minio-import-files").files || []);
  if (!files.length) return toast("Выбери хотя бы один файл для импорта");

  const fd = new FormData();
  for (const file of files) fd.append("files", file);
  fd.append("dry_run", String($("minio-import-dry-run").checked));

  $("minio-import-result").textContent = "Импорт в MinIO выполняется…";
  try {
    const data = await api("/api/minio/import/files", { method: "POST", body: fd });
    renderResult($("minio-import-result"), data);
    toast(data.ok ? "Импорт в MinIO завершён" : "Импорт завершён с ошибками");
    await loadMinioObjects();
    await loadMinioPlan();
  } catch (error) {
    $("minio-import-result").textContent = error.message;
    toast("Импорт в MinIO завершился с ошибкой");
  }
}


async function runHtmlImport() {
  const limitValue = ($("html-import-limit").value || "").trim();
  const fd = new FormData();
  fd.append("dry_run", String($("html-import-dry-run").checked));
  fd.append("force", String($("html-import-force").checked));
  if (limitValue) fd.append("limit", limitValue);

  $("html-import-result").textContent = "Импорт HTML страниц выполняется…";
  try {
    const data = await api("/api/minio/import/html-from-documents", { method: "POST", body: fd });
    renderResult($("html-import-result"), data);
    toast(data.ok ? "HTML страницы загружены" : "HTML импорт завершён с ошибками");
    await loadMinioObjects();
    await loadHtmlImportPlan();
  } catch (error) {
    $("html-import-result").textContent = error.message;
    toast("HTML импорт завершился с ошибкой");
  }
}

function switchTab(name) {
  const panels = { explorer: $("panel-explorer"), imports: $("panel-imports"), minio: $("panel-minio") };
  const tabs = { explorer: $("tab-explorer"), imports: $("tab-imports"), minio: $("tab-minio") };
  Object.entries(panels).forEach(([key, el]) => el.classList.toggle("active", key === name));
  Object.entries(tabs).forEach(([key, el]) => el.classList.toggle("active", key === name));
}

function on(id, event, handler) {
  const el = $(id);
  if (!el) {
    console.warn(`Element with id="${id}" not found`);
    return;
  }
  el.addEventListener(event, handler);
}

function bindEvents() {
  on("save-token", "click", () => { setToken($("token-input").value.trim()); updateTokenUI(); toast("Токен сохранён"); });
  on("clear-token", "click", () => { clearToken(); updateTokenUI(); toast("Токен удалён"); });
  on("refresh-all", "click", async () => { await bootstrap(); toast("Данные обновлены"); });
  on("reload-schemas", "click", async () => { state.tablesBySchema.clear(); await loadSchemas(); });
  on("schema-filter", "input", renderSchemas);
  on("load-rows", "click", loadRows);
  on("refresh-table", "click", async () => {
    if (!state.currentSchema || !state.currentTable) return toast("Таблица ещё не выбрана");
    await loadColumns();
    await loadRows();
  });
  on("rows-search", "input", renderRows);
  on("run-csv-import", "click", runCsvImport);
  on("run-dataset-import", "click", runDatasetImport);
  on("refresh-dataset-status", "click", checkDatasetRoute);
  on("run-minio-upload", "click", runMinioUpload);
  on("run-minio-import", "click", runMinioImport);
  on("run-html-import", "click", runHtmlImport);
  on("refresh-minio", "click", loadMinioObjects);
  on("refresh-minio-plan", "click", loadMinioPlan);
  on("refresh-html-import-plan", "click", loadHtmlImportPlan);
  on("tab-explorer", "click", () => switchTab("explorer"));
  on("tab-imports", "click", () => switchTab("imports"));
  on("tab-minio", "click", async () => { switchTab("minio"); await loadMinioObjects(); await loadMinioPlan(); await loadHtmlImportPlan(); });
}

async function bootstrap() {
  updateTokenUI();
  await refreshHealth();
  try { await loadSchemas(); } catch (error) { toast(`Не удалось загрузить схемы: ${error.message}`); }
  await checkDatasetRoute();
}

bindEvents();
bootstrap();
