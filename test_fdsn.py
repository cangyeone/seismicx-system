#!/usr/bin/env python3
"""
测试FDSNWS台站查询
"""

from obspy.clients.fdsn import Client
from obspy import UTCDateTime

# 测试IRIS台站查询
try:
    client = Client('IRIS')
    inventory = client.get_stations(
        network='IU',
        station='*',
        channel='HH*',
        starttime=UTCDateTime() - 3600,
        endtime=UTCDateTime(),
        level='station'
    )
    
    print(f"成功获取到 {len(inventory)} 个网络")
    for network in inventory:
        print(f"网络 {network.code}: {len(network)} 个台站")
        for station in network:
            print(f"  台站: {station.code} ({station.latitude}, {station.longitude})")
            
except Exception as e:
    print(f"查询失败: {e}")