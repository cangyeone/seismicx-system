import React, { useEffect, useRef } from 'react';
import * as d3 from 'd3';

interface AnimatedMapProps {
  earthquakes: any[];
  stations: any[];
  onSelectQuake: (quake: any) => void;
  onSelectStation: (station: any) => void;
  selectedQuakeId?: string;
  selectedStationCode?: string;
  activeTab: 'quakes' | 'stations';
  newEarthquakeAnimation?: {
    center: { lat: number; lng: number };
    magnitude: number;
  };
}

export const AnimatedSeismicMap: React.FC<AnimatedMapProps> = ({ 
  earthquakes, 
  stations, 
  onSelectQuake, 
  onSelectStation,
  selectedQuakeId, 
  selectedStationCode,
  activeTab,
  newEarthquakeAnimation
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const projectionRef = useRef<any>(null);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;

    const updateDimensions = () => {
      if (!containerRef.current || !svgRef.current) return;
      
      const width = containerRef.current.clientWidth;
      const height = containerRef.current.clientHeight;

      const svg = d3.select(svgRef.current);
      svg.selectAll("*").remove();

      const projection = d3.geoMercator()
        .scale(width / (2 * Math.PI))
        .translate([width / 2, height / 1.6]);
      
      projectionRef.current = projection;
      const path = d3.geoPath().projection(projection);

      const g = svg.append("g");

      // Load world map data
      d3.json("https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson").then((data: any) => {
        // Draw land
        g.append("g")
          .selectAll("path")
          .data(data.features)
          .enter()
          .append("path")
          .attr("d", path)
          .attr("fill", "#1a1a1a")
          .attr("stroke", "#333")
          .attr("stroke-width", 0.5);

        // Draw stations
        const stationGroup = g.append("g")
          .selectAll("circle")
          .data(stations)
          .enter()
          .append("circle")
          .attr("cx", d => projection([d.longitude, d.latitude])![0])
          .attr("cy", d => projection([d.longitude, d.latitude])![1])
          .attr("r", d => activeTab === 'stations' ? (d.code === selectedStationCode ? 5 : 3) : 1.5)
          .attr("fill", d => d.status === 'active' ? '#10b981' : '#ef4444')
          .attr("opacity", d => activeTab === 'stations' ? 1 : 0.4)
          .attr("stroke", d => d.code === selectedStationCode ? "#fff" : "none")
          .attr("stroke-width", 1)
          .attr("class", "cursor-pointer transition-all duration-300")
          .on("click", (event, d) => onSelectStation(d));

        // Draw earthquakes with enhanced styling
        const quakes = g.append("g")
          .selectAll("g")
          .data(earthquakes)
          .enter()
          .append("g")
          .attr("class", "quake-marker")
          .attr("opacity", activeTab === 'quakes' ? 1 : 0.2)
          .on("click", (event, d) => onSelectQuake(d));

        // Main earthquake circle
        quakes.append("circle")
          .attr("cx", d => projection([d.coordinates[0], d.coordinates[1]])![0])
          .attr("cy", d => projection([d.coordinates[0], d.coordinates[1]])![1])
          .attr("r", d => Math.max(2, d.mag * 2.5))
          .attr("fill", d => d.mag > 5 ? "#ef4444" : d.mag > 3 ? "#f97316" : "#eab308")
          .attr("fill-opacity", 0.4)
          .attr("stroke", d => d.mag > 5 ? "#ef4444" : d.mag > 3 ? "#f97316" : "#eab308")
          .attr("stroke-width", 1)
          .attr("class", "transition-all duration-300");

        // Pulse effect for significant earthquakes
        quakes.filter(d => d.mag > 4.5 && activeTab === 'quakes')
          .append("circle")
          .attr("cx", d => projection([d.coordinates[0], d.coordinates[1]])![0])
          .attr("cy", d => projection([d.coordinates[0], d.coordinates[1]])![1])
          .attr("r", d => d.mag * 5)
          .attr("fill", "none")
          .attr("stroke", "#ef4444")
          .attr("stroke-width", 1)
          .attr("class", "quake-pulse animate-pulse");

        // Add earthquake labels for large events
        quakes.filter(d => d.mag > 6)
          .append("text")
          .attr("x", d => projection([d.coordinates[0], d.coordinates[1]])![0])
          .attr("y", d => projection([d.coordinates[0], d.coordinates[1]])![1] - 20)
          .attr("text-anchor", "middle")
          .attr("fill", "#fff")
          .attr("font-size", "10px")
          .attr("font-family", "monospace")
          .text(d => `M${d.mag.toFixed(1)}`)
          .attr("opacity", 0.8);
      });

      // Zoom behavior
      const zoom = d3.zoom<SVGSVGElement, unknown>()
        .scaleExtent([1, 8])
        .on("zoom", (event) => {
          g.attr("transform", event.transform);
        });

      svg.call(zoom);
    };

    const resizeObserver = new ResizeObserver(() => {
      updateDimensions();
    });

    resizeObserver.observe(containerRef.current);
    updateDimensions();

    return () => resizeObserver.disconnect();
  }, [earthquakes, stations, onSelectQuake, onSelectStation, activeTab, selectedStationCode]);

  // Handle new earthquake animation
  useEffect(() => {
    if (newEarthquakeAnimation && projectionRef.current) {
      const svg = d3.select(svgRef.current);
      const projection = projectionRef.current;
      
      const { center, magnitude } = newEarthquakeAnimation;
      const [x, y] = projection([center.lng, center.lat]) || [0, 0];

      // Create explosion animation group
      const explosionGroup = svg.append("g")
        .attr("transform", `translate(${x}, ${y})`);

      // Center point
      explosionGroup.append("circle")
        .attr("r", 3)
        .attr("fill", "#ef4444")
        .attr("stroke", "#fff")
        .attr("stroke-width", 2);

      // Explosion rings
      const rings = [magnitude * 10, magnitude * 20, magnitude * 30];
      
      rings.forEach((radius, i) => {
        explosionGroup.append("circle")
          .attr("r", 0)
          .attr("fill", "none")
          .attr("stroke", i === 0 ? "#ef4444" : i === 1 ? "#f97316" : "#eab308")
          .attr("stroke-width", 2)
          .attr("opacity", 0.8)
          .transition()
          .duration(2000)
          .attr("r", radius)
          .attr("opacity", 0)
          .remove();
      });

      // Ripple effect
      explosionGroup.append("circle")
        .attr("r", 0)
        .attr("fill", "none")
        .attr("stroke", "#3b82f6")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "5,5")
        .transition()
        .duration(3000)
        .attr("r", magnitude * 50)
        .attr("opacity", 0)
        .remove();

      // Auto-center map to new earthquake after delay
      setTimeout(() => {
        if (svg.node()) {
          const zoom = d3.zoom<SVGSVGElement, unknown>();
          const svgNode = svg.node()!;
          const bounds: [number, number, number, number] = [
            center.lng - 5,
            center.lat - 3,
            center.lng + 5,
            center.lat + 3
          ];
          
          // This would require implementing proper bounds calculation
          // For now, we'll just log the intention
          console.log("Would center map to:", center);
        }
      }, 1000);

      // Clean up after animation
      setTimeout(() => {
        explosionGroup.remove();
      }, 3000);
    }
  }, [newEarthquakeAnimation]);

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden bg-bg">
      <svg ref={svgRef} className="w-full h-full cursor-grab active:cursor-grabbing" />
      <div className="absolute bottom-4 left-4 flex flex-col gap-2 bg-black/60 backdrop-blur-md p-3 rounded-lg border border-white/10 text-[10px] font-mono uppercase tracking-wider">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-emerald-500" />
          <span>Active Station</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-red-500" />
          <span>Inactive Station</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-orange-500 opacity-50" />
          <span>Earthquake (Size ∝ Mag)</span>
        </div>
        {newEarthquakeAnimation && (
          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/20">
            <div className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
            <span className="text-red-400">NEW EVENT</span>
          </div>
        )}
      </div>
    </div>
  );
};