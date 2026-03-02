import db from './init';

interface Earthquake {
  id: string;
  time: number;
  latitude: number;
  longitude: number;
  depth?: number;
  mag?: number;
  magType?: string;
  place?: string;
  updated?: number;
  tz?: number;
  url?: string;
  detail?: string;
  felt?: number;
  cdi?: number;
  mmi?: number;
  alert?: string;
  status?: string;
  tsunami?: number;
  sig?: number;
  net?: string;
  code?: string;
  ids?: string;
  sources?: string;
  types?: string;
  nst?: number;
  dmin?: number;
  rms?: number;
  gap?: number;
  magSource?: string;
  type?: string;
  title?: string;
}

class EarthquakeDAO {
  // 插入或更新地震数据
  static upsertEarthquake(earthquake: Earthquake): void {
    const stmt = db.prepare(`
      INSERT INTO earthquakes (
        id, time, latitude, longitude, depth, mag, magType, place, updated, tz, url, detail,
        felt, cdi, mmi, alert, status, tsunami, sig, net, code, ids, sources, types, nst, dmin, rms, gap, magSource, type, title
      ) VALUES (
        @id, @time, @latitude, @longitude, @depth, @mag, @magType, @place, @updated, @tz, @url, @detail,
        @felt, @cdi, @mmi, @alert, @status, @tsunami, @sig, @net, @code, @ids, @sources, @types, @nst, @dmin, @rms, @gap, @magSource, @type, @title
      )
      ON CONFLICT(id) DO UPDATE SET
        time = excluded.time,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        updated = excluded.updated
    `);

    stmt.run(earthquake);
  }

  // 获取最近的地震数据
  static getRecentEarthquakes(hours: number = 24): Earthquake[] {
    const stmt = db.prepare(`
      SELECT * FROM earthquakes 
      WHERE time > ? 
      ORDER BY time DESC 
      LIMIT 1000
    `);
    
    const sinceTime = Date.now() - (hours * 60 * 60 * 1000);
    return stmt.all(sinceTime) as Earthquake[];
  }

  // 获取最新的N条地震记录
  static getLatestEarthquakes(limit: number = 50): Earthquake[] {
    const stmt = db.prepare(`
      SELECT * FROM earthquakes 
      ORDER BY time DESC 
      LIMIT ?
    `);
    
    return stmt.all(limit) as Earthquake[];
  }

  // 根据ID获取地震详情
  static getEarthquakeById(id: string): Earthquake | null {
    const stmt = db.prepare('SELECT * FROM earthquakes WHERE id = ?');
    return stmt.get(id) as Earthquake | null;
  }

  // 获取地震统计数据
  static getStatistics(): any {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_count,
        MAX(time) as latest_time,
        AVG(mag) as avg_magnitude,
        MAX(mag) as max_magnitude,
        MIN(mag) as min_magnitude
      FROM earthquakes
    `).get();

    return stats;
  }
}

export { EarthquakeDAO, Earthquake };