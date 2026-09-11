import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The client connects directly to ws://localhost:8080 — no proxy needed
    // because browsers allow cross-origin WebSocket without CORS enforcement.
  },
});
