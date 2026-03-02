import asyncio
import logging
from datetime import datetime, timedelta
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
from obspy.core.stream import Stream

# 配置日志
logger = logging.getLogger(__name__)

class SeismicDataCollector:
    def __init__(self):
        self.fdsn_client = Client("IRIS")
        self.waveform_buffer = {}  # 存储每个台站的波形数据
    
    async def fetch_waveform_data(self, network, station, location="*", channel="HHZ", duration=60):
        """从FDSN获取实时波形数据"""
        try:
            def _fetch_waveforms():
                endtime = UTCDateTime()
                starttime = endtime - duration
                
                try:
                    st = self.fdsn_client.get_waveforms(
                        network=network,
                        station=station,
                        location=location,
                        channel=channel,
                        starttime=starttime,
                        endtime=endtime,
                        attach_response=False
                    )
                    return st
                except Exception as e:
                    logger.warning(f"波形获取失败 {network}.{station}: {e}")
                    return None
            
            # 在线程池中运行同步操作
            import concurrent.futures
            loop = asyncio.get_event_loop()
            with concurrent.futures.ThreadPoolExecutor() as executor:
                stream = await loop.run_in_executor(executor, _fetch_waveforms)
            
            if stream and len(stream) > 0:
                waveforms = []
                for tr in stream:
                    # 将波形数据转换为前端可用的格式
                    data = {
                        'network': tr.stats.network,
                        'station': tr.stats.station,
                        'location': tr.stats.location or "--",
                        'channel': tr.stats.channel,
                        'starttime': tr.stats.starttime.isoformat(),
                        'endtime': tr.stats.endtime.isoformat(),
                        'sampling_rate': tr.stats.sampling_rate,
                        'data': tr.data.tolist()  # 转换为列表以便 JSON 序列化
                    }
                    waveforms.append(data)
                
                logger.info(f"✅ 获取到 {network}.{station} 的波形数据：{len(waveforms)} 个通道")
                return waveforms
            else:
                logger.warning(f"⚠️ 未获取到 {network}.{station} 的波形数据")
                return []
                
        except Exception as e:
            logger.error(f"❌ 波形获取异常 {network}.{station}: {e}")
            return []
    
    async def fetch_3component_waveforms(self, network, station, duration=120):
        """获取三分量（E,N,Z）波形数据"""
        components = []
        
        # 首先尝试用通配符获取所有可用通道
        all_data = await self.fetch_waveform_data(
            network=network,
            station=station,
            channel="HH*",  # 获取所有 HH 通道
            duration=duration
        )
        if all_data:
            components.extend(all_data)
        
        # 如果没有 HH 数据，尝试 BH 通道
        if not components:
            all_data = await self.fetch_waveform_data(
                network=network,
                station=station,
                channel="BH*",  # 获取所有 BH 通道
                duration=duration
            )
            if all_data:
                components.extend(all_data)
        
        # 如果还没有数据，尝试 EH 通道
        if not components:
            all_data = await self.fetch_waveform_data(
                network=network,
                station=station,
                channel="EH*",
                duration=duration
            )
            if all_data:
                components.extend(all_data)
        
        logger.info(f"获取到 {network}.{station} 总共 {len(components)} 个通道")
        return components
    
    async def fetch_fdsn_stations(self, network, station, channel):
        """从FDSN获取台站信息"""
        try:
            # 使用同步方法包装成异步
            def _fetch_stations():
                starttime = UTCDateTime() - 86400  # 24小时前
                endtime = UTCDateTime()
                
                inventory = self.fdsn_client.get_stations(
                    network=network,
                    station=station,
                    channel=channel,
                    starttime=starttime,
                    endtime=endtime,
                    level="station"
                )
                
                stations = []
                for net in inventory:
                    for sta in net:
                        # 确保台站代码正确
                        station_code = sta.code if sta.code and sta.code != 'UNK' else sta.code
                        stations.append({
                            'network': net.code,
                            'code': station_code,           # 前端期望的code字段
                            'name': station_code,           # 前端显示用的name字段
                            'station': station_code,        # 兼容性字段
                            'latitude': sta.latitude,
                            'longitude': sta.longitude,
                            'elevation': sta.elevation,
                            'siteName': sta.site.name if sta.site else '',  # 前端期望的siteName字段
                            'site_name': sta.site.name if sta.site else '',
                            'network_description': 'IRIS Global Seismograph Network',
                            'region': self.get_station_region(sta.latitude, sta.longitude),
                            'last_update': datetime.now().isoformat()
                        })
                return stations
            
            # 在线程池中运行同步操作
            import concurrent.futures
            loop = asyncio.get_event_loop()
            with concurrent.futures.ThreadPoolExecutor() as executor:
                stations = await loop.run_in_executor(executor, _fetch_stations)
            
            return stations
            
        except Exception as e:
            logger.error(f"FDSN台站查询失败: {e}")
            return []
    
    def get_station_region(self, lat, lon):
        """根据经纬度获取区域信息"""
        # 简单的区域判断逻辑
        if lat > 0 and lon > 0:
            return "北半球东经区"
        elif lat > 0 and lon < 0:
            return "北半球西经区"
        elif lat < 0 and lon > 0:
            return "南半球东经区"
        else:
            return "南半球西经区"
    
    async def fetch_global_station_inventory(self):
        """获取全球范围的台站清单 - 简化修复版本"""
        logger.info("开始获取全球台站清单...")
        
        # 先测试最基本的IU网络
        try:
            stations = await self.fetch_fdsn_stations(
                network='IU',
                station='*',
                channel='HH*'
            )
            
            logger.info(f"IU网络查询结果: {len(stations) if stations else 0} 个台站")
            
            if stations:
                # 添加必要的字段，确保与前端期望的格式一致
                for station in stations:
                    station['network'] = station.get('network', '')
                    station['code'] = station.get('station', '')  # 前端期望的是 'code' 字段
                    station['siteName'] = station.get('site_name', '')  # 前端期望的是 'siteName' 字段
                    station['latitude'] = station.get('latitude', 0)
                    station['longitude'] = station.get('longitude', 0)
                    station['elevation'] = station.get('elevation', 0)
                    station['network_description'] = 'IRIS Global Seismograph Network'
                    station['region'] = self.get_station_region(station['latitude'], station['longitude'])
                    station['last_update'] = datetime.now().isoformat()
                
                logger.info(f"✅ 成功获取 {len(stations)} 个台站")
                return stations
            else:
                logger.warning("❌ IU网络未获取到台站")
                return []
                
        except Exception as e:
            logger.error(f"❌ 获取台站信息失败: {e}")
            return []