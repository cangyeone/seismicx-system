import {
  Viewer,
  UrlTemplateImageryProvider,
  WebMercatorTilingScheme,
  ImageryLayer,
  Color,
  Cartesian3,
  HeadingPitchRange,
  Math as CMath,
  EllipsoidTerrainProvider,
  Cartographic,
  PolylineGlowMaterialProperty,
  ConstantPositionProperty,
  EllipsoidalOccluder,
  Credit,
  Entity,
  Matrix4,
  CreditDisplay,
} from "cesium";
import type { Quake, Station } from "../types";
import type { MapSurface } from "../broadcastState";
import type { MapCamera } from "./mapCamera";
import { OpenTerrain } from "./openTerrain";
import "cesium/Build/Cesium/Widgets/widgets.css";

export interface MapReadiness {
  terrainLevel: number;
  terrainError: boolean;
  imageryReady: boolean;
  imageryError: boolean;
  refining: boolean;
}
const amber = Color.fromCssColorString("#ffc879"),
  cyan = Color.fromCssColorString("#66e6d4");
CreditDisplay.cesiumCredit = new Credit("CesiumJS", true);
export class GlobeEngine {
  readonly viewer: Viewer;
  private terrain: OpenTerrain;
  private disposed = false;
  private state: MapReadiness = {
    terrainLevel: -1,
    terrainError: false,
    imageryReady: false,
    imageryError: false,
    refining: true,
  };
  private markerKey = "";
  private imagery?: ImageryLayer;
  private surface?: MapSurface;
  private markers: { entity: Entity; longitude: number; latitude: number }[] =
    [];
  private selected: Quake | null = null;
  private groundDirty = true;
  private occluder: EllipsoidalOccluder;
  private sourceAbort = new AbortController();
  private lastPose = "";
  private center?: [number, number];
  private renderFailed = false;
  private terrainTimer?: ReturnType<typeof setTimeout>;
  private contextLost = () => {
    this.renderFailed = true;
  };
  constructor(
    container: HTMLElement,
    creditContainer: HTMLElement,
    readonly inset: boolean,
    private report: (state: MapReadiness) => void,
    private marker: HTMLElement,
  ) {
    const mobile = matchMedia("(max-width: 900px), (pointer: coarse)").matches;
    const viewer = (this.viewer = new Viewer(container, {
      baseLayer: false,
      terrainProvider: new EllipsoidTerrainProvider(),
      animation: false,
      timeline: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      skyBox: false,
      skyAtmosphere: inset ? false : undefined,
      scene3DOnly: true,
      useDefaultRenderLoop: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      creditContainer,
      contextOptions: {
        webgl: {
          alpha: true,
          antialias: !mobile,
          powerPreference: "low-power",
        },
      },
      showRenderLoopErrors: false,
    }));
    this.occluder = new EllipsoidalOccluder(
      viewer.scene.globe.ellipsoid,
      viewer.camera.positionWC,
    );
    viewer.resolutionScale = inset
      ? 1
      : Math.min(devicePixelRatio || 1, mobile ? 1.25 : 1.5);
    viewer.scene.backgroundColor = Color.TRANSPARENT;
    viewer.scene.globe.baseColor = Color.fromCssColorString("#123449");
    viewer.scene.globe.enableLighting = false;
    viewer.scene.globe.maximumScreenSpaceError = inset ? 5 : mobile ? 5 : 3;
    viewer.scene.globe.tileCacheSize = inset ? 48 : mobile ? 80 : 128;
    viewer.scene.globe.preloadSiblings = false;
    viewer.scene.globe.preloadAncestors = true;
    viewer.scene.globe.depthTestAgainstTerrain = true;
    viewer.scene.verticalExaggeration = 2;
    viewer.scene.fog.density = 0.00008;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    viewer.scene.postProcessStages.fxaa.enabled = !mobile;
    viewer.scene.renderError.addEventListener(() => {
      this.renderFailed = true;
    });
    viewer.canvas.addEventListener("webglcontextlost", this.contextLost);
    // Web Mercator excludes the poles. Close the globe with explicitly untextured
    // ellipsoid caps, rather than pretending to have polar DEM/imagery coverage.
    for (const latitude of [-90, 90])
      viewer.entities.add({
        position: Cartesian3.fromDegrees(0, latitude),
        ellipse: {
          semiMajorAxis: 560000,
          semiMinorAxis: 560000,
          height: -250,
          material: Color.fromCssColorString("#b4cbd3"),
        },
      });
    this.terrain = new OpenTerrain((level, error) => {
      if (this.disposed) return;
      this.groundDirty = true;
      this.state.terrainError = error;
      if (!error)
        this.state.terrainLevel = Math.max(level, this.state.terrainLevel);
      this.report({ ...this.state });
      viewer.scene.requestRender();
    });
    // Start with an ellipsoid until an actual DEM tile is available.
    const attachTerrain = () => {
      if (this.disposed) return;
      const tile = this.terrain.requestTileGeometry(0, 0, 0);
      if (!tile) {
        this.terrainTimer = setTimeout(attachTerrain, 500);
        return;
      }
      tile
        .then(() => {
          if (!this.disposed) {
            viewer.terrainProvider = this.terrain;
            viewer.scene.requestRender();
          }
        })
        .catch(() => {
          if (!this.disposed)
            this.terrainTimer = setTimeout(attachTerrain, 30000);
        });
    };
    attachTerrain();
    this.setSurface(inset ? "relief" : "satellite");
    if (!inset) void this.addPlates();
  }
  private async addPlates() {
    try {
      const response = await fetch("/plates.geojson", {
        signal: this.sourceAbort.signal,
      });
      if (!response.ok) return;
      const geo = await response.json();
      if (this.disposed) return;
      for (const feature of geo.features || []) {
        const g = feature.geometry;
        const lines =
          g.type === "MultiLineString"
            ? g.coordinates
            : g.type === "LineString"
              ? [g.coordinates]
              : [];
        for (const line of lines)
          this.viewer.entities.add({
            polyline: {
              positions: Cartesian3.fromDegreesArray(
                line.flatMap((p: number[]) => p.slice(0, 2)),
              ),
              width: 1,
              material: cyan.withAlpha(0.28),
              clampToGround: true,
            },
          });
      }
      this.viewer.scene.requestRender();
    } catch {
      /* Plate outlines are optional. */
    }
  }
  setSurface(surface: MapSurface) {
    if (this.surface === surface) return;
    this.surface = surface;
    this.state.imageryReady = false;
    this.state.imageryError = false;
    const old = this.imagery;
    const provider = new UrlTemplateImageryProvider({
      url: `/api/map/tiles/${surface}/{z}/{x}/{y}`,
      tilingScheme: new WebMercatorTilingScheme(),
      maximumLevel: surface === "satellite" ? 8 : 12,
      credit: new Credit(
        '<a href="https://earthdata.nasa.gov/gibs" target="_blank">NASA GIBS</a>',
        true,
      ),
    });
    const layer = this.viewer.imageryLayers.addImageryProvider(provider);
    this.imagery = layer;
    layer.brightness = surface === "satellite" ? 1.16 : 0.92;
    layer.contrast = 1.12;
    layer.saturation = surface === "satellite" ? 0.84 : 0.7;
    provider.errorEvent.addEventListener(() => {
      if (this.disposed || this.imagery !== layer) return;
      this.state.imageryError = true;
      this.report({ ...this.state });
    });
    const requestImage = provider.requestImage.bind(provider);
    provider.requestImage = (x, y, level, request) => {
      const result = requestImage(x, y, level, request);
      return result?.then((image) => {
        if (!this.disposed && this.imagery === layer) {
          if (!this.state.imageryReady) {
            this.state.imageryReady = true;
            this.state.imageryError = false;
            this.report({ ...this.state });
            if (old && this.viewer.imageryLayers.contains(old))
              this.viewer.imageryLayers.remove(old);
          }
          this.viewer.scene.requestRender();
        }
        return image;
      });
    };
    for (let i = this.viewer.imageryLayers.length - 1; i >= 0; i--) {
      const item = this.viewer.imageryLayers.get(i);
      if (item !== layer && item !== old)
        this.viewer.imageryLayers.remove(item);
    }
    this.report({ ...this.state });
    this.viewer.scene.requestRender();
  }
  private groundPosition(longitude: number, latitude: number) {
    const height =
      this.viewer.scene.globe.getHeight(
        Cartographic.fromDegrees(longitude, latitude),
      ) || 0;
    return Cartesian3.fromDegrees(
      longitude,
      latitude,
      Math.max(0, height) * 2 + 40,
    );
  }
  setData(event: Quake | null, events: Quake[], stations: Station[]) {
    const key = JSON.stringify([
      event && [event.id, event.latitude, event.longitude, event.magnitude],
      this.inset
        ? []
        : events
            .slice(0, 160)
            .map((e) => [e.id, e.latitude, e.longitude, e.magnitude]),
      this.inset
        ? []
        : stations.map((s) => [
            s.id,
            s.latitude,
            s.longitude,
            s.status,
            s.enabled,
          ]),
    ]);
    if (key === this.markerKey) return;
    this.markerKey = key;
    this.selected = event;
    (this.viewer.container as HTMLElement).dataset.eventCount = String(
      this.inset
        ? 0
        : events.slice(0, 160).filter((e) => e.id !== event?.id).length,
    );
    (this.viewer.container as HTMLElement).dataset.stationCount = String(
      this.inset ? 0 : stations.filter((s) => s.enabled).length,
    );
    const entities = this.viewer.entities;
    for (const entity of [...entities.values])
      if (entity.id.startsWith("mark:")) entities.remove(entity);
    this.markers = [];
    const addPoint = (
      id: string,
      longitude: number,
      latitude: number,
      size: number,
      color: Color,
    ) => {
      const entity = entities.add({
        id: `mark:${id}`,
        position: this.groundPosition(longitude, latitude),
        point: {
          pixelSize: size,
          color,
          outlineColor: Color.BLACK.withAlpha(0.4),
          outlineWidth: 1,
        },
      });
      this.markers.push({ entity, longitude, latitude });
    };
    if (!this.inset) {
      for (const quake of events.slice(0, 160))
        if (quake.id !== event?.id)
          addPoint(
            `quake:${quake.id}`,
            quake.longitude,
            quake.latitude,
            Math.max(5, Math.min(10, (quake.magnitude || 2) * 1.4)),
            amber.withAlpha(0.95),
          );
      for (const station of stations.filter((s) => s.enabled))
        addPoint(
          `station:${station.id}`,
          station.longitude,
          station.latitude,
          3,
          (station.status === "online" ? cyan : Color.SLATEGRAY).withAlpha(
            0.65,
          ),
        );
    }
    if (event && !this.inset)
      entities.add({
        id: "mark:beacon",
        polyline: {
          positions: [
            this.groundPosition(event.longitude, event.latitude),
            Cartesian3.fromDegrees(event.longitude, event.latitude, 180000),
          ],
          width: 3,
          material: new PolylineGlowMaterialProperty({
            glowPower: 0.3,
            color: amber.withAlpha(0.5),
          }),
        },
      });
    this.viewer.scene.requestRender();
  }
  camera(target: MapCamera, smooth = false) {
    const pose = { ...target };
    if (smooth && this.center) {
      const delta = ((pose.longitude - this.center[0] + 540) % 360) - 180;
      pose.longitude = this.center[0] + delta * 0.12;
      pose.latitude = this.center[1] + (pose.latitude - this.center[1]) * 0.12;
    }
    pose.longitude = ((((pose.longitude + 180) % 360) + 360) % 360) - 180;
    this.center = [pose.longitude, pose.latitude];
    const key = Object.values(pose)
      .map((n) => n.toFixed(4))
      .join(":");
    if (this.lastPose === key) return pose;
    this.lastPose = key;
    const ground =
      this.viewer.scene.globe.getHeight(
        Cartographic.fromDegrees(pose.longitude, pose.latitude),
      ) || 0;
    this.viewer.camera.lookAt(
      Cartesian3.fromDegrees(
        pose.longitude,
        pose.latitude,
        Math.max(0, ground) * 2,
      ),
      new HeadingPitchRange(
        CMath.toRadians(pose.heading),
        CMath.toRadians(pose.pitch),
        pose.range,
      ),
    );
    this.viewer.camera.lookAtTransform(Matrix4.IDENTITY);
    this.viewer.scene.requestRender();
    return pose;
  }
  frame(_time: number, motion: boolean) {
    if (this.renderFailed) throw new Error("三维上下文已失效");
    if (this.groundDirty) {
      this.groundDirty = false;
      for (const m of this.markers)
        m.entity.position = new ConstantPositionProperty(
          this.groundPosition(m.longitude, m.latitude),
        );
      this.viewer.scene.requestRender();
    }
    // External DEM fetches/mesh workers can complete between explicit frames.
    // Continue refinement while loading, including paused and fixed views.
    if (motion || !this.viewer.scene.globe.tilesLoaded)
      this.viewer.scene.requestRender();
    this.viewer.resize();
    this.viewer.render();
    const refining = !this.viewer.scene.globe.tilesLoaded;
    if (this.state.refining !== refining) {
      this.state.refining = refining;
      this.report({ ...this.state });
    }
    let visible = false;
    if (this.selected) {
      const position = this.groundPosition(
        this.selected.longitude,
        this.selected.latitude,
      );
      this.occluder.cameraPosition = this.viewer.camera.positionWC;
      const point = this.viewer.scene.cartesianToCanvasCoordinates(position);
      visible =
        !!point &&
        this.occluder.isPointVisible(position) &&
        point.x >= 0 &&
        point.y >= 0 &&
        point.x <= this.viewer.canvas.clientWidth &&
        point.y <= this.viewer.canvas.clientHeight;
      if (visible && point)
        this.marker.style.transform = `translate(${point.x}px, ${point.y}px)`;
    }
    this.marker.style.visibility = visible ? "visible" : "hidden";
  }
  destroy() {
    this.disposed = true;
    this.terrain.dispose();
    this.sourceAbort.abort();
    clearTimeout(this.terrainTimer);
    this.viewer.canvas.removeEventListener(
      "webglcontextlost",
      this.contextLost,
    );
    if (!this.viewer.isDestroyed()) this.viewer.destroy();
  }
}
