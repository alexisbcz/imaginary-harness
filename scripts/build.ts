// Builds the web app into dist/ for static hosting (Vercel), with Tailwind and the BUN_PUBLIC_* variables inlined.

import tailwind from "bun-plugin-tailwind";

const result = await Bun.build({
  entrypoints: ["./src/web/index.html"],
  outdir: "./dist",
  publicPath: "/",
  plugins: [tailwind],
  minify: true,
  splitting: true,
  sourcemap: "linked",
  target: "browser",
  env: "BUN_PUBLIC_*",
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
for (const output of result.outputs)
  console.log(
    `${output.path.replace(`${process.cwd()}/`, "")}  ${(output.size / 1024).toFixed(1)} KiB`,
  );
