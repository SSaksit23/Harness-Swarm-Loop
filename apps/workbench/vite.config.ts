import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5177,
    proxy: {
      "/api": "http://localhost:4177",
      "/ws": { target: "ws://localhost:4177", ws: true },
    },
  },
});
