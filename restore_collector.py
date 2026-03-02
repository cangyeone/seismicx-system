#!/usr/bin/env python3
"""
简化版台站采集器 - 恢复到基础工作版本
"""

import asyncio
import websockets
import json
import logging
from datetime import datetime
import sys
import os
import sqlite3

# 添加当前目录到Python路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('seismic_data_collector.log'),
        logging.StreamHandler()
    ]
)
logger = logging.getLogger(__name__)

class SimpleSeismicCollector:
    def __init__(self):
        self.db_conn = sqlite3.connect('seismic_data.db')
        self.setup_database()
    
    def setup_database(self):
        """设置数据库表结构"""
        cursor = self.db_conn.cursor()
        cursor.execute('''
            CREATE TABLE IF NOT EXISTS stations (
                id TEXT PRIMARY KEY,
                network TEXT NOT NULL,
                name TEXT NOT NULL,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                elevation REAL,
                site_name TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            )
        ''')
        self.db_conn.commit()
    
    async def get_iu_stations(self):
        """获取IU网络台站 - 简化版本"""
        # 模拟真实的IU台站数据（基于实际观测）
        iu_stations = [
            {'network': 'IU', 'name': 'ADK', 'latitude': 51.8823, 'longitude': -176.6842, 'elevation': 130.0, 'site_name': 'Adak, Aleutian Islands, Alaska'},
            {'network': 'IU', 'name': 'AFI', 'latitude': -13.90853, 'longitude': -171.78265, 'elevation': 706.0, 'site_name': 'Afiamalu, Samoa'},
            {'network': 'IU', 'name': 'ANMO', 'latitude': 34.94591, 'longitude': -106.4572, 'elevation': 1850.0, 'site_name': 'Albuquerque, New Mexico, USA'},
            {'network': 'IU', 'name': 'ANTO', 'latitude': 39.8733, 'longitude': 32.7933, 'elevation': 930.0, 'site_name': 'Ankara, Turkey'},
            {'network': 'IU', 'name': 'BBSR', 'latitude': 32.37, 'longitude': -64.7, 'elevation': 750.0, 'site_name': 'Bermuda Institute of Ocean Sciences, St George\'s Bermuda'},
        ]
        return iu_stations
    
    def save_stations_to_db(self, stations):
        """保存台站到数据库"""
        cursor = self.db_conn.cursor()
        for station in stations:
            cursor.execute('''
                INSERT OR REPLACE INTO stations 
                (id, network, name, latitude, longitude, elevation, site_name, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
            ''', (
                f"{station['network']}.{station['name']}",
                station['network'],
                station['name'],
                station['latitude'],
                station['longitude'],
                station.get('elevation', 0),
                station.get('site_name', '')
            ))
        self.db_conn.commit()
        logger.info(f"💾 已保存 {len(stations)} 个台站到数据库")

async def main():
    collector = SimpleSeismicCollector()
    logger.info("🚀 启动简化版地震数据采集器...")
    
    # 获取台站数据
    stations = await collector.get_iu_stations()
    logger.info(f"✅ 获取到 {len(stations)} 个台站")
    
    # 保存到数据库
    collector.save_stations_to_db(stations)
    
    # 发送到WebSocket（模拟）
    try:
        async with websockets.connect("ws://localhost:8765") as ws:
            logger.info("✅ WebSocket连接成功")
            
            # 发送台站数据
            message = {
                'type': 'stations_data',
                'data': stations,
                'timestamp': datetime.now().isoformat()
            }
            await ws.send(json.dumps(message))
            logger.info(f"📤 发送了 {len(stations)} 个台站数据")
            
    except Exception as e:
        logger.error(f"❌ WebSocket连接失败: {e}")
        # 如果连接失败，直接保存到数据库
        collector.save_stations_to_db(stations)

if __name__ == "__main__":
    asyncio.run(main())