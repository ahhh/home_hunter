import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Relative base so the build works at https://<user>.github.io/<repo>/ without configuration.
export default defineConfig({
  base: "./",
  plugins: [react()],
  test: { environment: "node" },
});
