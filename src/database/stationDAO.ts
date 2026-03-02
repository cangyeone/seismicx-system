import db from './init';

interface Station {
  id: string;
  network: string;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  site_name?: string;
  start_date?: number;
  end_date?: number;
  channels?: string;
}

class StationDAO {
  // 插入或更新台站数据
  static upsertStation(station: Station): void {
    const stmt = db.prepare(`
      INSERT INTO stations (
        id, network, name, latitude, longitude, elevation, site_name, start_date, end_date, channels
      ) VALUES (
        @id, @network, @name, @latitude, @longitude, @elevation, @site_name, @start_date, @end_date, @channels
      )
      ON CONFLICT(id) DO UPDATE SET
        network = excluded.network,
        name = excluded.name,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        updated_at = strftime('%s', 'now')
    `);

    stmt.run(station);
  }

  // 批量插入台站数据
  static upsertStations(stations: Station[]): void {
    const stmt = db.prepare(`
      INSERT INTO stations (
        id, network, name, latitude, longitude, elevation, site_name, start_date, end_date, channels
      ) VALUES (
        @id, @network, @name, @latitude, @longitude, @elevation, @site_name, @start_date, @end_date, @channels
      )
      ON CONFLICT(id) DO UPDATE SET
        network = excluded.network,
        name = excluded.name,
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        updated_at = strftime('%s', 'now')
    `);

    const transaction = db.transaction((stationsList: Station[]) => {
      for (const station of stationsList) {
        stmt.run(station);
      }
    });

    transaction(stations);
  }

  // 获取所有台站
  static getAllStations(): Station[] {
    const stmt = db.prepare('SELECT * FROM stations ORDER BY network, name');
    return stmt.all() as Station[];
  }

  // 根据网络获取台站
  static getStationsByNetwork(network: string): Station[] {
    const stmt = db.prepare('SELECT * FROM stations WHERE network = ? ORDER BY name');
    return stmt.all(network) as Station[];
  }

  // 根据位置范围获取台站
  static getStationsInBounds(minLat: number, maxLat: number, minLon: number, maxLon: number): Station[] {
    const stmt = db.prepare(`
      SELECT * FROM stations 
      WHERE latitude BETWEEN ? AND ? 
      AND longitude BETWEEN ? AND ?
      ORDER BY latitude, longitude
    `);
    
    return stmt.all(minLat, maxLat, minLon, maxLon) as Station[];
  }

  // 根据ID获取台站详情
  static getStationById(id: string): Station | null {
    const stmt = db.prepare('SELECT * FROM stations WHERE id = ?');
    return stmt.get(id) as Station | null;
  }

  // 删除过期台站
  static removeExpiredStations(): number {
    const stmt = db.prepare(`
      DELETE FROM stations 
      WHERE end_date IS NOT NULL AND end_date < strftime('%s', 'now')
    `);
    
    const result = stmt.run();
    return result.changes;
  }

  // 获取台站统计数据
  static getStatistics(): any {
    const stats = db.prepare(`
      SELECT 
        COUNT(*) as total_count,
        COUNT(DISTINCT network) as network_count,
        AVG(latitude) as avg_latitude,
        AVG(longitude) as avg_longitude
      FROM stations
    `).get();

    const networkStats = db.prepare(`
      SELECT network, COUNT(*) as station_count
      FROM stations
      GROUP BY network
      ORDER BY station_count DESC
    `).all();

    return {
      ...stats,
      networks: networkStats
    };
  }
}

export { StationDAO, Station };