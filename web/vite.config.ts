import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // Lokalnie: web/.env.local z DEV_API_KEY = API_KEY serwera
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.DEV_API_ORIGIN || 'http://localhost:8787';
  const proxy = { target, changeOrigin: true, headers: { 'x-api-key': env.DEV_API_KEY ?? '' } };
  return {
    plugins: [react()],
    server: { proxy: { '/api': proxy, '/ical': proxy } },
  };
});
