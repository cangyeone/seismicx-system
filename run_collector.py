#!/usr/bin/env python3
"""
地震数据采集器主程序 - 支持实时波形数据
"""

import asyncio
import websockets
import json
import logging
from datetime import datetime
import sys
import os
import sqlite3

# 添加当前目录到 Python 路径
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from seismic_collector import SeismicDataCollector

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

class DataCollectorService:
    def __init__(self):
        self.collector = SeismicDataCollector()
        self.websocket_uri = "ws://localhost:8765"
        self.ws_client = None
        self.logger = logging.getLogger(__name__)
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
                start_date INTEGER,
                end_date INTEGER,
                channels TEXT,
                created_at INTEGER DEFAULT (strftime('%s', 'now')),
                updated_at INTEGER DEFAULT (strftime('%s', 'now'))
            )
        ''')
        self.db_conn.commit()
    
    def save_stations_to_db(self, stations):
        """将台站数据保存到数据库"""
        cursor = self.db_conn.cursor()
        for station in stations:
            cursor.execute('''
                INSERT OR REPLACE INTO stations 
                (id, network, name, latitude, longitude, elevation, site_name, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%s', 'now'))
            ''', (
                f"{station['network']}.{station['station']}",
                station['network'],
                station['station'],
                station['latitude'],
                station['longitude'],
                station.get('elevation', 0),
                station.get('site_name', '')
            ))
        self.db_conn.commit()
        self.logger.info(f"💾 已保存 {len(stations)} 个台站到数据库")
        
    async def stream_waveforms_for_station(self, network, station, duration=120):
        """为指定台站流式传输波形数据"""
        self.logger.info(f"🌊 开始获取 {network}.{station} 的实时波形...")
        
        try:
            waveforms = await self.collector.fetch_3component_waveforms(
                network=network,
                station=station,
                duration=duration
            )
            
            if waveforms:
                e_data = [w for w in waveforms if w['channel'].endswith('E')]
                n_data = [w for w in waveforms if w['channel'].endswith('N')]
                z_data = [w for w in waveforms if w['channel'].endswith('Z')]
                
                message = {
                    'type': 'waveform_data',
                    'station': f"{network}.{station}",
                    'network': network,
                    'stationCode': station,
                    'timestamp': datetime.now().isoformat(),
                    'duration': duration,
                    'components': {
                        'E': e_data[0] if e_data else None,
                        'N': n_data[0] if n_data else None,
                        'Z': z_data[0] if z_data else None
                    }
                }
                
                await self.send_message('waveform_data', message)
                self.logger.info(f"✅ 已发送 {network}.{station} 的波形数据")
            else:
                self.logger.warning(f"⚠️ 未获取到 {network}.{station} 的波形数据")
                
        except Exception as e:
            self.logger.error(f"❌ 波形流传输失败：{e}")
    
    async def connect_websocket(self):
        """连接到 Node.js 后端 WebSocket"""
        try:
            self.logger.info(f"正在连接到 {self.websocket_uri}")
            self.ws_client = await websockets.connect(self.websocket_uri)
            self.logger.info("✅ WebSocket 连接成功")
            return True
        except Exception as e:
            self.logger.error(f"❌ WebSocket 连接失败：{e}")
            return False
    
    async def send_message(self, message_type, data):
        """发送消息到 WebSocket"""
        if not self.ws_client:
            self.logger.warning("WebSocket 未连接")
            return False
            
        try:
            message = {
                'type': message_type,
                'data': data,
                'timestamp': datetime.now().isoformat()
            }
            await self.ws_client.send(json.dumps(message, ensure_ascii=False))
            self.logger.info(f"📤 发送消息类型：{message_type}")
            return True
        except websockets.exceptions.ConnectionClosed:
            self.logger.warning("WebSocket 连接已关闭，无法发送消息")
            return False
        except Exception as e:
            self.logger.error(f"❌ 发送消息失败：{e}")
            return False
    
    async def periodic_station_refresh(self):
        """定期刷新台站列表"""
        while True:
            try:
                self.logger.info("🔄 开始获取全球台站清单...")
                stations = await self.collector.fetch_global_station_inventory()
                
                if stations:
                    self.logger.info(f"✅ 获取到 {len(stations)} 个台站")
                    self.save_stations_to_db(stations)
                    await self.send_message('stations_data', stations)
                else:
                    self.logger.warning("⚠️ 未获取到台站数据")
                
                await asyncio.sleep(30)
                
            except Exception as e:
                self.logger.error(f"❌ 定期刷新出错：{e}")
                await asyncio.sleep(30)
    
    async def start_service(self):
        """启动服务"""
        self.logger.info("🚀 启动地震数据采集器服务...")
        
        while True:
            if not await self.connect_websocket():
                self.logger.error("无法连接到 WebSocket 服务器，5 秒后重试...")
                await asyncio.sleep(5)
                continue
            
            try:
                station_task = asyncio.create_task(self.periodic_station_refresh())
                
                while True:
                    try:
                        message = await self.ws_client.recv()
                        data = json.loads(message)
                        self.logger.debug(f"📥 收到消息：{data}")
                        
                        if data.get('type') == 'request_stations':
                            self.logger.info("收到台站请求，立即刷新...")
                            stations = await self.collector.fetch_global_station_inventory()
                            if stations:
                                self.save_stations_to_db(stations)
                            await self.send_message('stations_data', stations)
                        
                        elif data.get('type') == 'request_waveform':
                            network = data.get('network')
                            station = data.get('station')
                            if network and station:
                                self.logger.info(f"收到波形请求：{network}.{station}")
                                await self.stream_waveforms_for_station(network, station)
                            
                    except websockets.exceptions.ConnectionClosed:
                        self.logger.warning("WebSocket 连接已关闭，尝试重连...")
                        await asyncio.sleep(2)
                        break
                        
            except KeyboardInterrupt:
                self.logger.info("Received shutdown signal")
                if self.ws_client:
                    await self.ws_client.close()
                break
            except Exception as e:
                self.logger.error(f"服务运行出错：{e}")
                if self.ws_client:
                    await self.ws_client.close()
                await asyncio.sleep(5)

if __name__ == "__main__":
    service = DataCollectorService()
    asyncio.run(service.start_service())
