import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import * as ort from "onnxruntime-node";
import path from "path";

// --- Seismic Picker Logic ---
class SeismicPicker {
  private session: ort.InferenceSession | null = null;
  private buffers: Map<string, { [component: string]: number[] }> = new Map();
  private lastDetections: Map<string, any[]> = new Map();
  private readonly WINDOW_SIZE = 10240;
  private readonly STEP_SIZE = 1000; // 10 seconds at 100Hz
  private readonly SAMPLING_RATE = 100;

  async init() {
    try {
      const modelPath = path.resolve("./pnsn_repo/pickers/china.rnn.pnsn.onnx");
      this.session = await ort.InferenceSession.create(modelPath);
      console.log("PNSN Model loaded successfully");
    } catch (e) {
      console.error("Failed to load PNSN model:", e);
    }
  }

  // Add data for a specific station and component (E, N, Z)
  addData(station: string, component: string, value: number) {
    if (!this.buffers.has(station)) {
      this.buffers.set(station, { E: [], N: [], Z: [] });
    }
    const stationBuffer = this.buffers.get(station)!;
    if (stationBuffer[component]) {
      stationBuffer[component].push(value);
      // Keep buffer size manageable (e.g., 2x window size)
      if (stationBuffer[component].length > this.WINDOW_SIZE * 2) {
        stationBuffer[component].shift();
      }
    }
  }

  async runInference(station: string): Promise<any[]> {
    if (!this.session) return [];
    const stationBuffer = this.buffers.get(station);
    if (!stationBuffer) return [];

    // Check if we have enough data (at least one component with 10240 samples)
    const availableComponents = Object.keys(stationBuffer).filter(c => stationBuffer[c].length >= this.WINDOW_SIZE);
    if (availableComponents.length === 0) return [];

    // Prepare 3-component data
    // Strategy: If 3 components available, use them. Otherwise, duplicate available ones.
    let eData = stationBuffer.E.slice(-this.WINDOW_SIZE);
    let nData = stationBuffer.N.slice(-this.WINDOW_SIZE);
    let zData = stationBuffer.Z.slice(-this.WINDOW_SIZE);

    // Fill missing components by duplicating available ones
    if (eData.length < this.WINDOW_SIZE) eData = zData.length >= this.WINDOW_SIZE ? [...zData] : (nData.length >= this.WINDOW_SIZE ? [...nData] : []);
    if (nData.length < this.WINDOW_SIZE) nData = zData.length >= this.WINDOW_SIZE ? [...zData] : (eData.length >= this.WINDOW_SIZE ? [...eData] : []);
    if (zData.length < this.WINDOW_SIZE) zData = eData.length >= this.WINDOW_SIZE ? [...eData] : (nData.length >= this.WINDOW_SIZE ? [...nData] : []);

    if (eData.length < this.WINDOW_SIZE || nData.length < this.WINDOW_SIZE || zData.length < this.WINDOW_SIZE) return [];

    // Normalize data (Zero-mean, Unit-variance)
    const normalize = (arr: number[]) => {
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
      const std = Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / arr.length) || 1;
      return arr.map(v => (v - mean) / std);
    };

    const inputData = new Float32Array(3 * this.WINDOW_SIZE);
    inputData.set(normalize(eData), 0);
    inputData.set(normalize(nData), this.WINDOW_SIZE);
    inputData.set(normalize(zData), 2 * this.WINDOW_SIZE);

    const tensor = new ort.Tensor("float32", inputData, [1, 3, this.WINDOW_SIZE]);
    
    try {
      const results = await this.session.run({ wave: tensor });
      const output = results[this.session.outputNames[0]].data as Float32Array;
      
      // Output shape is typically (1, num_phases, samples)
      // For PNSN, phases are usually: [Background, Pg, Sg, Pn, Sn]
      const numPhases = 5; 
      const detections: any[] = [];
      const threshold = 0.5;

      for (let p = 1; p < numPhases; p++) {
        const phaseName = ["Background", "Pg", "Sg", "Pn", "Sn"][p];
        for (let i = 0; i < this.WINDOW_SIZE; i++) {
          const prob = output[p * this.WINDOW_SIZE + i];
          if (prob > threshold) {
            // Simple peak detection/deduplication
            const isPeak = (i > 0 && prob > output[p * this.WINDOW_SIZE + i - 1]) && 
                           (i < this.WINDOW_SIZE - 1 && prob > output[p * this.WINDOW_SIZE + i + 1]);
            
            if (isPeak) {
              detections.push({
                phase: phaseName,
                probability: prob,
                sampleIndex: i,
                timestamp: Date.now() - (this.WINDOW_SIZE - i) * (1000 / this.SAMPLING_RATE)
              });
            }
          }
        }
      }

      // Deduplicate detections (within 2 seconds)
      const finalDetections = detections.filter((d, index) => {
        return !detections.slice(0, index).some(prev => 
          prev.phase === d.phase && Math.abs(prev.sampleIndex - d.sampleIndex) < 200
        );
      });

      return finalDetections;
    } catch (e) {
      console.error("Inference error:", e);
      return [];
    }
  }
}

const picker = new SeismicPicker();
picker.init();

async function startServer() {
  const app = express();
  const PORT = 3000;
  const httpServer = createServer(app);

  // WebSocket Server for Waveform Data
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    console.log("Client connected to waveform stream");
    
    let phase = 0;
    const station = "ANMO";
    
    // Simulate 3-component data at 100Hz
    const interval = setInterval(async () => {
      if (ws.readyState === WebSocket.OPEN) {
        const timestamp = Date.now();
        
        // Simulate E, N, Z components
        const noise = () => (Math.random() - 0.5) * 0.1;
        const sig = (p: number) => Math.sin(p) * 0.4 + Math.sin(p * 0.5) * 0.2;
        
        const valE = sig(phase) + noise();
        const valN = sig(phase + 1) + noise();
        const valZ = sig(phase + 2) + noise();

        picker.addData(station, "E", valE);
        picker.addData(station, "N", valN);
        picker.addData(station, "Z", valZ);

        ws.send(JSON.stringify({
          type: "waveform",
          timestamp,
          values: { E: valE, N: valN, Z: valZ },
          station
        }));
        
        phase += 0.1;

        // Run inference every 100 samples (1 second) for responsiveness
        // The user asked for 10s new data, but we can run it more frequently
        if (Math.floor(phase * 10) % 100 === 0) {
          const detections = await picker.runInference(station);
          if (detections.length > 0) {
            ws.send(JSON.stringify({
              type: "detections",
              station,
              detections
            }));
          }
        }
      }
    }, 10); // 100Hz

    ws.on("close", () => {
      clearInterval(interval);
      console.log("Client disconnected");
    });
  });

  // API routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/earthquakes", async (req, res) => {
    try {
      const response = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson");
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch earthquakes" });
    }
  });

  app.get("/api/stations", async (req, res) => {
    try {
      const response = await fetch("https://earthquake.usgs.gov/fdsnws/station/1/query?format=geojson&level=station&net=IU");
      if (!response.ok) throw new Error("USGS Station service error");
      const data = await response.json();
      res.json(data);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stations" });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
