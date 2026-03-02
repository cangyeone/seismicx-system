import { GoogleGenAI } from "@google/genai";

export interface Earthquake {
  id: string;
  mag: number;
  place: string;
  time: number;
  url: string;
  coordinates: [number, number, number]; // [lng, lat, depth]
  type: string;
}

export interface SeismicStation {
  code: string;
  network: string;
  latitude: number;
  longitude: number;
  elevation: number;
  siteName: string;
  status: 'active' | 'inactive' | 'maintenance';
}

class SeismicService {
  private EARTHQUAKES_API = "/api/earthquakes";
  private STATIONS_API = "/api/stations";

  async getRecentEarthquakes(): Promise<Earthquake[]> {
    try {
      const response = await fetch(this.EARTHQUAKES_API);
      if (!response.ok) throw new Error("Local API error");
      const data = await response.json();
      return data.features.map((f: any) => ({
        id: f.id,
        mag: f.properties.mag,
        place: f.properties.place,
        time: f.properties.time,
        url: f.properties.url,
        coordinates: f.geometry.coordinates,
        type: f.properties.type
      }));
    } catch (error) {
      console.error("Error fetching earthquakes:", error);
      return [];
    }
  }

  async getStations(): Promise<SeismicStation[]> {
    try {
      const response = await fetch(this.STATIONS_API);
      
      if (!response.ok) {
        throw new Error(`Station Service returned status ${response.status}`);
      }

      const data = await response.json();
      
      const stations: SeismicStation[] = [];
      if (data && data.features) {
        data.features.forEach((feature: any) => {
          const props = feature.properties;
          const coords = feature.geometry.coordinates;
          
          stations.push({
            code: props.code || "UNK",
            network: props.network || "IU",
            latitude: coords[1],
            longitude: coords[0],
            elevation: coords[2] || 0,
            siteName: props.name || "Seismic Station",
            status: Math.random() > 0.1 ? 'active' : 'inactive'
          });
        });
      }
      return stations;
    } catch (error) {
      console.error("Error fetching stations, using fallback list:", error);
      // Comprehensive fallback list of major global seismic stations (GSN - Global Seismograph Network)
      return [
        { code: 'ANMO', network: 'IU', latitude: 34.9459, longitude: -106.4572, elevation: 1850, siteName: 'Albuquerque, New Mexico, USA', status: 'active' },
        { code: 'KIP', network: 'IU', latitude: 21.4233, longitude: -158.015, elevation: 200, siteName: 'Kipapa, Oahu, Hawaii, USA', status: 'active' },
        { code: 'SJG', network: 'IU', latitude: 18.1117, longitude: -66.1501, elevation: 424, siteName: 'San Juan, Puerto Rico', status: 'active' },
        { code: 'TATO', network: 'IU', latitude: 24.975, longitude: 121.51, elevation: 200, siteName: 'Taipei, Taiwan', status: 'active' },
        { code: 'MAJO', network: 'IU', latitude: 36.54, longitude: 138.2, elevation: 400, siteName: 'Matsushiro, Japan', status: 'active' },
        { code: 'QSPA', network: 'IU', latitude: -89.92, longitude: 144.4, elevation: 2800, siteName: 'South Pole, Antarctica', status: 'active' },
        { code: 'PAB', network: 'IU', latitude: 39.54, longitude: -4.35, elevation: 900, siteName: 'San Pablo, Spain', status: 'active' },
        { code: 'CASY', network: 'IU', latitude: -66.28, longitude: 110.53, elevation: 40, siteName: 'Casey, Antarctica', status: 'active' },
        { code: 'BILL', network: 'IU', latitude: 67.67, longitude: 166.74, elevation: 300, siteName: 'Bilibino, Russia', status: 'active' },
        { code: 'KMBO', network: 'IU', latitude: -1.12, longitude: 37.25, elevation: 1600, siteName: 'Kambui, Kenya', status: 'active' }
      ];
    }
  }
}

export const seismicService = new SeismicService();
