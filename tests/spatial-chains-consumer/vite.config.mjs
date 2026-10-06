import { defineConfig } from 'vite';
import unworklet from '@unworklet/unplugin';
export default defineConfig({ plugins: [unworklet()], build: { target: 'esnext' } });
