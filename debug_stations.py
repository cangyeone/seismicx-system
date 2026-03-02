#!/usr/bin/env python3
"""
调试台站获取逻辑
"""

from obspy.clients.fdsn import Client
from obspy import UTCDateTime

def debug_station_fetch():
    """调试台站获取"""
    try:
        client = Client('IRIS')
        
        # 测试单个网络
        inventory = client.get_stations(
            network='IU',
            station='*',
            channel='HH*',
            starttime=UTCDateTime() - 3600,
            endtime=UTCDateTime(),
            level='station'
        )
        
        print(f"IRIS IU 网络台站数量: {len(inventory)}")
        if inventory:
            for net in inventory:
                print(f"  网络 {net.code}: {len(net)} 个台站")
                for station in net:
                    print(f"    • {station.code} ({station.latitude}, {station.longitude})")
        
        # 测试多个网络
        networks = ['IU', 'II', 'IC']
        all_stations = []
        
        for net_code in networks:
            try:
                inv = client.get_stations(
                    network=net_code,
                    station='*',
                    channel='HH*',
                    starttime=UTCDateTime() - 3600,
                    endtime=UTCDateTime(),
                    level='station'
                )
                count = sum(len(station) for station in inv)
                print(f"网络 {net_code}: {count} 个台站")
                all_stations.extend([s for net in inv for s in net])
            except Exception as e:
                print(f"网络 {net_code} 查询失败: {e}")
        
        print(f"总计台站数: {len(all_stations)}")
        
    except Exception as e:
        print(f"错误: {e}")

if __name__ == "__main__":
    debug_station_fetch()