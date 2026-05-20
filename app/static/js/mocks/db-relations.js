// Mock для P-003 — статичная карта FK всего проекта.
// Единый источник правды на стороне фронта: список FK_DEFINITIONS, ровно
// отражающий FK-секции из pochemuchnic-miem-prj/infra/db/init/init.sql.
//
// При изменении init.sql — правим список здесь, в ОДНОМ месте.
// Когда бэк выкатит GET /api/db/{schema}/{table}/relations и
// .../relations/inbound — переключаем USE_MOCK_RELATIONS=false; этот файл
// останется только как ссылочный slot.

const FK_DEFINITIONS = [
  // ---------- core ----------
  { from: { schema: 'core', table: 'campuses',  column: 'university_id' }, to: { schema: 'core', table: 'universities', column: 'id' }, on_delete: 'CASCADE',   is_nullable: false },
  { from: { schema: 'core', table: 'faculties', column: 'university_id' }, to: { schema: 'core', table: 'universities', column: 'id' }, on_delete: 'CASCADE',   is_nullable: false },
  { from: { schema: 'core', table: 'buildings', column: 'campus_id'     }, to: { schema: 'core', table: 'campuses',     column: 'id' }, on_delete: 'CASCADE',   is_nullable: false },
  { from: { schema: 'core', table: 'programs',  column: 'faculty_id'    }, to: { schema: 'core', table: 'faculties',    column: 'id' }, on_delete: 'CASCADE',   is_nullable: false },

  // ---------- auth ----------
  { from: { schema: 'auth', table: 'user_profiles', column: 'user_id'       }, to: { schema: 'auth', table: 'users',        column: 'id' }, on_delete: 'CASCADE',  is_nullable: false },
  { from: { schema: 'auth', table: 'user_profiles', column: 'university_id' }, to: { schema: 'core', table: 'universities', column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'auth', table: 'user_profiles', column: 'campus_id'     }, to: { schema: 'core', table: 'campuses',     column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'auth', table: 'user_profiles', column: 'faculty_id'    }, to: { schema: 'core', table: 'faculties',    column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'auth', table: 'user_profiles', column: 'program_id'    }, to: { schema: 'core', table: 'programs',     column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'auth', table: 'refresh_tokens', column: 'user_id'              }, to: { schema: 'auth', table: 'users',          column: 'id' }, on_delete: 'CASCADE',  is_nullable: false },
  { from: { schema: 'auth', table: 'refresh_tokens', column: 'replaced_by_token_id' }, to: { schema: 'auth', table: 'refresh_tokens', column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'auth', table: 'email_verifications', column: 'user_id' }, to: { schema: 'auth', table: 'users', column: 'id' }, on_delete: 'CASCADE', is_nullable: false },
  { from: { schema: 'auth', table: 'password_resets',     column: 'user_id' }, to: { schema: 'auth', table: 'users', column: 'id' }, on_delete: 'CASCADE', is_nullable: false },

  // ---------- chat ----------
  { from: { schema: 'chat', table: 'chat_sessions', column: 'user_id'             }, to: { schema: 'auth', table: 'users',         column: 'id' }, on_delete: 'SET NULL',  is_nullable: true  },
  { from: { schema: 'chat', table: 'chat_messages', column: 'session_id'          }, to: { schema: 'chat', table: 'chat_sessions', column: 'id' }, on_delete: 'CASCADE',   is_nullable: false },
  { from: { schema: 'chat', table: 'chat_messages', column: 'user_id'             }, to: { schema: 'auth', table: 'users',         column: 'id' }, on_delete: 'NO ACTION', is_nullable: true  },
  { from: { schema: 'chat', table: 'chat_messages', column: 'reply_to_message_id' }, to: { schema: 'chat', table: 'chat_messages', column: 'id' }, on_delete: 'SET NULL',  is_nullable: true  },
  { from: { schema: 'chat', table: 'feedback',      column: 'message_id'          }, to: { schema: 'chat', table: 'chat_messages', column: 'id' }, on_delete: 'CASCADE',   is_nullable: false },
  { from: { schema: 'chat', table: 'feedback',      column: 'user_id'             }, to: { schema: 'auth', table: 'users',         column: 'id' }, on_delete: 'NO ACTION', is_nullable: false },
  { from: { schema: 'chat', table: 'rag_runs',      column: 'message_id'          }, to: { schema: 'chat', table: 'chat_messages', column: 'id' }, on_delete: 'CASCADE',   is_nullable: false },

  // ---------- library ----------
  { from: { schema: 'library', table: 'topics',             column: 'parent_id'        }, to: { schema: 'library', table: 'topics',    column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'library', table: 'documents',          column: 'topic_id'         }, to: { schema: 'library', table: 'topics',    column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'library', table: 'documents',          column: 'created_by'       }, to: { schema: 'auth',    table: 'users',     column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'library', table: 'chunks',             column: 'document_id'      }, to: { schema: 'library', table: 'documents', column: 'id' }, on_delete: 'CASCADE',  is_nullable: false },
  { from: { schema: 'library', table: 'chunk_embeddings',   column: 'chunk_id'         }, to: { schema: 'library', table: 'chunks',    column: 'id' }, on_delete: 'CASCADE',  is_nullable: false },
  { from: { schema: 'library', table: 'document_files',     column: 'document_id'      }, to: { schema: 'library', table: 'documents', column: 'id' }, on_delete: 'CASCADE',  is_nullable: false },
  { from: { schema: 'library', table: 'document_relations', column: 'from_document_id' }, to: { schema: 'library', table: 'documents', column: 'id' }, on_delete: 'CASCADE',  is_nullable: false },
  { from: { schema: 'library', table: 'document_relations', column: 'to_document_id'   }, to: { schema: 'library', table: 'documents', column: 'id' }, on_delete: 'CASCADE',  is_nullable: false },
  { from: { schema: 'library', table: 'contacts',           column: 'building_id'      }, to: { schema: 'core',    table: 'buildings', column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
  { from: { schema: 'library', table: 'places',             column: 'building_id'      }, to: { schema: 'core',    table: 'buildings', column: 'id' }, on_delete: 'SET NULL', is_nullable: true  },
];

const _outbound = new Map(); // `${s}.${t}` -> [{ column, references, on_delete, is_nullable }]
const _inbound  = new Map(); // `${s}.${t}` -> [{ schema, table, column, on_delete, is_nullable }] (rows ссылающиеся на нас)

for (const def of FK_DEFINITIONS) {
  const fromKey = key(def.from.schema, def.from.table);
  const toKey   = key(def.to.schema,   def.to.table);
  if (!_outbound.has(fromKey)) _outbound.set(fromKey, []);
  if (!_inbound.has(toKey))    _inbound.set(toKey,   []);
  _outbound.get(fromKey).push({
    column: def.from.column,
    references: { ...def.to },
    on_delete: def.on_delete,
    is_nullable: def.is_nullable,
  });
  _inbound.get(toKey).push({
    schema: def.from.schema,
    table: def.from.table,
    column: def.from.column,
    on_delete: def.on_delete,
    is_nullable: def.is_nullable,
  });
}

function key(s, t) { return `${s}.${t}`; }

// Контракт совпадает с P-003: { column, references:{schema,table,column}, on_delete, is_nullable }.
export function mockOutboundRelations(schema, table) {
  return _outbound.get(key(schema, table)) || [];
}

// Список FK, которые ссылаются на (schema, table). Нужен для cascade-preview.
export function mockInboundRelations(schema, table) {
  return _inbound.get(key(schema, table)) || [];
}
