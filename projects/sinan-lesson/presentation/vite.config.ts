// powered by dsh - https://github.com/deepseek-ai/deepseek-harness

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    fs: { allow: [".."] },
  },
});
