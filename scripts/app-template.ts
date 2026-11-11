// Regenerates `templates/app`, the app every new project starts from: a Vite + React app made by the shadcn CLI,
// with every shadcn component added. Run it to move the template to a newer shadcn; the preview image installs the
// template's packages (`bun run app:image`).

import { $ } from "bun";

const SHADCN = "shadcn@4.23.0";
const target = new URL("../templates/app/", import.meta.url).pathname;

await $`rm -rf ${target}`;
await $`mkdir -p ${target}`;
await $`docker run --rm -v ${target}:/out -w /work node:22-slim sh -c ${[
  "apt-get update -qq >/dev/null && apt-get install -y -qq git ca-certificates >/dev/null",
  `npx -y ${SHADCN} init -t vite -b radix -p nova -n app -y --no-monorepo`,
  `cd app && npx -y ${SHADCN} add --all -y`,
  // The lock file and packages live in the preview image, not in each project's repository.
  "rm -rf node_modules package-lock.json .git",
  "cp -a . /out && chown -R $(stat -c %u:%g /out) /out",
].join(" && ")}`;
console.log(`[template] wrote ${target}`);
