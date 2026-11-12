// The social API: what the web app's Social pages call. Every route acts on one of the signed-in user's brands; the
// service checks that each post and account belongs to that brand's Zernio profile.

import { config } from "../config.ts";
import { ScrapeError } from "../social/scrapecreators.ts";
import { SocialError, type PostInput, type SocialService } from "../social/service.ts";
import { rewrite } from "../social/writer.ts";
import { ZernioError } from "../social/zernio.ts";
import { createUserAuth, handle, HttpError, type ApiRequest } from "./http.ts";

/** Upstream errors as the browser should see them: a Zernio 401 is the server's key, not the user's session. */
function asHttp(error: unknown): never {
  if (error instanceof SocialError) throw new HttpError(error.status, error.message);
  if (error instanceof ZernioError || error instanceof ScrapeError) {
    const passes = [400, 402, 404, 409, 413, 422, 429].includes(error.status);
    throw new HttpError(passes ? error.status : 502, error.message);
  }
  throw error;
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Send JSON");
  }
}

export function createSocialApi({ service }: { service: SocialService }) {
  const userOf = createUserAuth();

  /** A handler for routes under a brand: the brand is the user's, or the request fails with a 404. */
  const forBrand = (
    run: (brand: Awaited<ReturnType<SocialService["brand"]>>, request: ApiRequest) => Promise<unknown>,
  ) =>
    handle(async (request) => {
      try {
        const brand = await service.brand(await userOf(request), request.params.brandId!);
        return await run(brand, request);
      } catch (error) {
        asHttp(error);
      }
    });

  const plain = (run: (userId: string, request: ApiRequest) => Promise<unknown>) =>
    handle(async (request) => {
      try {
        return await run(await userOf(request), request);
      } catch (error) {
        asHttp(error);
      }
    });

  return {
    "/api/social/brands": {
      GET: plain(async (userId) => ({
        brands: await service.brands(userId),
        status: service.status(),
        linkable: service.status().link_existing ? await service.linkableProfiles().catch(() => []) : [],
      })),
      POST: plain(async (userId, request) => ({
        brand: await service.createBrand(userId, await body(request)),
      })),
    },
    "/api/social/brands/:brandId": {
      GET: forBrand(async (brand) => ({ brand })),
      PATCH: forBrand(async (brand, request) => ({
        brand: await service.updateBrand(brand, await body(request)),
      })),
      DELETE: forBrand(async (brand) => {
        await service.deleteBrand(brand);
        return { ok: true };
      }),
    },
    "/api/social/brands/:brandId/accounts": {
      GET: forBrand(async (brand) => ({ accounts: await service.accounts(brand) })),
    },
    "/api/social/brands/:brandId/accounts/:accountId": {
      DELETE: forBrand(async (brand, request) => {
        await service.disconnect(brand, request.params.accountId!);
        return { ok: true };
      }),
    },
    "/api/social/brands/:brandId/connect": {
      POST: forBrand(async (brand, request) => {
        const { platform } = await body<{ platform: string }>(request);
        const back = `${config.publicUrl}/social/${brand.id}/brand?connected=${encodeURIComponent(platform)}`;
        return { url: await service.connectUrl(brand, platform, back) };
      }),
    },
    "/api/social/brands/:brandId/posts": {
      GET: forBrand(async (brand, request) => {
        const query = new URL(request.url).searchParams;
        return {
          posts: await service.posts(brand, {
            from: query.get("from") ?? undefined,
            to: query.get("to") ?? undefined,
            status: query.get("status") ?? undefined,
            search: query.get("search") ?? undefined,
          }),
        };
      }),
      POST: forBrand(async (brand, request) => {
        const input = await body<PostInput & { idempotency_key?: string }>(request);
        return service.savePost(brand, input, { idempotencyKey: input.idempotency_key });
      }),
    },
    "/api/social/brands/:brandId/posts/:postId": {
      GET: forBrand(async (brand, request) => ({ post: await service.post(brand, request.params.postId!) })),
      PUT: forBrand(async (brand, request) =>
        service.savePost(brand, await body<PostInput>(request), { id: request.params.postId }),
      ),
      DELETE: forBrand(async (brand, request) => {
        await service.deletePost(brand, request.params.postId!);
        return { ok: true };
      }),
    },
    "/api/social/brands/:brandId/posts/:postId/reschedule": {
      POST: forBrand(async (brand, request) => {
        const { at } = await body<{ at: string }>(request);
        if (!at || Number.isNaN(Date.parse(at))) throw new HttpError(400, "Give the new time");
        return { post: await service.reschedule(brand, request.params.postId!, new Date(at).toISOString()) };
      }),
    },
    "/api/social/brands/:brandId/posts/:postId/retry": {
      POST: forBrand(async (brand, request) => ({ post: await service.retryPost(brand, request.params.postId!) })),
    },
    "/api/social/brands/:brandId/imports": {
      POST: forBrand(async (brand, request) => {
        const { url } = await body<{ url: string }>(request);
        if (!url?.trim()) throw new HttpError(400, "Paste the post's URL");
        return { post: await service.importPost(brand, url) };
      }),
    },
    "/api/social/brands/:brandId/imports/:importId": {
      DELETE: forBrand(async (brand, request) => {
        await service.deleteImported(brand, request.params.importId!);
        return { ok: true };
      }),
    },
    "/api/social/brands/:brandId/media": {
      POST: forBrand(async (brand, request) => {
        const form = await request.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) throw new HttpError(400, "Send a file");
        return { media: await service.upload(brand, file) };
      }),
    },
    "/api/social/brands/:brandId/rewrite": {
      POST: forBrand(async (brand, request) => {
        const input = await body<{ text: string; instruction: string; platform?: string }>(request);
        if (!input.text?.trim()) throw new HttpError(400, "Write something first");
        if (!input.instruction?.trim()) throw new HttpError(400, "Say what to change");
        return { text: await rewrite(brand, input) };
      }),
    },
    "/api/social/brands/:brandId/analytics": {
      GET: forBrand(async (brand, request) => {
        const days = Number(new URL(request.url).searchParams.get("days") ?? 30);
        return { analytics: await service.analytics(brand, days) };
      }),
    },
    "/api/social/brands/:brandId/watch": {
      GET: forBrand(async (brand) => ({
        accounts: await service.watchlist(brand),
        history: await service.watchHistory(brand),
      })),
      POST: forBrand(async (brand, request) => ({
        account: await service.watch(brand, await body(request)),
      })),
    },
    "/api/social/brands/:brandId/watch/:watchId": {
      DELETE: forBrand(async (brand, request) => {
        await service.unwatch(brand, request.params.watchId!);
        return { ok: true };
      }),
    },
    "/api/social/brands/:brandId/watch/:watchId/refresh": {
      POST: forBrand(async (brand, request) => ({
        account: await service.refreshWatched(await service.watched(brand, request.params.watchId!)),
      })),
    },
  };
}
