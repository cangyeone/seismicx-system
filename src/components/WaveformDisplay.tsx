import React, { useEffect, useRef, useState } from 'react';

interface WaveformComponent {
  network: string;
  station: string;
  location: string;
  channel: string;
  starttime: string;
  endtime: string;
  sampling_rate: number;
  data: number[];
}

interface WaveformData {
  station: string;
  network: string;
  stationCode: string;
  timestamp: string;
  duration: number;
  components: {
    E: WaveformComponent | null;
    N: WaveformComponent | null;
    Z: WaveformComponent | null;
    [key: string]: WaveformComponent | null;  // 支持任意分量名称
  };
}

interface WaveformProps {
  stationCode: string;
}

export const WaveformDisplay: React.FC<WaveformProps> = ({ stationCode }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [waveformData, setWaveformData] = useState<WaveformData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const canvasRefZ = useRef<HTMLCanvasElement>(null);
  const canvasRefN = useRef<HTMLCanvasElement>(null);
  const canvasRefE = useRef<HTMLCanvasElement>(null);

  // 解析台站代码
  const parseStationCode = (code: string) => {
    const parts = code.split('.');
    if (parts.length >= 2) {
      return { network: parts[0], station: parts[1] };
    }
    return { network: 'IU', station: code };
  };

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setIsConnected(true);
      console.log('Waveform socket connected');
      
      // 连接成功后请求波形数据
      const { network, station } = parseStationCode(stationCode);
      socket.send(JSON.stringify({
        type: 'request_waveform',
        network: network,
        station: station,
        timestamp: new Date().toISOString()
      }));
      setIsLoading(true);
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      if (message.type === 'waveform_data') {
        setWaveformData(message.data);
        setIsLoading(false);
        console.log('Received waveform data:', message.data.station);
      }
    };

    socket.onclose = () => {
      setIsConnected(false);
    };

    socket.onerror = (error) => {
      console.error('WebSocket error:', error);
      setIsLoading(false);
    };

    return () => socket.close();
  }, [stationCode]);

  // 绘制波形
  useEffect(() => {
    const render = () => {
      if (!waveformData) return;

      // 动态获取所有可用分量
      const availableComponents = Object.entries(waveformData.components)
        .filter(([_, comp]) => comp !== null)
        .map(([key, comp]) => {
          // 根据通道名称判断分量类型
          const channel = comp?.channel || '';
          let label = key;
          let color = '#888888';
          
          // Z 分量（垂直向）- 绿色
          if (channel.endsWith('Z') || key === 'Z') {
            label = 'Z';
            color = '#10b981';
          }
          // N 分量（南北向）- 蓝色
          else if (channel.endsWith('N') || key === 'N' || channel.includes('N')) {
            label = 'N';
            color = '#3b82f6';
          }
          // E 分量（东西向）- 橙色
          else if (channel.endsWith('E') || key === 'E' || channel.includes('E')) {
            label = 'E';
            color = '#f97316';
          }
          // 其他分量（如 1, 2 等）- 紫色
          else if (channel.endsWith('1') || channel.endsWith('2')) {
            label = channel.slice(-1);
            color = '#a855f7';
          }
          
          return {
            key,
            component: comp,
            color,
            label: label.toUpperCase()
          };
        });

      // 渲染每个可用分量
      availableComponents.forEach(({ component, color, label }) => {
        const canvasRef = label === 'Z' ? canvasRefZ : label === 'N' ? canvasRefN : canvasRefE;
        if (!canvasRef.current || !component) return;
        const canvas = canvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        // Draw grid
        ctx.strokeStyle = '#262626';
        ctx.lineWidth = 1;
        for (let i = 0; i < width; i += 50) {
          ctx.beginPath();
          ctx.moveTo(i, 0);
          ctx.lineTo(i, height);
          ctx.stroke();
        }

        // Draw baseline
        ctx.strokeStyle = '#404040';
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // Draw waveform
        const data = component.data;
        if (data && data.length > 1) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          
          // 归一化数据以适应显示
          const maxVal = Math.max(...data.map(Math.abs)) || 1;
          const step = width / data.length;
          
          data.forEach((val, i) => {
            const x = i * step;
            const normalizedVal = val / maxVal;
            const y = (height / 2) - (normalizedVal * (height / 2.5));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }

        // Component Label
        ctx.fillStyle = '#ffffff44';
        ctx.font = 'bold 12px monospace';
        ctx.fillText(label, 10, 20);

        // Channel info
        ctx.fillStyle = '#888888';
        ctx.font = '10px monospace';
        ctx.fillText(`${component.channel} ${component.sampling_rate.toFixed(1)}Hz`, width - 100, 20);
      });

      requestAnimationFrame(render);
    };

    const animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [waveformData]);

  const { network, station } = parseStationCode(stationCode);

  return (
    <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-4 shadow-lg overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`} />
          <span className="text-xs font-mono uppercase tracking-widest text-text-muted font-bold">
            IRIS Real-time Waveforms: {stationCode}
          </span>
        </div>
        {isLoading && (
          <span className="text-[10px] font-mono text-accent font-bold uppercase animate-pulse">
            Loading...
          </span>
        )}
      </div>
      
      <div className="flex flex-col gap-2">
        <canvas ref={canvasRefZ} width={400} height={80} className="w-full h-20 bg-black/40 rounded-lg border border-white/5" />
        <canvas ref={canvasRefN} width={400} height={80} className="w-full h-20 bg-black/40 rounded-lg border border-white/5" />
        <canvas ref={canvasRefE} width={400} height={80} className="w-full h-20 bg-black/40 rounded-lg border border-white/5" />
      </div>

      <div className="flex flex-wrap gap-2 mt-2">
        {['BHE', 'BHN', 'BHZ', 'HHE', 'HHN', 'HHZ'].map(channel => (
          <div key={channel} className="flex items-center gap-2 px-2 py-1 bg-white/5 rounded border border-white/10">
            <div className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-[10px] font-mono font-bold">{channel}</span>
          </div>
        ))}
      </div>

      {waveformData && (
        <div className="text-[10px] font-mono text-text-muted mt-2 pt-2 border-t border-border">
          <div className="flex justify-between">
            <span>Duration: {waveformData.duration}s</span>
            <span>Updated: {new Date(waveformData.timestamp).toLocaleTimeString()}</span>
          </div>
        </div>
      )}
    </div>
  );
};
