// The mail API, beside the web app: what Postgres alone cannot do for the inbox (sending, drafts, domains and their
// DNS checks, app passwords, attachments, client profiles), with the user's Supabase token; and the public files
// other servers and mail clients fetch (MTA-STS policy, autoconfig, autodiscover, ACME challenges).

import type { SQL } from "bun";
import { serverAddresses } from "../mail/runtime.ts";
import {
  appleProfile,
  autodiscoverResponse,
  thunderbirdConfig,
} from "../mail/autoconfig.ts";
import {
  checkDomain,
  checkHost,
  domainRecords,
  hostRecords,
  zoneFile,
} from "../mail/dns-records.ts";
import {
  isAddress,
  parseAddressList,
  type Address,
} from "../mail/mime/address.ts";
import { parseMessage, partByPath, partBytes } from "../mail/mime/parse.ts";
import type { MailService } from "../mail/service.ts";
import { ourPolicy } from "../mail/smtp/mta-sts.ts";
import type { Account } from "../mail/store.ts";
import { challengeResponse } from "../mail/tls/acme.ts";
import type { Certificates } from "../mail/tls/certificates.ts";
import { createUserAuth, handle, HttpError, type ApiRequest } from "./http.ts";

type Outgoing = {
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  text?: string;
  html?: string;
  replyTo?: string;
  draftId?: string;
  attachments?: { filename: string; contentType: string; data: string; contentId?: string }[];
};

const MAX_ATTACHMENTS_BYTES = 20 * 1024 * 1024;

function addresses(value: string | undefined): Address[] {
  const list = parseAddressList(value ?? "");
  const bad = list.find((a) => !isAddress(a.address));
  if (bad) throw new HttpError(400, `${bad.address} is not an email address`);
  return list;
}

