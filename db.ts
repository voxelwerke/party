import sqlite3 from "sqlite3";

const db = new sqlite3.Database("memory.db");

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS memories (
    name TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS history_fts USING fts5(
    content,
    content='history',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
  )`);

  db.run(`CREATE TRIGGER IF NOT EXISTS history_ai AFTER INSERT ON history BEGIN
    INSERT INTO history_fts(rowid, content) VALUES (new.id, new.content);
  END`);
});

function dbRun(sql: string, params: any[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function dbGet(sql: string, params: any[] = []): Promise<any> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err: Error | null, row: any) =>
      err ? reject(err) : resolve(row)
    );
  });
}

function dbAll(sql: string, params: any[] = []): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: any[]) =>
      err ? reject(err) : resolve(rows)
    );
  });
}

export const setMemory = (key: string, value: string) =>
  dbRun(
    `INSERT INTO memories (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
    [key, value]
  );

export const getMemory = async (key: string): Promise<string> => {
  const row = await dbGet(`SELECT value FROM memories WHERE name = ?`, [key]);
  return row?.value ?? "";
};

export const listMemories = async (): Promise<{ name: string; value: string }[]> =>
  dbAll(`SELECT name, value FROM memories ORDER BY created_at`);

export const addHistory = (role: string, content: string) =>
  dbRun(`INSERT INTO history (role, content) VALUES (?, ?)`, [role, content]);

export const searchHistory = async (query: string) =>
  dbAll(
    `SELECT h.id, h.role, h.content, h.created_at
     FROM history_fts f
     JOIN history h ON h.id = f.rowid
     WHERE history_fts MATCH ?
     ORDER BY rank
     LIMIT 10`,
    [query]
  );

export const getHistoryContext = async (id: number) =>
  dbAll(
    `SELECT id, role, content, created_at FROM history
     WHERE id BETWEEN ? AND ?
     ORDER BY id`,
    [id - 2, id + 2]
  );
