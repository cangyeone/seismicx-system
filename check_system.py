#!/usr/bin/env python3
"""
系统状态检查脚本
"""

import asyncio
import websockets
import json
import requests

async def check_system_status():
    print("🔍 检查地震监测系统状态...")
    
    # 1. 检查后端服务
    try:
        response = requests.get("http://localhost:3000/api/health", timeout=5)
        if response.status_code == 200:
            print("✅ 后端服务运行正常")
        else:
            print("❌ 后端服务异常")
            return
    except:
        print("❌ 无法连接到后端服务")
        return
    
    # 2. 检查WebSocket连接
    try:
        # 测试前端WebSocket连接
        async with websockets.connect("ws://localhost:3000") as ws:
            print("✅ 前端WebSocket连接正常")
            
            # 等待初始数据
            initial_data = await asyncio.wait_for(ws.recv(), timeout=5)
            data = json.loads(initial_data)
            stations_count = len(data.get('stations', []))
            print(f"📊 初始台站数据: {stations_count} 个台站")
            
    except Exception as e:
        print(f"❌ 前端WebSocket连接失败: {e}")
    
    # 3. 检查采集器WebSocket连接
    try:
        async with websockets.connect("ws://localhost:8765") as ws:
            print("✅ 采集器WebSocket连接正常")
    except:
        print("❌ 采集器WebSocket连接失败")
    
    # 4. 检查API端点
    try:
        response = requests.get("http://localhost:3000/api/stations", timeout=5)
        if response.status_code == 200:
            stations_data = response.json()
            api_count = stations_data.get('metadata', {}).get('count', 0)
            print(f"📊 API台站数据: {api_count} 个台站")
        else:
            print("❌ 台站API异常")
    except Exception as e:
        print(f"❌ 无法访问台站API: {e}")
    
    print("\n📋 系统组件状态:")
    print("- 后端服务: http://localhost:3000")
    print("- 前端界面: http://localhost:5173") 
    print("- 采集器WebSocket: ws://localhost:8765")
    print("- 台站API: http://localhost:3000/api/stations")

if __name__ == "__main__":
    asyncio.run(check_system_status())