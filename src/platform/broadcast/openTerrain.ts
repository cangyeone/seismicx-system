import {
  Credit,
  CustomHeightmapTerrainProvider,
  HeightmapTerrainData,
  WebMercatorTilingScheme,
} from "cesium";

const SIZE = 65,
  MAX_LEVEL = 12;
const decoded = new Map<string, Promise<Float32Array>>();
let pending = 0;

async function heights(
  key: string,
  signal: AbortSignal,
): Promise<Float32Array> {
  const response = await fetch(`/api/map/tiles/elevation/${key}`, { signal });
  if (!response.ok) throw new Error("开放地形暂不可用");
  const bitmap = await createImageBitmap(await response.blob(), {
    colorSpaceConversion: "none",
    premultiplyAlpha: "none",
  });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const height = (x: number, y: number) => {
      const i = (y * canvas.width + x) * 4;
      return data[i] * 256 + data[i + 1] + data[i + 2] / 256 - 32768;
    };
    const result = new Float32Array(SIZE * SIZE);
    for (let y = 0; y < SIZE; y++)
      for (let x = 0; x < SIZE; x++) {
        const px = (x * (canvas.width - 1)) / (SIZE - 1),
          py = (y * (canvas.height - 1)) / (SIZE - 1);
        const x0 = Math.floor(px),
          y0 = Math.floor(py),
          x1 = Math.min(x0 + 1, canvas.width - 1),
          y1 = Math.min(y0 + 1, canvas.height - 1);
        const dx = px - x0,
          dy = py - y0;
        result[y * SIZE + x] =
          (height(x0, y0) * (1 - dx) + height(x1, y0) * dx) * (1 - dy) +
          (height(x0, y1) * (1 - dx) + height(x1, y1) * dx) * dy;
      }
    return result;
  } finally {
    bitmap.close();
  }
}

/** Real DEM geometry. Missing children are upsampled by Cesium, never random terrain. */
export class OpenTerrain extends CustomHeightmapTerrainProvider {
  private alive = true;
  private requests = new Set<AbortController>();
  private failures = new Map<string, number>();
  constructor(private report: (level: number, error: boolean) => void) {
    super({
      width: SIZE,
      height: SIZE,
      callback: () => undefined,
      tilingScheme: new WebMercatorTilingScheme(),
      credit: new Credit(
        '<a href="/map-sources.html" target="_blank">Mapzen / Tilezen</a>',
        true,
      ),
    });
  }
  getTileDataAvailable(_x: number, _y: number, level: number) {
    return level <= MAX_LEVEL;
  }
  requestTileGeometry(
    x: number,
    y: number,
    level: number,
  ): Promise<HeightmapTerrainData> | undefined {
    const key = `${level}/${x}/${y}`;
    if (
      !this.alive ||
      pending >= 6 ||
      (this.failures.get(key) || 0) > Date.now()
    )
      return undefined;
    let promise = decoded.get(key);
    if (!promise) {
      const controller = new AbortController();
      this.requests.add(controller);
      pending++;
      promise = heights(key, controller.signal).finally(() => {
        pending--;
        this.requests.delete(controller);
      });
      decoded.set(key, promise);
      if (decoded.size > 96) decoded.delete(decoded.keys().next().value!);
    }
    return promise
      .then((buffer) => {
        if (this.alive) this.report(level, false);
        return new HeightmapTerrainData({
          buffer: buffer.slice(),
          width: SIZE,
          height: SIZE,
          childTileMask: level < MAX_LEVEL ? 15 : 0,
        });
      })
      .catch((error) => {
        decoded.delete(key);
        if (this.alive) {
          if (this.failures.size > 128) this.failures.clear();
          this.failures.set(key, Date.now() + 30000);
          this.report(level, true);
        }
        throw error;
      });
  }
  dispose() {
    this.alive = false;
    // Requests can be shared by the main globe and inset: allow them to finish into
    // the bounded cache, rather than aborting a tile another scene is awaiting.
  }
}
