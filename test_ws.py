#!/usr/bin/env python3
"""
测试WebSocket连接和消息
"""

import websocket
import json
import time

def test_websocket():
    """测试WebSocket连接"""
    def on_message(ws, message):
        print(f"Received: {message}")
        try:
            data = json.loads(message)
            print(f"Parsed: type={data.get('type')}, count={data.get('count')}")
        except:
            print("Failed to parse JSON")
    
    def on_error(ws, error):
        print(f"Error: {error}")
    
    def on_close(ws, close_status_code, close_msg):
        print("### closed ###")
    
    def on_open(ws):
        print("WebSocket opened")
        # 发送测试消息
        ws.send(json.dumps({
            'type': 'stations_data',
            'stations': [
                {'network': 'TEST', 'station': 'STA1', 'latitude': 40.0, 'longitude': -100.0, 'site_name': 'Test Station'},
                {'network': 'TEST', 'station': 'STA2', 'latitude': 50.0, 'longitude': -90.0, 'site_name': 'Another Test'}
            ],
            'count': 2,
            'timestamp': '2026-03-02T18:20:00Z'
        }))
    
    websocket.enableTrace(True)
    ws = websocket.WebSocketApp("ws://localhost:3000",
                              on_open=on_open,
                              on_message=on_message,
                              on_error=on_error,
                              on_close=on_close)
    
    ws.run_forever()

if __name__ == "__main__":
    test_websocket()