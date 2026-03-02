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
    sendMessage: (message: WebSocketMessage) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify(message));
      }
    }
  };
};