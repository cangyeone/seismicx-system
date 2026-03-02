import React, { useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Activity, 
  Radio, 
  Map as MapIcon, 
  AlertTriangle, 
  RefreshCw, 
  Info,
  ChevronRight,
  Globe,
  Database
} from 'lucide-react';
import { format } from 'date-fns';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { seismicService, Earthquake, SeismicStation } from './services/seismicService';
import { SeismicMap } from './components/SeismicMap';
import { WaveformDisplay } from './components/WaveformDisplay';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [earthquakes, setEarthquakes] = useState<Earthquake[]>([]);
  const [stations, setStations] = useState<SeismicStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date>(new Date());
  const [selectedQuake, setSelectedQuake] = useState<Earthquake | null>(null);
  const [selectedStation, setSelectedStation] = useState<SeismicStation | null>(null);
  const [activeTab, setActiveTab] = useState<'quakes' | 'stations'>('quakes');

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [quakesData, stationsData] = await Promise.all([
        seismicService.getRecentEarthquakes(),
        seismicService.getStations()
      ]);
      setEarthquakes(quakesData.sort((a, b) => b.time - a.time));
      setStations(stationsData);
      setLastUpdate(new Date());
    } catch (error) {
      console.error("Failed to fetch seismic data", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, 60000); // Update every minute
    return () => clearInterval(interval);
  }, [fetchData]);

  const significantQuakes = earthquakes.filter(q => q.mag >= 4.5);
  const activeStations = stations.filter(s => s.status === 'active');

  return (
    <div className="h-screen bg-bg text-white selection:bg-accent/30 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-20 border-b border-border flex items-center justify-between px-8 bg-card/50 backdrop-blur-xl sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-accent rounded-xl flex items-center justify-center shadow-lg shadow-accent/20">
            <Activity className="w-8 h-8 text-white" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight uppercase">SystemX <span className="text-accent">GLOBAL</span></h1>
            <p className="text-xs text-text-muted font-mono uppercase tracking-[0.2em]">由yuziye@cea-igp.ac.cn开发完成</p>
          </div>
        </div>

        <div className="flex items-center gap-8">
          <div className="hidden md:flex items-center gap-6 text-sm font-mono">
            <div className="flex flex-col items-end">
              <span className="text-text-muted uppercase text-[10px]">Last Sync</span>
              <span className="font-bold">{format(lastUpdate, 'HH:mm:ss')} UTC</span>
            </div>
            <div className="w-px h-10 bg-border" />
            <div className="flex flex-col items-end">
              <span className="text-text-muted uppercase text-[10px]">Active Nodes</span>
              <span className="text-emerald-500 font-bold">{activeStations.length} / {stations.length}</span>
            </div>
          </div>
          <button 
            onClick={fetchData}
            disabled={loading}
            className="p-3 hover:bg-white/5 rounded-full transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-6 h-6", loading && "animate-spin")} />
          </button>
        </div>
      </header>

      <main className="flex-1 flex flex-col lg:flex-row overflow-hidden p-0 gap-0 h-full">
        {/* Sidebar / List View */}
        <aside className="w-full lg:w-[480px] flex flex-col shrink-0 h-full border-r border-border bg-card/30 overflow-hidden">
          <div className="p-6 flex flex-col gap-6 h-full overflow-hidden">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-card border border-border p-5 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <AlertTriangle className="w-5 h-5 text-orange-500" />
                  <span className="text-xs font-mono text-text-muted uppercase font-bold">Significant</span>
                </div>
                <div className="text-4xl font-bold font-mono">{significantQuakes.length}</div>
                <div className="text-xs text-text-muted mt-2">Quakes &gt; 4.5 Mag (1h)</div>
              </div>
              <div className="bg-card border border-border p-5 rounded-2xl shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <Radio className="w-5 h-5 text-emerald-500" />
                  <span className="text-xs font-mono text-text-muted uppercase font-bold">Network</span>
                </div>
                <div className="text-4xl font-bold font-mono">{Math.round((activeStations.length / (stations.length || 1)) * 100)}%</div>
                <div className="text-xs text-text-muted mt-2">Global Station Uptime</div>
              </div>
            </div>

            {/* Waveform Display (Conditional) */}
            {activeTab === 'stations' && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="overflow-hidden shrink-0"
              >
                {selectedStation ? (
                  <>
                    <WaveformDisplay stationCode={`${selectedStation.network}.${selectedStation.code}`} />
                    <button 
                      onClick={() => setSelectedStation(null)}
                      className="w-full mt-2 text-[10px] text-text-muted hover:text-white uppercase font-mono py-1 border border-border rounded hover:bg-white/5 transition-all"
                    >
                      Close Stream
                    </button>
                  </>
                ) : (
                  <div className="bg-card border border-dashed border-border rounded-xl p-6 text-center">
                    <Radio className="w-8 h-8 text-text-muted mx-auto mb-3 opacity-20" />
                    <p className="text-[11px] text-text-muted uppercase tracking-wider">Select a station to view live waveform</p>
                  </div>
                )}
              </motion.div>
            )}

            {/* Tabs */}
            <div className="flex-1 bg-card border border-border rounded-2xl flex flex-col overflow-hidden shadow-lg">
              <div className="flex border-b border-border bg-white/5">
                <button 
                  onClick={() => setActiveTab('quakes')}
                  className={cn(
                    "flex-1 py-4 text-sm font-bold uppercase tracking-widest transition-all border-b-2",
                    activeTab === 'quakes' ? "border-accent text-white bg-accent/5" : "border-transparent text-text-muted hover:text-white"
                  )}
                >
                  Recent Events
                </button>
                <button 
                  onClick={() => setActiveTab('stations')}
                  className={cn(
                    "flex-1 py-4 text-sm font-bold uppercase tracking-widest transition-all border-b-2",
                    activeTab === 'stations' ? "border-accent text-white bg-accent/5" : "border-transparent text-text-muted hover:text-white"
                  )}
                >
                  Stations
                </button>
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar">
                <AnimatePresence mode="wait">
                  {activeTab === 'quakes' ? (
                    <motion.div 
                      key="quakes"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="divide-y divide-border"
                    >
                      {earthquakes.length === 0 && !loading && (
                        <div className="p-12 text-center text-text-muted text-base italic">No recent seismic events detected.</div>
                      )}
                      {earthquakes.map((quake) => (
                        <button
                          key={quake.id}
                          onClick={() => setSelectedQuake(quake)}
                          className={cn(
                            "w-full p-5 text-left hover:bg-white/5 transition-colors flex items-center gap-4 group",
                            selectedQuake?.id === quake.id && "bg-accent/10 border-l-4 border-l-accent"
                          )}
                        >
                          <div className={cn(
                            "w-14 h-14 shrink-0 rounded-xl flex flex-col items-center justify-center font-mono font-black text-lg shadow-inner",
                            quake.mag >= 5 ? "bg-red-500/20 text-red-500" : 
                            quake.mag >= 3 ? "bg-orange-500/20 text-orange-500" : 
                            "bg-yellow-500/20 text-yellow-500"
                          )}>
                            {quake.mag.toFixed(1)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <h3 className="text-sm font-bold truncate group-hover:text-accent transition-colors mb-1">{quake.place}</h3>
                            <p className="text-xs text-text-muted font-mono flex items-center gap-2">
                              <span className="text-accent/60">{format(quake.time, 'HH:mm:ss')}</span>
                              <span className="w-1 h-1 rounded-full bg-border" />
                              <span>{quake.coordinates[2].toFixed(1)}km depth</span>
                            </p>
                          </div>
                          <ChevronRight className="w-5 h-5 text-text-muted group-hover:text-white transition-colors" />
                        </button>
                      ))}
                    </motion.div>
                  ) : (
                    <motion.div 
                      key="stations"
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 10 }}
                      className="divide-y divide-border"
                    >
                      {stations.map((station) => (
                        <button 
                          key={`${station.network}-${station.code}`} 
                          onClick={() => setSelectedStation(station)}
                          className={cn(
                            "w-full p-5 flex items-center justify-between hover:bg-white/5 transition-colors text-left",
                            selectedStation?.code === station.code && "bg-accent/10 border-l-4 border-l-accent"
                          )}
                        >
                          <div className="flex items-center gap-4">
                            <div className={cn(
                              "w-3 h-3 rounded-full",
                              station.status === 'active' ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.6)]" : "bg-red-500"
                            )} />
                            <div>
                              <h3 className="text-sm font-bold font-mono tracking-tight">{station.network}.{station.code}</h3>
                              <p className="text-xs text-text-muted truncate max-w-[240px] mt-0.5">{station.siteName}</p>
                            </div>
                          </div>
                          <div className="text-xs font-mono text-text-muted text-right opacity-60">
                            {station.latitude.toFixed(2)}°, {station.longitude.toFixed(2)}°
                          </div>
                        </button>
                      ))}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </aside>

        {/* Map Area */}
        <section className="flex-1 flex flex-col min-h-0 relative h-full">
          <div className="flex-1 relative min-h-0 overflow-hidden">
            <div className="absolute inset-0">
              <SeismicMap 
                earthquakes={earthquakes} 
                stations={stations} 
                onSelectQuake={setSelectedQuake}
                onSelectStation={setSelectedStation}
                selectedQuakeId={selectedQuake?.id}
                selectedStationCode={selectedStation?.code}
                activeTab={activeTab}
              />
            </div>
            
            {/* Overlay Info */}
            {selectedQuake && activeTab === 'quakes' && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className="absolute top-6 right-6 w-80 bg-card/95 backdrop-blur-2xl border border-border rounded-2xl p-6 shadow-2xl z-20"
              >
                <div className="flex items-center justify-between mb-5">
                  <span className="text-xs font-mono text-text-muted uppercase tracking-widest font-bold">Event Detail</span>
                  <button onClick={() => setSelectedQuake(null)} className="p-1 hover:bg-white/10 rounded-full transition-colors">✕</button>
                </div>
                <div className="flex items-center gap-5 mb-6">
                  <div className={cn(
                    "text-5xl font-black font-mono tracking-tighter",
                    selectedQuake.mag >= 5 ? "text-red-500" : "text-orange-500"
                  )}>
                    {selectedQuake.mag.toFixed(1)}
                  </div>
                  <div>
                    <h2 className="text-base font-bold leading-tight mb-1">{selectedQuake.place}</h2>
                    <p className="text-xs text-text-muted font-mono">{format(selectedQuake.time, 'MMM d, HH:mm:ss')} UTC</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="bg-white/5 p-3 rounded-xl border border-white/5">
                    <span className="block text-[10px] text-text-muted uppercase font-mono mb-1">Depth</span>
                    <span className="text-sm font-bold">{selectedQuake.coordinates[2].toFixed(1)} km</span>
                  </div>
                  <div className="bg-white/5 p-3 rounded-xl border border-white/5">
                    <span className="block text-[10px] text-text-muted uppercase font-mono mb-1">Type</span>
                    <span className="text-sm font-bold capitalize">{selectedQuake.type}</span>
                  </div>
                </div>
                <a 
                  href={selectedQuake.url} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="w-full py-3 bg-accent hover:bg-accent/80 text-white text-xs font-bold uppercase tracking-widest rounded-xl flex items-center justify-center gap-3 transition-all shadow-lg shadow-accent/20"
                >
                  <Database className="w-4 h-4" />
                  View USGS Data
                </a>
              </motion.div>
            )}

            {/* Station Info Overlay */}
            {selectedStation && activeTab === 'stations' && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                className="absolute top-6 right-6 w-80 bg-card/95 backdrop-blur-2xl border border-border rounded-2xl p-6 shadow-2xl z-20"
              >
                <div className="flex items-center justify-between mb-5">
                  <span className="text-xs font-mono text-text-muted uppercase tracking-widest font-bold">Station Detail</span>
                  <button onClick={() => setSelectedStation(null)} className="p-1 hover:bg-white/10 rounded-full transition-colors">✕</button>
                </div>
                <div className="flex items-center gap-4 mb-6">
                  <div className={cn(
                    "w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg",
                    selectedStation.status === 'active' ? "bg-emerald-500/20 text-emerald-500 shadow-emerald-500/10" : "bg-red-500/20 text-red-500 shadow-red-500/10"
                  )}>
                    <Radio className="w-7 h-7" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold leading-tight mb-1">{selectedStation.network}.{selectedStation.code}</h2>
                    <p className="text-xs text-text-muted font-mono font-bold tracking-widest">{selectedStation.status.toUpperCase()}</p>
                  </div>
                </div>
                <div className="space-y-3 mb-6">
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Location</span>
                    <span className="font-medium text-right ml-4">{selectedStation.siteName}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Coordinates</span>
                    <span className="font-mono">{selectedStation.latitude.toFixed(3)}, {selectedStation.longitude.toFixed(3)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-text-muted">Elevation</span>
                    <span className="font-mono">{selectedStation.elevation}m</span>
                  </div>
                </div>
                <div className="p-4 bg-emerald-500/5 border border-emerald-500/20 rounded-xl text-xs text-emerald-500 leading-relaxed font-medium">
                  Live waveform stream is active in the sidebar.
                </div>
              </motion.div>
            )}
          </div>

          {/* Bottom Info Bar */}
          <div className="h-16 bg-card border border-border rounded-2xl flex items-center px-6 justify-between text-xs font-mono text-text-muted shadow-sm">
            <div className="flex items-center gap-8">
              <div className="flex items-center gap-3">
                <Globe className="w-4 h-4 text-accent" />
                <span>Global Coverage: 100%</span>
              </div>
              <div className="flex items-center gap-3">
                <Database className="w-4 h-4 text-accent" />
                <span>Source: USGS Earthquake Hazards Program</span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
              <span className="font-bold text-emerald-500/80">Live Stream Connected</span>
            </div>
          </div>
        </section>
      </main>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #262626;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #404040;
        }
      `}</style>
    </div>
  );
}
