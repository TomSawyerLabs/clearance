import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `bun run dev` runs this dev server in front of the Bun API server. The page
// is served from here, so this is also the origin passkeys get bound to in
// development.
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist/client", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { "/api": `http://127.0.0.1:${process.env.PORT || 8080}` },
  },
});
