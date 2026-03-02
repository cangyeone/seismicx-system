import React, { useEffect, useRef, useState } from 'react';

interface Detection {
  phase: string;
  probability: number;
  timestamp: number;
}

interface WaveformProps {
  stationCode: string;
}

export const WaveformDisplay: React.FC<WaveformProps> = ({ stationCode }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [detections, setDetections] = useState<Detection[]>([]);
  
  const canvasRefZ = useRef<HTMLCanvasElement>(null);
  const canvasRefN = useRef<HTMLCanvasElement>(null);
  const canvasRefE = useRef<HTMLCanvasElement>(null);
  
  const dataRefZ = useRef<number[]>([]);
  const dataRefN = useRef<number[]>([]);
  const dataRefE = useRef<number[]>([]);
  const timestampsRef = useRef<number[]>([]);

  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}`;
    const socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      setIsConnected(true);
      console.log('Waveform socket connected');
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      
      if (message.type === 'waveform') {
        const { values, timestamp } = message;
        
        dataRefZ.current = [...dataRefZ.current, values.Z].slice(-500);
        dataRefN.current = [...dataRefN.current, values.N].slice(-500);
        dataRefE.current = [...dataRefE.current, values.E].slice(-500);
        timestampsRef.current = [...timestampsRef.current, timestamp].slice(-500);
      } else if (message.type === 'detections') {
        setDetections(prev => {
          const newDetections = [...prev, ...message.detections];
          // Keep only detections within the last 10 seconds of the visible window
          const now = Date.now();
          return newDetections.filter(d => now - d.timestamp < 15000);
        });
      }
    };

    socket.onclose = () => {
      setIsConnected(false);
    };

    return () => socket.close();
  }, [stationCode]);

  useEffect(() => {
    const render = () => {
      const canvases = [
        { ref: canvasRefZ, data: dataRefZ.current, color: '#10b981', label: 'Z' },
        { ref: canvasRefN, data: dataRefN.current, color: '#3b82f6', label: 'N' },
        { ref: canvasRefE, data: dataRefE.current, color: '#f97316', label: 'E' }
      ];

      canvases.forEach(({ ref, data, color, label }) => {
        if (!ref.current) return;
        const canvas = ref.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        ctx.clearRect(0, 0, width, height);

        // Draw grid
        ctx.strokeStyle = '#262626';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let i = 0; i < width; i += 50) {
          ctx.moveTo(i, 0);
          ctx.lineTo(i, height);
        }
        ctx.stroke();

        // Draw baseline
        ctx.strokeStyle = '#404040';
        ctx.beginPath();
        ctx.moveTo(0, height / 2);
        ctx.lineTo(width, height / 2);
        ctx.stroke();

        // Draw waveform
        if (data.length > 1) {
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          const step = width / 500;
          data.forEach((val, i) => {
            const x = i * step;
            const y = (height / 2) - (val * (height / 2.5));
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.stroke();
        }

        // Draw detections
        const now = Date.now();
        const windowDuration = 5000; // 5 seconds visible (at 100Hz, 500 points)
        
        detections.forEach(det => {
          const timeOffset = now - det.timestamp;
          if (timeOffset >= 0 && timeOffset < windowDuration) {
            const x = width - (timeOffset / windowDuration) * width;
            
            // Vertical line
            ctx.strokeStyle = '#ef4444';
            ctx.setLineDash([5, 5]);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, height);
            ctx.stroke();
            ctx.setLineDash([]);

            // Label
            ctx.fillStyle = '#ef4444';
            ctx.font = 'bold 10px monospace';
            ctx.fillText(det.phase, x + 4, 12);
          }
        });

        // Component Label
        ctx.fillStyle = '#ffffff44';
        ctx.font = 'bold 12px monospace';
        ctx.fillText(label, 10, 20);
      });

      requestAnimationFrame(render);
    };

    const animId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animId);
  }, [detections]);

  return (
    <div className="bg-card border border-border rounded-2xl p-5 flex flex-col gap-4 shadow-lg overflow-hidden">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-red-500'}`} />
          <span className="text-xs font-mono uppercase tracking-widest text-text-muted font-bold">
            PNSN Real-time Picker: {stationCode}
          </span>
        </div>
        <div className="flex gap-4">
          <span className="text-[10px] font-mono text-emerald-500 font-bold uppercase">100Hz • 3-Component</span>
          <span className="text-[10px] font-mono text-red-400 font-bold uppercase">AI Phase Detection</span>
        </div>
      </div>
      
      <div className="flex flex-col gap-2">
        <canvas ref={canvasRefZ} width={400} height={80} className="w-full h-20 bg-black/40 rounded-lg border border-white/5" />
        <canvas ref={canvasRefN} width={400} height={80} className="w-full h-20 bg-black/40 rounded-lg border border-white/5" />
        <canvas ref={canvasRefE} width={400} height={80} className="w-full h-20 bg-black/40 rounded-lg border border-white/5" />
      </div>

      <div className="flex flex-wrap gap-2 mt-2">
        {['Pg', 'Sg', 'Pn', 'Sn'].map(phase => (
          <div key={phase} className="flex items-center gap-2 px-2 py-1 bg-white/5 rounded border border-white/10">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-[10px] font-mono font-bold">{phase}</span>
          </div>
        ))}
      </div>
    </div>
  );
};
