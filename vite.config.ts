import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        entryFileNames: "router.js",
      },
    },
  },
  build: {
    // Dont minify, we want others to be able to inspect and modify
    minify: false,
  },
});
