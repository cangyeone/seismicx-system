import { useEffect, useState, useRef } from 'react';

interface WebSocketMessage {
  type: string;
  [key: string]: any;
}

interface NewEarthquakeAnimation {
  center: { lat: number; lng: number };
  magnitude: number;
}

export const useWebSocket = (url: string = 'ws://localhost:3000') => {
  const [isConnected, setIsConnected] = useState(false);
  const [newEarthquakeAnimation, setNewEarthquakeAnimation] = useState<NewEarthquakeAnimation | null>(null);
  const [earthquakeEvents, setEarthquakeEvents] = useState<any[]>([]);
  const [stationsData, setStationsData] = useState<any[]>([]);
  const [latestWaveforms, setLatestWaveforms] = useState<any[]>([]);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const connect = () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) return;

      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        console.log('WebSocket connected');
        setIsConnected(true);
      };

      ws.onmessage = (event) => {
        try {
          const data: WebSocketMessage = JSON.parse(event.data);
          
          switch (data.type) {
            case 'new_earthquakes':
              if (data.animation) {
                setNewEarthquakeAnimation(data.animation);
                // Clear animation after 3 seconds
                setTimeout(() => {
                  setNewEarthquakeAnimation(null);
                }, 3000);
              }
              break;
              
            case 'initial_data':
              console.log('Initial data received:', data);
              break;
              
            case 'earthquake_events':
              // 处理Python采集器发送的地震事件数据
              console.log('Received earthquake events:', data.events?.length || 0);
              setEarthquakeEvents(prev => [...prev, ...(data.events || [])].slice(-100)); // 保留最新100条
              break;
              
            case 'stations_data':
              // 处理台站数据
              console.log('Received stations data:', data.stations?.length || 0);
              setStationsData(data.stations || []);
              break;
              
            case 'waveform_data':
              // 处理波形数据
              console.log('Received waveform data:', data.data?.station);
              setLatestWaveforms(prev => [...prev.slice(-50), data.data]); // 保留最新的50条波形数据
              break;
              
            default:
              console.log('Unknown message type:', data.type);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
      };

      ws.onclose = () => {
        console.log('WebSocket disconnected');
        setIsConnected(false);
        // Attempt to reconnect after 3 seconds
        setTimeout(connect, 3000);
      };
    };

    connect();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [url]);

  return {
    isConnected,
    newEarthquakeAnimation,
    earthquakeEvents,
    stationsData,
    latestWaveforms,
    sendMessage: (message: WebSocketMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
      }
    }
  };
};