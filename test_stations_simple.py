#!/usr/bin/env python3
"""
简单的台站获取测试脚本
"""

import asyncio
import logging
from obspy.clients.fdsn import Client
from obspy import UTCDateTime

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

async def test_simple_station_fetch():
    """简单测试台站获取"""
    logger.info("开始简单台站获取测试...")
    
    try:
        # 创建FDSN客户端
        client = Client("IRIS")
        logger.info("✅ 成功连接到IRIS FDSNWS")
        
        # 查询IU网络的所有台站
        starttime = UTCDateTime() - 86400  # 24小时前
        endtime = UTCDateTime()
        
        logger.info("正在查询IU网络台站...")
        inventory = client.get_stations(
            network="IU",
            station="*",
            starttime=starttime,
            endtime=endtime,
            level="station"
        )
        
        # 统计台站数量
        station_count = 0
        stations_list = []
        
        for network in inventory:
            logger.info(f"网络 {network.code} 有 {len(network)} 个台站")
            for station in network:
                station_count += 1
                stations_list.append({
                    'network': network.code,
                    'station': station.code,
                    'latitude': station.latitude,
                    'longitude': station.longitude,
                    'elevation': station.elevation
                })
        
        logger.info(f"✅ 总共获取到 {station_count} 个台站")
        
        # 显示前几个台站作为示例
        logger.info("前5个台站:")
        for i, station in enumerate(stations_list[:5]):
            logger.info(f"  {i+1}. {station['network']}.{station['station']} "
                       f"({station['latitude']:.2f}, {station['longitude']:.2f})")
        
        # 返回结果
        return stations_list
        
    except Exception as e:
        logger.error(f"❌ 测试失败: {e}")
        return []

if __name__ == "__main__":
    # 运行测试
    stations = asyncio.run(test_simple_station_fetch())
    print(f"\n最终结果: 获取到 {len(stations)} 个台站")