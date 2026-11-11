// Vercel function: the forge (code.storage-compatible API and git smart HTTP), under /forge.

import { FORGE_PATH, sharedServices } from "../src/server/services.ts";

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);
    // vercel.json rewrites /forge/<path> here as /api/forge?__path=<path>; put the original path back.
    const rewritten = url.searchParams.get("__path");
    if (!url.pathname.startsWith(`${FORGE_PATH}/`) && rewritten !== null) {
      url.searchParams.delete("__path");
      url.pathname = `${FORGE_PATH}/${rewritten}`;
      request = new Request(url, request);
    }
    const { forge } = await sharedServices();
    return forge.fetch(request);
  },
};