export function createMailApi({
  sql,
  service,
  certificates,
}: {
  sql: SQL;
  service: MailService;
  certificates?: Certificates;
}) {
  const userOf = createUserAuth();
  const { store, config, resolver } = service;
  let cachedAddresses: { at: number; value: string[] } | undefined;
  const ourAddresses = async () => {
    if (!cachedAddresses || Date.now() - cachedAddresses.at > 60_000)
      cachedAddresses = {
        at: Date.now(),
        value: await serverAddresses(config, resolver),
      };
    return cachedAddresses.value;
  };

  async function account(
    userId: string,
    id: string | undefined,
  ): Promise<Account> {
    const accounts = await store.accounts(userId);
    const found = id
      ? accounts.find((a) => a.id === id || a.address === id.toLowerCase())
      : accounts[0];
    if (!found)
      throw new HttpError(
        404,
        accounts.length ? "No such address" : "Add an address first",
      );
    return found;
  }

  async function ownedDomain(userId: string, id: string) {
    const domain = await store.domain(id);
    if (!domain || domain.user_id !== userId)
      throw new HttpError(404, "No such domain");
    return domain;
  }

  async function ownedMessage(userId: string, id: string) {
    const message = /^[0-9a-f-]{36}$/i.test(id)
      ? await store.message(id)
      : undefined;
    const owner = message ? await store.account(message.account_id) : undefined;
    if (!message || owner?.user_id !== userId)
      throw new HttpError(404, "No such message");
    return message;
  }

  function compose(body: Outgoing) {
    let total = 0;
    const attachments = (body.attachments ?? []).map((a) => {
      const content = Uint8Array.from(Buffer.from(a.data, "base64"));
      total += content.length;
      return {
        filename: String(a.filename).slice(0, 200),
        contentType: /^[\w.+-]+\/[\w.+-]+$/.test(a.contentType)
          ? a.contentType
          : "application/octet-stream",
        content,
        // An image the HTML shows (cid:), sent inline in a multipart/related.
        ...(a.contentId && /^[\w.@-]{1,200}$/.test(a.contentId) ? { contentId: a.contentId } : {}),
      };
    });
    if (total > MAX_ATTACHMENTS_BYTES)
      throw new HttpError(413, "Attachments are limited to 20 MB");
    return {
      to: addresses(body.to),
      cc: addresses(body.cc),
      bcc: addresses(body.bcc),
      subject: (body.subject ?? "").slice(0, 998),
      text: body.text ?? "",
      html: body.html || undefined,
      replyTo: body.replyTo,
      attachments,
    };
  }

  const domainView = async (
    domain: Awaited<ReturnType<typeof store.domain>> & {},
  ) => ({
    ...domain,
    records: domainRecords(domain, config, await ourAddresses()),
  });

  const api = {
    "/api/mail/server": {
      GET: handle(async (request) => {
        await userOf(request);
        const ips = await ourAddresses();
        return {
          hostname: config.hostname,
          ports: config.ports,
          tls: config.tls.mode,
          certificate: certificates?.current ?? null,
          relay: config.relay ? new URL(config.relay).hostname : null,
          addresses: ips,
          host: hostRecords(config, ips),
        };
      }),
    },
    "/api/mail/server/check": {
      POST: handle(async (request) => {
        await userOf(request);
        return {
          checks: await checkHost(config, resolver, await ourAddresses()),
        };
      }),
    },
    "/api/mail/domains": {
      GET: handle(async (request) => {
        const userId = await userOf(request);
        return {
          domains: await Promise.all(
            (await store.domains(userId)).map(domainView),
          ),
        };
      }),
      POST: handle(async (request) => {
        const userId = await userOf(request);
        const { name } = (await request.json()) as { name?: string };
        const clean = (name ?? "").trim().toLowerCase().replace(/^@/, "");
        if (
          !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(
            clean,
          )
        )
          throw new HttpError(400, "Enter a domain like example.com");
        if (await store.domain(clean))
          throw new HttpError(409, `${clean} is already on this server`);
        return {
          domain: await domainView(
            await store.createDomain({ name: clean, userId }),
          ),
        };
      }),
    },
    "/api/mail/domains/:id/check": {
      POST: handle(async (request) => {
        const userId = await userOf(request);
        const domain = await store.domain(request.params.id!);
        if (!domain || (domain.user_id !== userId && !domain.open))
          throw new HttpError(404, "No such domain");
        const report = await checkDomain(
          domain,
          config,
          resolver,
          await ourAddresses(),
        );
        if (domain.user_id === userId)
          await store.saveChecks(domain.id, report as never, report.verified);
        return report;
      }),
    },
    "/api/mail/domains/:id/dkim": {
      POST: handle(async (request) => {
        const domain = await ownedDomain(
          await userOf(request),
          request.params.id!,
        );
        return { domain: await domainView(await store.rotateDkim(domain.id)) };
      }),
    },
    "/api/mail/domains/:id/zone": {
      GET: handle(async (request) => {
        const domain = await ownedDomain(
          await userOf(request),
          request.params.id!,
        );
        const records = domainRecords(domain, config, await ourAddresses());
        return new Response(
          `; Mail records for ${domain.name}, to import in your DNS provider\n${zoneFile(records)}\n`,
          {
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              "Content-Disposition": `attachment; filename="${domain.name}.zone"`,
            },
          },
        );
      }),
    },
    "/api/mail/accounts": {
      POST: handle(async (request) => {
        const userId = await userOf(request);
        const body = (await request.json()) as {
          domain?: string;
          localPart?: string;
          displayName?: string;
        };
        try {
          return {
            account: await store.createAccount({
              userId,
              domain: body.domain ?? "",
              localPart: body.localPart ?? "",
              displayName: (body.displayName ?? "").slice(0, 120),
            }),
          };
        } catch (error) {
          throw new HttpError(
            400,
            error instanceof Error ? error.message : String(error),
          );
        }
      }),
    },
    "/api/mail/accounts/:id/profile": {
      GET: handle(async (request) => {
        const found = await account(await userOf(request), request.params.id);
        return new Response(
          appleProfile(config, {
            address: found.address,
            displayName: found.display_name,
          }),
          {
            headers: {
              "Content-Type": "application/x-apple-aspen-config",
              "Content-Disposition": `attachment; filename="${found.address}.mobileconfig"`,
            },
          },
        );
      }),
    },
    "/api/mail/app-passwords": {
      POST: handle(async (request) => {
        const userId = await userOf(request);
        const { name } = (await request.json()) as { name?: string };
        return await store.createAppPassword(userId, name ?? "Mail client");
      }),
    },
    "/api/mail/send": {
      POST: handle(async (request) => {
        const userId = await userOf(request);
        const body = (await request.json()) as Outgoing & { key?: string };
        const from = await account(userId, body.from);
        const message = compose(body);
        if (message.to.length + message.cc.length + message.bcc.length === 0)
          throw new HttpError(400, "Add a recipient");
        // The browser sends a fresh key per message, so a double click or a retried request sends once.
        const key =
          typeof body.key === "string" && /^[\w-]{8,80}$/.test(body.key)
            ? `web:${userId}:${body.key}`
            : undefined;
        const result = await service
          .compose(from, message, { idempotencyKey: key })
          .catch((error) => {
            throw new HttpError(
              400,
              error instanceof Error ? error.message : String(error),
            );
          });
        if (body.draftId) {
          const draft = await ownedMessage(userId, body.draftId).catch(
            () => undefined,
          );
          if (draft) {
            await store.expunge([draft.id]);
            service.events.emit("folder", draft.folder_id);
          }
        }
        return {
          id: result.sent?.id,
          queued: result.queued,
          local: result.local,
        };
      }),
    },
    "/api/mail/drafts": {
      POST: handle(async (request) => {
        const userId = await userOf(request);
        const body = (await request.json()) as Outgoing;
        const from = await account(userId, body.from);
        const draft = await service.saveDraft(
          from,
          compose(body),
          body.draftId,
        );
        return { id: draft.id };
      }),
    },
    "/api/mail/messages/:id/raw": {
      GET: handle(async (request) => {
        const message = await ownedMessage(
          await userOf(request),
          request.params.id!,
        );
        const raw = await store.raw(message.id);
        if (!raw) throw new HttpError(404, "The message's source is gone");
        return new Response(Buffer.from(raw), {
          headers: {
            "Content-Type": "message/rfc822",
            "Content-Disposition": `attachment; filename="message.eml"`,
          },
        });
      }),
    },
    "/api/mail/messages/:id/parts/:path": {
      GET: handle(async (request) => {
        const message = await ownedMessage(
          await userOf(request),
          request.params.id!,
        );
        const raw = await store.raw(message.id);
        if (!raw) throw new HttpError(404, "The message's source is gone");
        const parsed = parseMessage(raw);
        const part = partByPath(parsed.root, request.params.path!);
        if (!part) throw new HttpError(404, "No such attachment");
        const filename = (
          part.disposition?.params.filename ??
          part.contentType.params.name ??
          "attachment"
        ).replace(/["\r\n]/g, "_");
        // Served as a download, never rendered on the app's origin.
        return new Response(Buffer.from(partBytes(parsed, part)), {
          headers: {
            "Content-Type": `${part.contentType.type}/${part.contentType.subtype}`,
            "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "sandbox",
          },
        });
      }),
    },
  };

  // Public: fetched by other mail servers, mail clients and the certificate authority.
  const host = (request: Request) =>
    (request.headers.get("host") ?? "").toLowerCase().replace(/:\d+$/, "");
  const autoconfig = async (request: Request) => {
    const url = new URL(request.url);
    const email = url.searchParams.get("emailaddress") ?? "";
    const domain = (
      email.split("@")[1] ?? host(request).replace(/^autoconfig\./, "")
    ).toLowerCase();
    if (!(await store.isLocalDomain(domain)))
      return new Response("Unknown domain", { status: 404 });
    return new Response(thunderbirdConfig(config, domain), {
      headers: { "Content-Type": "application/xml" },
    });
  };
  const wellKnown = {
    "/.well-known/mta-sts.txt": async (request: Request) => {
      const domain = host(request).replace(/^mta-sts\./, "");
      if (!(await store.isLocalDomain(domain)))
        return new Response("Unknown domain", { status: 404 });
      return new Response(ourPolicy(config.hostname), {
        headers: { "Content-Type": "text/plain" },
      });
    },
    "/mail/config-v1.1.xml": autoconfig,
    "/.well-known/autoconfig/mail/config-v1.1.xml": autoconfig,
    "/autodiscover/autodiscover.xml": async (request: Request) => {
      const body = request.method === "POST" ? await request.text() : "";
      const email =
        body.match(/<EMailAddress>([^<]+)<\/EMailAddress>/i)?.[1]?.trim() ?? "";
      if (
        !isAddress(email) ||
        !(await store.isLocalDomain(email.split("@")[1]!))
      )
        return new Response("Unknown address", { status: 404 });
      return new Response(autodiscoverResponse(config, email), {
        headers: { "Content-Type": "application/xml" },
      });
    },
    "/.well-known/acme-challenge/:token": (request: ApiRequest) =>
      challengeResponse(sql, request.params.token!),
  };
  return { api, wellKnown };
}
