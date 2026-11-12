// The newsletter API: what the web app's Newsletter pages call. Every route acts on one of the signed-in user's
// newsletters, with that newsletter's Substack session, which never leaves the server.

import { NewsletterError, type DraftInput, type NewsletterService } from "../newsletter/service.ts";
import { SubstackError } from "../newsletter/substack.ts";
import { assist, type AssistInput } from "../newsletter/writer.ts";
import { createUserAuth, handle, HttpError, type ApiRequest } from "./http.ts";

function asHttp(error: unknown): never {
  if (error instanceof NewsletterError) throw new HttpError(error.status, error.message);
  // A Substack 401 is the newsletter's session, not the user's Richelieu session: 409 keeps the app signed in.
  if (error instanceof SubstackError) {
    const status = error.status === 401 ? 409 : [400, 404, 409, 413, 422, 429].includes(error.status) ? error.status : 502;
    throw new HttpError(status, error.message);
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

export function createNewsletterApi({ service }: { service: NewsletterService }) {
  const userOf = createUserAuth();
  type N = Awaited<ReturnType<NewsletterService["newsletter"]>>;

  const forNewsletter = (run: (newsletter: N, request: ApiRequest) => Promise<unknown>) =>
    handle(async (request) => {
      try {
        const newsletter = await service.newsletter(await userOf(request), request.params.newsletterId!);
        return await run(newsletter, request);
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

  const base = "/api/newsletters/:newsletterId";

  return {
    "/api/newsletters": {
      GET: plain(async (userId) => ({ newsletters: await service.newsletters(userId), status: service.status() })),
      POST: plain(async (userId, request) => ({ newsletter: await service.createNewsletter(userId, await body(request)) })),
    },
    [base]: {
      GET: forNewsletter(async (newsletter) => ({ newsletter })),
      PATCH: forNewsletter(async (newsletter, request) => ({
        newsletter: await service.updateNewsletter(newsletter, await body(request)),
      })),
      DELETE: forNewsletter(async (newsletter) => {
        await service.deleteNewsletter(newsletter);
        return { ok: true };
      }),
    },
    [`${base}/connection`]: {
      PUT: forNewsletter(async (newsletter, request) => {
        const input = await body<{ publication?: string; cookie?: string }>(request);
        if (!input.cookie?.trim()) throw new HttpError(400, "Paste the substack.sid cookie");
        return { newsletter: await service.connect(newsletter, { publication: input.publication, cookie: input.cookie }) };
      }),
      DELETE: forNewsletter(async (newsletter) => {
        await service.disconnect(newsletter);
        return { ok: true };
      }),
    },
    [`${base}/posts`]: {
      GET: forNewsletter(async (newsletter, request) => {
        const query = new URL(request.url).searchParams;
        const state = query.get("state") as "draft" | "scheduled" | "published" | null;
        return { posts: await service.posts(newsletter, { state: state ?? undefined, search: query.get("search") ?? undefined }) };
      }),
      POST: forNewsletter(async (newsletter, request) => ({ post: await service.createDraft(newsletter, await body<DraftInput>(request)) })),
    },
    [`${base}/posts/:postId`]: {
      GET: forNewsletter(async (newsletter, request) => ({ post: await service.post(newsletter, request.params.postId!) })),
      PUT: forNewsletter(async (newsletter, request) => ({
        post: await service.saveDraft(newsletter, request.params.postId!, await body(request)),
      })),
      DELETE: forNewsletter(async (newsletter, request) => {
        await service.deleteDraft(newsletter, request.params.postId!);
        return { ok: true };
      }),
    },
    [`${base}/posts/:postId/check`]: {
      GET: forNewsletter(async (newsletter, request) => ({ problems: await service.check(newsletter, request.params.postId!) })),
    },
    [`${base}/posts/:postId/publish`]: {
      POST: forNewsletter(async (newsletter, request) => {
        const { send } = await body<{ send?: boolean }>(request);
        if (typeof send !== "boolean") throw new HttpError(400, "Say whether to email it (send)");
        return service.publish(newsletter, request.params.postId!, { send });
      }),
    },
    [`${base}/posts/:postId/schedule`]: {
      POST: forNewsletter(async (newsletter, request) => {
        const { at, send } = await body<{ at?: string; send?: boolean }>(request);
        if (!at) throw new HttpError(400, "Give the time to publish");
        return service.schedule(newsletter, request.params.postId!, { at, send: send !== false });
      }),
      DELETE: forNewsletter(async (newsletter, request) => {
        await service.unschedule(newsletter, request.params.postId!);
        return { ok: true };
      }),
    },
    [`${base}/posts/:postId/comments`]: {
      GET: forNewsletter(async (newsletter, request) => ({ comments: await service.comments(newsletter, request.params.postId!) })),
    },
    [`${base}/images`]: {
      POST: forNewsletter(async (newsletter, request) => {
        const form = await request.formData().catch(() => null);
        const file = form?.get("file");
        if (!(file instanceof File)) throw new HttpError(400, "Send a file");
        const postId = Number(form?.get("post_id")) || undefined;
        return { image: await service.uploadImage(newsletter, file, postId) };
      }),
    },
    [`${base}/assist`]: {
      POST: forNewsletter(async (newsletter, request) => {
        const input = await body<AssistInput>(request);
        if (!input.text?.trim() && input.action !== "continue") throw new HttpError(400, "Write or select something first");
        try {
          return { result: await assist(newsletter, input) };
        } catch (error) {
          throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }
      }),
    },
    [`${base}/analytics`]: {
      GET: forNewsletter(async (newsletter, request) => ({
        analytics: await service.analytics(newsletter, new URL(request.url).searchParams.has("fresh")),
      })),
    },
    [`${base}/ideas`]: {
      GET: forNewsletter(async (newsletter) => ({ ideas: await service.ideas(newsletter) })),
      POST: forNewsletter(async (newsletter, request) => ({ idea: await service.createIdea(newsletter, await body(request)) })),
    },
    [`${base}/ideas/:ideaId`]: {
      PATCH: forNewsletter(async (newsletter, request) => ({
        idea: await service.updateIdea(newsletter, request.params.ideaId!, await body(request)),
      })),
      DELETE: forNewsletter(async (newsletter, request) => {
        await service.deleteIdea(newsletter, request.params.ideaId!);
        return { ok: true };
      }),
    },
    [`${base}/ideas/:ideaId/draft`]: {
      POST: forNewsletter(async (newsletter, request) => ({ post: await service.draftFromIdea(newsletter, request.params.ideaId!) })),
    },
    [`${base}/notes`]: {
      GET: forNewsletter(async (newsletter) => ({ notes: await service.notes(newsletter) })),
      POST: forNewsletter(async (newsletter, request) => ({
        note: await service.saveNote(newsletter, { body: (await body<{ body: string }>(request)).body ?? "" }),
      })),
    },
    [`${base}/notes/:noteId`]: {
      PUT: forNewsletter(async (newsletter, request) => ({
        note: await service.saveNote(newsletter, { id: request.params.noteId, body: (await body<{ body: string }>(request)).body ?? "" }),
      })),
      DELETE: forNewsletter(async (newsletter, request) => {
        await service.deleteNote(newsletter, request.params.noteId!);
        return { ok: true };
      }),
    },
    [`${base}/notes/:noteId/schedule`]: {
      POST: forNewsletter(async (newsletter, request) => {
        const { at } = await body<{ at?: string | null }>(request);
        return { note: await service.scheduleNote(newsletter, request.params.noteId!, at ?? null) };
      }),
    },
    [`${base}/notes/:noteId/publish`]: {
      POST: forNewsletter(async (newsletter, request) => ({ note: await service.publishNote(newsletter, request.params.noteId!) })),
    },
  };
}
