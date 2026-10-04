import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { cpSync, mkdirSync } from "node:fs";

function cesiumAssets() {
  return {
    name: "cesium-local-assets",
    buildStart() {
      mkdirSync("public/cesium", { recursive: true });
      for (const folder of ["Assets", "ThirdParty", "Workers", "Widgets"])
        cpSync(
          `node_modules/cesium/Build/Cesium/${folder}`,
          `public/cesium/${folder}`,
          { recursive: true },
        );
    },
  };
}
export default defineConfig({
  plugins: [react(), cesiumAssets()],
  define: { CESIUM_BASE_URL: JSON.stringify("/cesium/") },
  server: { port: 5173, proxy: { "/api": "http://127.0.0.1:8000" } },
});
