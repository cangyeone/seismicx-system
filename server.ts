import express from "express";
import { createServer as createViteServer } from "vite";
import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import * as ort from "onnxruntime-node";
import path from "path";
import { EarthquakeDAO } from "./src/database/earthquakeDAO";
import { StationDAO } from "./src/database/stationDAO";

// --- Database Initialization ---
console.log("Initializing database...");
try {
  // Import database initialization
  await import("./src/database/init");
  console.log("Database initialized successfully");
} catch (error) {
  console.error("Database initialization failed:", error);
}

// --- Real-time Data Sync Functions ---

// 定期从USGS获取最新地震数据
async function syncEarthquakeData() {
  try {
    const response = await fetch("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson");
    const data = await response.json();
    
    const newEarthquakes = [];
    for (const feature of data.features) {
      const earthquake = {
        id: feature.id,
        time: feature.properties.time,
        latitude: feature.geometry.coordinates[1],
        longitude: feature.geometry.coordinates[0],
        depth: feature.geometry.coordinates[2],
        mag: feature.properties.mag,
        magType: feature.properties.magType,
        place: feature.properties.place,
        updated: feature.properties.updated,
        tz: feature.properties.tz,
        url: feature.properties.url,
        detail: feature.properties.detail,
        felt: feature.properties.felt,
        cdi: feature.properties.cdi,
        mmi: feature.properties.mmi,
        alert: feature.properties.alert,
        status: feature.properties.status,
        tsunami: feature.properties.tsunami,
        sig: feature.properties.sig,
        net: feature.properties.net,
        code: feature.properties.code,
        ids: feature.properties.ids,
        sources: feature.properties.sources,
        types: feature.properties.types,
        nst: feature.properties.nst,
        dmin: feature.properties.dmin,
        rms: feature.properties.rms,
        gap: feature.properties.gap,
        magSource: feature.properties.magSource,
        type: feature.properties.type,
        title: feature.properties.title
      };
      
      EarthquakeDAO.upsertEarthquake(earthquake);
      newEarthquakes.push(earthquake);
    }
    
    console.log(`Synced ${newEarthquakes.length} new earthquakes`);
    return newEarthquakes;
  } catch (error) {
    console.error("Failed to sync earthquake data:", error);
    return [];
  }
}

