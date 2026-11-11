// Wraps the project's own vite.config.ts with the builder's plugin and the container's server settings.
import { loadConfigFromFile, mergeConfig } from "vite";
import richelieu from "./plugin.mjs";

export default async (env) => {
  const loaded = await loadConfigFromFile(env, undefined, process.cwd());
  return mergeConfig(loaded?.config ?? {}, {
    plugins: [richelieu()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      strictPort: true,
      allowedHosts: true,
    },
    // Pre-bundle what every source file imports, the unused shadcn components included: a dependency found later
    // makes Vite re-optimize and reload the page mid-change, which can briefly load two copies of React.
    optimizeDeps: { entries: ["index.html", "src/**/*.{js,jsx,ts,tsx}"] },
    clearScreen: false,
  });
};
