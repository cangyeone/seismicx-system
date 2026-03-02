#!/usr/bin/env python3
"""
调试脚本：检查Obspy返回的台站数据结构
"""

import asyncio
from obspy.clients.fdsn import Client
from obspy import UTCDateTime

async def debug_station_structure():
    print("🔍 调试Obspy台站数据结构...")
    
    client = Client("IRIS")
    starttime = UTCDateTime() - 86400
    endtime = UTCDateTime()
    
    try:
        inventory = client.get_stations(
            network='IU',
            station='*',
            channel='HH*',
            starttime=starttime,
            endtime=endtime,
            level="station"
        )
        
        print(f"库存包含 {len(inventory)} 个网络")
        
        for i, net in enumerate(inventory[:1]):
            print(f"\n网络 {i+1}: {net.code}")
            print(f"网络对象类型: {type(net)}")
            print(f"网络属性: {dir(net)}")
            
            for j, sta in enumerate(net[:2]):
                print(f"\n  台站 {j+1}: {sta.code}")
                print(f"  台站对象类型: {type(sta)}")
                print(f"  台站属性: {dir(sta)}")
                
                # 打印关键属性
                print(f"  sta.code: {sta.code}")
                print(f"  sta.latitude: {sta.latitude}")
                print(f"  sta.longitude: {sta.longitude}")
                print(f"  sta.elevation: {sta.elevation}")
                print(f"  sta.site: {sta.site}")
                if sta.site:
                    print(f"  sta.site.name: {sta.site.name}")
                    print(f"  sta.site.description: {sta.site.description}")
                
    except Exception as e:
        print(f"❌ 错误: {e}")

if __name__ == "__main__":
    asyncio.run(debug_station_structure())