// 定期获取台站数据
async function syncStationData() {
  try {
    // 使用正确的USGS台站API端点
    const networks = ['IU', 'US', 'MN']; // 主要地震台网
    let allStations: any[] = [];
    
    for (const network of networks) {
      try {
        const response = await fetch(`https://earthquake.usgs.gov/fdsnws/station/1/query?format=geojson&level=station&net=${network}`);
        if (response.ok) {
          const data = await response.json();
          allStations = allStations.concat(data.features || []);
          console.log(`Synced ${data.features?.length || 0} stations from network ${network}`);
        }
      } catch (netError) {
        console.log(`Failed to sync network ${network}:`, netError);
      }
    }
    
    if (allStations.length === 0) {
      // 如果API失败，使用备用数据源或模拟数据
      console.log("Using simulated station data");
      allStations = [
        {
          properties: {
            network: "SIM",
            station: "ANMO",
            site_name: "Albuquerque, New Mexico",
            start_date: null,
            end_date: null,
            channels: []
          },
          geometry: {
            coordinates: [-106.4572, 34.9459, 1850]
          }
        },
        {
          properties: {
            network: "SIM", 
            station: "BFO",
            site_name: "Black Forest Observatory, Germany",
            start_date: null,
            end_date: null,
            channels: []
          },
          geometry: {
            coordinates: [8.3300, 48.3300, 750]
          }
        }
      ];
    }
    
    const stations = [];
    for (const feature of allStations) {
      const station = {
        id: `${feature.properties.network || 'SIM'}.${feature.properties.station || 'UNK'}`,
        network: feature.properties.network || 'SIM',
        name: feature.properties.station || 'Unknown',
        latitude: feature.geometry.coordinates[1],
        longitude: feature.geometry.coordinates[0],
        elevation: feature.geometry.coordinates[2],
        site_name: feature.properties.site_name || 'Unknown Location',
        start_date: feature.properties.start_date ? new Date(feature.properties.start_date).getTime() : null,
        end_date: feature.properties.end_date ? new Date(feature.properties.end_date).getTime() : null,
        channels: JSON.stringify(feature.properties.channels || [])
      };
      
      stations.push(station);
    }
    
    StationDAO.upsertStations(stations);
    console.log(`Synced ${stations.length} total stations`);
    return stations;
  } catch (error) {
    console.error("Failed to sync station data:", error);
    return [];
  }
}

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
      // Try multiple model paths
      const modelPaths = [
        "./pnsn_repo/pickers/china.rnn.pnsn.onnx",
        "./pnsn_repo/pickers/rnn.onnx",
        "./pnsn_repo/pickers/pnsn.v1.onnx"
      ];
      
      for (const modelPath of modelPaths) {
        try {
          const fullPath = path.resolve(modelPath);
          this.session = await ort.InferenceSession.create(fullPath);
          console.log(`Model loaded successfully from: ${modelPath}`);
          break;
        } catch (e) {
          console.log(`Failed to load model from ${modelPath}:`, (e as Error).message);
          continue;
        }
      }
      
      if (!this.session) {
        console.log("No models loaded, running in simulation mode");
      }
    } catch (e) {
      console.error("Failed to load any model:", e);
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

// 存储连接的客户端
const connectedClients = new Set<WebSocket>();

async function startServer() {
  const app = express();
  const PORT = 3000;
  const httpServer = createServer(app);

  // WebSocket Server for Waveform Data
  const wss = new WebSocketServer({ server: httpServer });

  wss.on("connection", (ws) => {
    console.log("Client connected to waveform stream");
    connectedClients.add(ws);
    
    let phase = 0;
    const station = "ANMO";
    
    // 发送初始数据
    const initialEarthquakes = EarthquakeDAO.getLatestEarthquakes(20);
    const stations = StationDAO.getAllStations();
    
    ws.send(JSON.stringify({
      type: "initial_data",
      earthquakes: initialEarthquakes,
      stations: stations
    }));
    
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
      connectedClients.delete(ws);
      console.log("Client disconnected");
    });
  });

  // 定期同步数据到所有客户端
  setInterval(async () => {
    const newEarthquakes = await syncEarthquakeData();
    const stations = await syncStationData();
    
    // 广播新数据给所有连接的客户端
    if (newEarthquakes.length > 0) {
      const message = JSON.stringify({
        type: "new_earthquakes",
        earthquakes: newEarthquakes,
        animation: {
          center: {
            lat: newEarthquakes[0].latitude,
            lng: newEarthquakes[0].longitude
          },
          magnitude: newEarthquakes[0].mag
        }
      });
      
      connectedClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  }, 60000); // 每分钟同步一次

  // API routes
  app.get("/api/health", (req, res) => {
    const dbStats = EarthquakeDAO.getStatistics();
    res.json({ 
      status: "ok", 
      timestamp: Date.now(),
      database: dbStats
    });
  });

  app.get("/api/earthquakes", async (req, res) => {
    try {
      const { hours = '24', limit = '50' } = req.query;
      const earthquakes = EarthquakeDAO.getRecentEarthquakes(parseInt(hours as string));
      res.json({
        features: earthquakes.slice(0, parseInt(limit as string)).map(eq => ({
          type: "Feature",
          id: eq.id,
          properties: {
            mag: eq.mag,
            place: eq.place,
            time: eq.time,
            updated: eq.updated,
            tz: eq.tz,
            url: eq.url,
            detail: eq.detail,
            felt: eq.felt,
            cdi: eq.cdi,
            mmi: eq.mmi,
            alert: eq.alert,
            status: eq.status,
            tsunami: eq.tsunami,
            sig: eq.sig,
            net: eq.net,
            code: eq.code,
            ids: eq.ids,
            sources: eq.sources,
            types: eq.types,
            nst: eq.nst,
            dmin: eq.dmin,
            rms: eq.rms,
            gap: eq.gap,
            magType: eq.magType,
            type: eq.type,
            title: eq.title
          },
          geometry: {
            type: "Point",
            coordinates: [eq.longitude, eq.latitude, eq.depth || 0]
          }
        })),
        metadata: {
          generated: Date.now(),
          url: req.originalUrl,
          title: "USGS Earthquakes",
          status: 200,
          api: "1.0",
          count: earthquakes.length
        }
      });
    } catch (error) {
      console.error("Earthquake API error:", error);
      res.status(500).json({ error: "Failed to fetch earthquakes" });
    }
  });

  app.get("/api/stations", async (req, res) => {
    try {
      // 支持手动同步参数
      if (req.query.sync === 'true') {
        await syncStationData();
      }
      
      const stations = StationDAO.getAllStations();
      res.json({
        features: stations.map(station => ({
          type: "Feature",
          id: station.id,
          properties: {
            network: station.network,
            station: station.name,
            name: station.name,
            site_name: station.site_name,
            start_date: station.start_date,
            end_date: station.end_date,
            channels: JSON.parse(station.channels || '[]')
          },
          geometry: {
            type: "Point",
            coordinates: [station.longitude, station.latitude, station.elevation || 0]
          }
        })),
        metadata: {
          generated: Date.now(),
          count: stations.length
        }
      });
    } catch (error) {
      console.error("Station API error:", error);
      res.status(500).json({ error: "Failed to fetch stations" });
    }
  });

  app.get("/api/stations/:network", async (req, res) => {
    try {
      const { network } = req.params;
      const stations = StationDAO.getStationsByNetwork(network);
      res.json(stations);
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch stations by network" });
    }
  });

  app.get("/api/stats", async (req, res) => {
    try {
      const earthquakeStats = EarthquakeDAO.getStatistics();
      const stationStats = StationDAO.getStatistics();
      
      res.json({
        earthquakes: earthquakeStats,
        stations: stationStats,
        timestamp: Date.now()
      });
    } catch (error) {
      res.status(500).json({ error: "Failed to fetch statistics" });
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
