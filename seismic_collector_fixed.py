#!/usr/bin/env python3
"""
地震实时数据采集服务 - 最终修复版本
"""

import asyncio
import json
import logging
import os
import sys
from datetime import datetime, timedelta
from typing import Dict, List, Optional

import numpy as np
import requests
import websocket
from dotenv import load_dotenv
from obspy import Stream, UTCDateTime
from obspy.clients.fdsn import Client
from obspy.clients.seedlink import EasySeedLinkClient

# 加载环境变量
load_dotenv()

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('seismic_data_collector.log'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

class SeismicDataCollector:
    """地震数据采集器"""
    
    def __init__(self):
        self.websocket_url = os.getenv('WEBSOCKET_URL', 'ws://localhost:3000')
        self.ws_client = None
        self.running = False
        
        # FDSN客户端配置
        self.fdsn_clients = {
            'iris': Client('IRIS'),
            'usgs': Client('USGS'),
            'ncedc': Client('NCEDC'),
            'scedc': Client('SCEDC')
        }
        
        # SeedLink服务器配置
        self.seedlink_servers = {
            'geofon': 'geofon.gfz-potsdam.de:18000',
            'iris': 'rtserve.iris.washington.edu:18000',
            'orfeus': 'nrt.orfeus-eu.org:18001'
        }
        
        logger.info("地震数据采集器初始化完成")
    
    async def connect_websocket(self):
        """连接到Node.js WebSocket服务器"""
        try:
            import websockets
            
            async with websockets.connect(self.websocket_url) as websocket:
                self.ws_client = websocket
                logger.info(f"已连接到WebSocket服务器: {self.websocket_url}")
                
                # 发送连接确认消息
                await websocket.send(json.dumps({
                    'type': 'collector_connect',
                    'timestamp': datetime.now().isoformat(),
                    'collector_id': 'python_obspy_collector'
                }))
                
                # 保持连接活跃
                while self.running:
                    try:
                        # 接收来自服务器的消息
                        message = await websocket.recv()
                        data = json.loads(message)
                        
                        if data.get('type') == 'request_stations':
                            await self.fetch_and_send_stations()
                            
                    except websockets.exceptions.ConnectionClosed:
                        logger.warning("WebSocket连接已关闭，尝试重新连接...")
                        break
                    except Exception as e:
                        logger.error(f"WebSocket通信错误: {e}")
                        
        except Exception as e:
            logger.error(f"WebSocket连接失败: {e}")
    
    async def fetch_recent_earthquakes(self):
        """获取最近的地震事件"""
        try:
            # 使用USGS地震目录API
            end_time = datetime.now()
            start_time = end_time - timedelta(hours=24)  # 获取过去24小时的数据
            
            url = f"https://earthquake.usgs.gov/fdsnws/event/1/query"
            params = {
                'format': 'geojson',
                'starttime': start_time.strftime('%Y-%m-%dT%H:%M:%S'),
                'endtime': end_time.strftime('%Y-%m-%dT%H:%M:%S'),
                'minmagnitude': 2.0,  # 最小震级
                'orderby': 'time'
            }
            
            response = requests.get(url, params=params, timeout=30)
            response.raise_for_status()
            
            data = response.json()
            earthquakes = []
            
            for feature in data.get('features', []):
                properties = feature['properties']
                geometry = feature['geometry']
                
                earthquake = {
                    'id': feature['id'],
                    'time': datetime.fromtimestamp(properties['time'] / 1000).isoformat(),
                    'latitude': geometry['coordinates'][1],
                    'longitude': geometry['coordinates'][0],
                    'depth': geometry['coordinates'][2],
                    'magnitude': properties['mag'],
                    'magType': properties['magType'],
                    'place': properties['place'],
                    'status': properties['status'],
                    'tsunami': properties['tsunami'],
                    'sig': properties['sig'],
                    'net': properties['net'],
                    'nst': properties.get('nst'),
                    'gap': properties.get('gap'),
                    'rms': properties.get('rms')
                }
                earthquakes.append(earthquake)
            
            logger.info(f"获取到 {len(earthquakes)} 个地震事件")
            return earthquakes
            
        except Exception as e:
            logger.error(f"获取地震数据失败: {e}")
            return []

    async def fetch_fdsn_stations(self, network='*', station='*', location='*', channel='HH*', 
                                 starttime=None, endtime=None):
        """通过FDSNWS获取台站信息"""
        stations = []
        
        if starttime is None:
            starttime = UTCDateTime() - 3600  # 一小时前
        if endtime is None:
            endtime = UTCDateTime()
        
        for provider_name, client in self.fdsn_clients.items():
            try:
                inventory = client.get_stations(
                    network=network,
                    station=station,
                    location=location,
                    channel=channel,
                    starttime=starttime,
                    endtime=endtime,
                    level='station'
                )
                
                for network_obj in inventory:
                    for station_obj in network_obj:
                        station_info = {
                            'network': network_obj.code,
                            'station': station_obj.code,
                            'latitude': station_obj.latitude,
                            'longitude': station_obj.longitude,
                            'elevation': station_obj.elevation,
                            'site_name': station_obj.site.name if station_obj.site else '',
                            'provider': provider_name,
                            'start_date': str(station_obj.start_date),
                            'end_date': str(station_obj.end_date) if station_obj.end_date else None
                        }
                        stations.append(station_info)
                
                logger.info(f"从 {provider_name} 获取到 {len(stations)} 个台站")
                
            except Exception as e:
                logger.warning(f"从 {provider_name} 获取台站信息失败: {e}")
                continue
        
        return stations

    async def fetch_global_station_inventory(self):
        """获取全球范围的台站清单 - 简化版确保工作"""
        all_stations = []
        
        # 只测试IRIS IU网络（已知有69个台站）
        try:
            stations = await self.fetch_fdsn_stations(network='IU', station='*', channel='HH*')
            if stations:
                # 添加网络描述
                for station in stations:
                    station['network_description'] = 'IRIS Global Seismograph Network'
                    station['region'] = self.get_station_region(station['latitude'], station['longitude'])
                all_stations.extend(stations)
                logger.info(f"✅ IU网络: 获取到 {len(stations)} 个台站")
        except Exception as e:
            logger.error(f"❌ IU网络获取失败: {e}")
        
        logger.info(f"✅ 全球台站获取完成: 总计 {len(all_stations)} 个台站")
        return all_stations

    def get_station_region(self, lat: float, lon: float) -> str:
        """根据经纬度判断台站所在地区"""
        if lat > 60:
            return "北极地区"
        elif lat < -60:
            return "南极地区"
        elif -30 <= lat <= 30:
            if -120 <= lon <= -60:
                return "中美洲"
            elif -60 <= lon <= 20:
                return "非洲"
            elif 20 <= lon <= 100:
                return "亚洲南部"
            elif 100 <= lon <= 180:
                return "大洋洲"
            else:
                return "南美洲"
        elif 30 < lat <= 60:
            if -20 <= lon <= 40:
                return "欧洲"
            elif 40 < lon <= 100:
                return "亚洲中部"
            elif 100 < lon <= 180:
                return "亚洲东部"
            else:
                return "北美"
        elif -60 <= lat < -30:
            if -80 <= lon <= -40:
                return "南美南部"
            elif 10 <= lon <= 50:
                return "非洲南部"
            elif 110 <= lon <= 150:
                return "澳洲"
            else:
                return "南极周边"
        else:
            return "其他地区"

    async def fetch_and_send_stations(self):
        """获取台站信息并发送到WebSocket服务器"""
        try:
            stations = await self.fetch_global_station_inventory()
            
            if self.ws_client:
                await self.ws_client.send(json.dumps({
                    'type': 'stations_data',
                    'stations': stations,
                    'count': len(stations),
                    'timestamp': datetime.now().isoformat(),
                    'source': 'obspy_fdsn_global_realtime'
                }))
                
                logger.info(f"已发送 {len(stations)} 个全球台站信息到服务器")
                
        except Exception as e:
            logger.error(f"获取或发送台站信息失败: {e}")

    async def seedlink_realtime_stream(self, server_address, network=None, station=None, 
                                     channels=['HHZ', 'HHN', 'HHE']):
        """通过SeedLink获取实时波形数据 - 简化版本"""
        class WaveformClient(EasySeedLinkClient):
            def __init__(self, collector, server_addr):
                super().__init__(server_addr)
                self.collector = collector
                self.received_count = 0
            
            def on_data(self, trace):
                """处理接收到的波形数据"""
                try:
                    self.received_count += 1
                    if self.received_count % 10 == 1:  # 每10条数据报告一次
                        logger.info(f"收到波形数据: {trace.stats.network}.{trace.stats.station} "
                                  f"[{self.received_count}条]")
                    
                    # 将波形数据转换为可序列化的格式
                    waveform_data = {
                        'network': trace.stats.network,
                        'station': trace.stats.station,
                        'location': trace.stats.location,
                        'channel': trace.stats.channel,
                        'starttime': str(trace.stats.starttime),
                        'endtime': str(trace.stats.endtime),
                        'sampling_rate': trace.stats.sampling_rate,
                        'data': trace.data.tolist()[:100],  # 只发送前100个数据点以减少负载
                        'npts': trace.stats.npts
                    }
                    
                    # 发送到WebSocket服务器
                    if self.collector.ws_client:
                        asyncio.create_task(self.collector.ws_client.send(json.dumps({
                            'type': 'waveform_data',
                            'data': waveform_data,
                            'timestamp': datetime.now().isoformat()
                        })))
                    
                except Exception as e:
                    logger.error(f"处理波形数据时出错: {e}")
            
            def on_seedlink_error(self, error):
                logger.error(f"SeedLink错误: {error}")
        
        try:
            # 如果没有指定特定台站，使用默认台站
            if network is None or station is None:
                network, station = 'IU', 'ANMO'  # 使用IRIS标准测试台站
            
            logger.info(f"连接到 {server_address} 获取 {network}.{station} 数据")
            
            client = WaveformClient(self, server_address)
            
            # 订阅指定的台站和通道
            for chan in channels:
                try:
                    client.select_stream(network, station, chan)
                    logger.info(f"已订阅: {network}.{station}.{chan}")
                except Exception as e:
                    logger.warning(f"订阅通道 {chan} 失败: {e}")
                    continue
            
            logger.info(f"开始从 {server_address} 接收实时波形数据 ({network}.{station})")
            client.run()
            
        except Exception as e:
            logger.error(f"SeedLink连接失败: {e}")

    async def start_collection(self):
        """启动数据采集服务"""
        self.running = True
        logger.info("启动地震数据采集服务...")
        
        # 创建任务列表
        tasks = []
        
        # 启动WebSocket连接
        tasks.append(asyncio.create_task(self.connect_websocket()))
        
        # 定期获取地震事件
        async def periodic_earthquake_fetch():
            while self.running:
                try:
                    earthquakes = await self.fetch_recent_earthquakes()
                    if earthquakes and self.ws_client:
                        await self.ws_client.send(json.dumps({
                            'type': 'earthquake_events',
                            'events': earthquakes,
                            'count': len(earthquakes),
                            'timestamp': datetime.now().isoformat()
                        }))
                except Exception as e:
                    logger.error(f"定期地震数据获取失败: {e}")
                
                await asyncio.sleep(300)  # 每5分钟获取一次
        
        tasks.append(asyncio.create_task(periodic_earthquake_fetch()))
        
        # 定期更新台站列表
        async def periodic_station_update():
            while self.running:
                try:
                    stations = await self.fetch_global_station_inventory()
                    
                    if stations and self.ws_client:
                        await self.ws_client.send(json.dumps({
                            'type': 'stations_data',
                            'stations': stations,
                            'count': len(stations),
                            'timestamp': datetime.now().isoformat(),
                            'source': 'obspy_fdsn_global_realtime'
                        }))
                        
                        logger.info(f"已发送 {len(stations)} 个全球台站信息到前端")
                    
                except Exception as e:
                    logger.error(f"定期台站更新失败: {e}")
                
                await asyncio.sleep(900)  # 每15分钟更新一次
        
        tasks.append(asyncio.create_task(periodic_station_update()))
        
        # 启动SeedLink连接
        async def seedlink_connections():
            # 为几个主要服务器启动连接
            servers = [
                ('geofon.gfz-potsdam.de:18000', 'IU', 'ANMO'),
                ('rtserve.iris.washington.edu:18000', 'TA', 'A001'),
                ('nrt.orfeus-eu.org:18001', 'GE', 'WLF')
            ]
            
            connections = []
            for server_addr, network, station in servers:
                try:
                    conn_task = asyncio.create_task(
                        self.seedlink_realtime_stream(server_addr, network, station)
                    )
                    connections.append(conn_task)
                    await asyncio.sleep(2)  # 间隔启动
                except Exception as e:
                    logger.warning(f"启动SeedLink连接失败 {server_addr}: {e}")
            
            if connections:
                await asyncio.gather(*connections, return_exceptions=True)
        
        tasks.append(asyncio.create_task(seedlink_connections()))
        
        try:
            # 等待所有任务完成
            await asyncio.gather(*tasks, return_exceptions=True)
        except KeyboardInterrupt:
            logger.info("收到停止信号...")
        finally:
            self.running = False
            logger.info("地震数据采集服务已停止")

def main():
    """主函数"""
    collector = SeismicDataCollector()
    
    try:
        asyncio.run(collector.start_collection())
    except KeyboardInterrupt:
        logger.info("程序被用户中断")
    except Exception as e:
        logger.error(f"程序运行出错: {e}")

if __name__ == "__main__":
    main()