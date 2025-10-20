// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/gn": {
        target: "https://news.google.com",
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/gn/, ""),
        timeout: 30000,
      },
    },
  },
});
