#!/usr/bin/env python3
"""
快速测试台站获取功能
"""

from obspy.clients.fdsn import Client
from obspy import UTCDateTime

def test_station_query():
    """测试台站查询"""
    try:
        # 测试IRIS
        client = Client('IRIS')
        inventory = client.get_stations(
            network='IU',
            station='*',
            channel='HH*',
            starttime=UTCDateTime() - 3600,
            endtime=UTCDateTime(),
            level='station'
        )
        
        print(f"✅ IRIS IU: {len(inventory)} 个网络")
        if inventory:
            for net in inventory:
                print(f"   ✅ 网络 {net.code}: {len(net)} 个台站")
                for sta, count in [(sta.code, 1) for sta in net]:
                    print(f"      • {sta}")
        
        return True
        
    except Exception as e:
        print(f"❌ 查询失败: {e}")
        return False

if __name__ == "__main__":
    test_station_query()