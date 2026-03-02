import Database from 'better-sqlite3';
import path from 'path';

// 初始化数据库
const db = new Database(path.join(process.cwd(), 'seismic_data.db'));

// 创建地震数据表
db.exec(`
  CREATE TABLE IF NOT EXISTS earthquakes (
    id TEXT PRIMARY KEY,
    time INTEGER NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    depth REAL,
    mag REAL,
    magType TEXT,
    place TEXT,
    updated INTEGER,
    tz INTEGER,
    url TEXT,
    detail TEXT,
    felt INTEGER,
    cdi REAL,
    mmi REAL,
    alert TEXT,
    status TEXT,
    tsunami INTEGER,
    sig INTEGER,
    net TEXT,
    code TEXT,
    ids TEXT,
    sources TEXT,
    types TEXT,
    nst INTEGER,
    dmin REAL,
    rms REAL,
    gap REAL,
    magSource TEXT,
    type TEXT,
    title TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_earthquakes_time ON earthquakes(time);
  CREATE INDEX IF NOT EXISTS idx_earthquakes_location ON earthquakes(latitude, longitude);
  CREATE INDEX IF NOT EXISTS idx_earthquakes_magnitude ON earthquakes(mag);
`);

// 创建台站数据表
db.exec(`
  CREATE TABLE IF NOT EXISTS stations (
    id TEXT PRIMARY KEY,
    network TEXT NOT NULL,
    name TEXT NOT NULL,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    elevation REAL,
    site_name TEXT,
    start_date INTEGER,
    end_date INTEGER,
    channels TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now')),
    updated_at INTEGER DEFAULT (strftime('%s', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_stations_location ON stations(latitude, longitude);
  CREATE INDEX IF NOT EXISTS idx_stations_network ON stations(network);
`);

console.log('Database initialized successfully');

export default db;