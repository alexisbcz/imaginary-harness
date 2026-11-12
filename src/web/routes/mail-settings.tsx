import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { formatDistanceToNow } from "date-fns";
import { cn } from "cn";
import { LightIconButton, SegmentedControl } from "twenty-ui/components/input";
import { Tag } from "twenty-ui/primitives/data-display";
import { Loader, Skeleton } from "twenty-ui/primitives/feedback";
import { Button, Input, Switch } from "twenty-ui/primitives/input";
import { Dialog } from "twenty-ui/primitives/surfaces";
import {
  IconArrowLeft,
  IconCheck,
  IconCircleCheck,
  IconCircleX,
  IconCopy,
  IconDownload,
  IconKey,
  IconMail,
  IconRefresh,
  IconServer,
  IconSettings,
  IconTrash,
  IconWorld,
} from "twenty-ui/icon";

import { IconTile } from "@/components/icon-tile";
import { Page } from "@/components/page";
import { SimpleSelect } from "@/components/simple-select";
import { api } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import {
  download,
  updateAccount,
  useMailAccounts,
  type DnsRecord,
  type MailAccount,
  type MailDomain,
  type MailServer,
} from "@/lib/mail";
import { createClient } from "@/lib/supabase/client";

const supabase = createClient();

function Section({
  icon,
  color,
  title,
  description,
  children,
  actions,
}: {
  icon: React.ReactNode;
  color: "blue" | "green" | "orange" | "purple";
  title: string;
  description: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <IconTile color={color} size="md">
          {icon}
        </IconTile>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-t-text">{title}</h2>
          <p className="text-t-text-tertiary">{description}</p>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** `label` says what it copies: "Copy the name". */
function CopyButton({ value, label }: { value: string; label: string }) {
  const { t: tc } = useTranslation("common");
  const [copied, setCopied] = useState(false);
  return (
    <LightIconButton
      size="xs"
      aria-label={label}
      tooltip={copied ? tc("copied") : label}
      onClick={() =>
        void navigator.clipboard.writeText(value).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => {},
        )
      }
    >
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </LightIconButton>
  );
}

function RecordRow({ record }: { record: DnsRecord }) {
  const { t } = useTranslation("mail");
  const status = record.ok === undefined ? undefined : record.ok;
  return (
    <div className="grid grid-cols-[20px_52px_minmax(0,1fr)] items-start gap-x-2 gap-y-1 border-b border-t-border-light px-3 py-2.5 last:border-b-0">
      <span className="pt-0.5">
        {status === true ? (
          <IconCircleCheck
            size={16}
            className="text-[var(--t-color-green10)]"
          />
        ) : status === false ? (
          <IconCircleX
            size={16}
            className={
              record.required
                ? "text-[var(--t-color-red10)]"
                : "text-[var(--t-color-amber10)]"
            }
          />
        ) : (
          <span className="block size-2 translate-y-1.5 rounded-full bg-t-border-strong" />
        )}
      </span>
      <Tag
        color={record.required ? "blue" : "gray"}
        variant="soft"
        className="justify-self-start font-mono text-[11px]"
      >
        {record.type}
      </Tag>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1">
          <code className="min-w-0 truncate font-mono text-[12px] text-t-text">
            {record.name}
          </code>
          <CopyButton value={record.name} label={t("settings.copy.name")} />
          {!record.required && (
            <span className="text-[11px] text-t-text-tertiary">
              {t("settings.records.recommended")}
            </span>
          )}
        </div>
        <div className="flex items-start gap-1">
          <code className="min-w-0 flex-1 rounded-sm bg-t-tertiary px-1.5 py-0.5 font-mono text-[11px] break-all text-t-text-secondary">
            {record.value}
          </code>
          <CopyButton value={record.value} label={t("settings.copy.value")} />
        </div>
        <p className="text-[12px] text-t-text-tertiary">{record.purpose}</p>
        {record.ok === false && (
          <p className="text-[12px] text-[var(--t-color-amber11)]">
            {record.note ??
              (record.found?.length
                ? t("settings.records.found", {
                    values: record.found.join(" | "),
                  })
                : t("settings.records.notFound"))}
          </p>
        )}
      </div>
    </div>
  );
}

function DomainCard({
  domain,
  onChanged,
}: {
  domain: MailDomain;
  onChanged: () => void;
}) {
  const { t } = useTranslation("mail");
  const [records, setRecords] = useState<DnsRecord[]>(() => {
    const last = (domain.checks as { checks?: DnsRecord[] }).checks;
    return last ?? domain.records;
  });
  const [checking, setChecking] = useState(false);
  const [open, setOpen] = useState(!domain.verified_at);
  const owned = domain.user_id !== null;

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const report = await api<{ checks: DnsRecord[]; verified: boolean }>(
        `/api/mail/domains/${domain.id}/check`,
        { method: "POST" },
      );
      setRecords(report.checks);
      onChanged();
    } finally {
      setChecking(false);
    }
  }, [domain.id]);

  const required = records.filter((r) => r.required);
  const passing = required.filter((r) => r.ok).length;
  return (
    <div className="overflow-hidden rounded-lg border border-t-border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <IconWorld size={16} className="text-t-text-tertiary" />
        <span className="font-semibold text-t-text">{domain.name}</span>
        {domain.verified_at ? (
          <Tag color="green" variant="soft">
            {t("settings.domain.verified")}
          </Tag>
        ) : (
          <Tag color="amber" variant="soft">
            {records.some((r) => r.ok !== undefined)
              ? t("settings.domain.passing", {
                  passing,
                  count: required.length,
                })
              : t("settings.domain.waiting")}
          </Tag>
        )}
        {domain.open && !owned && (
          <span className="text-[12px] text-t-text-tertiary">
            {t("settings.domain.serverDomain")}
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)}>
          {open
            ? t("settings.domain.hideRecords")
            : t("settings.domain.showRecords")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          loading={checking}
          loadingPosition="start"
          startIcon={<IconRefresh size={14} />}
          onClick={() => void check()}
        >
          {t("settings.domain.check")}
        </Button>
      </div>
      {open && (
        <>
          <div className="border-t border-t-border-light bg-t-secondary px-3 py-2 text-[12px] text-t-text-tertiary">
            {t("settings.domain.help")}
            {domain.checked_at &&
              ` ${t("settings.domain.lastChecked", {
                when: formatDistanceToNow(new Date(domain.checked_at), {
                  addSuffix: true,
                  locale: dateLocale(),
                }),
              })}`}
          </div>
          <div className="border-t border-t-border-light">
            {records.map((record) => (
              <RecordRow key={record.id} record={record} />
            ))}
          </div>
          {owned && (
            <div className="flex flex-wrap gap-2 border-t border-t-border-light px-3 py-2">
              <Button
                size="sm"
                variant="ghost"
                startIcon={<IconDownload size={14} />}
                onClick={() =>
                  void download(
                    `/api/mail/domains/${domain.id}/zone`,
                    `${domain.name}.zone`,
                  )
                }
              >
                {t("settings.domain.zoneFile")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                startIcon={<IconKey size={14} />}
                onClick={() =>
                  void api<{ domain: MailDomain }>(
                    `/api/mail/domains/${domain.id}/dkim`,
                    { method: "POST" },
                  ).then(({ domain }) => {
                    setRecords(domain.records);
                    onChanged();
                  })
                }
              >
                {t("settings.domain.newDkim")}
              </Button>
              <div className="flex-1" />
              <Button
                size="sm"
                variant="ghost"
                color="danger"
                startIcon={<IconTrash size={14} />}
                onClick={() => {
                  if (
                    confirm(
                      t("settings.domain.removeConfirm", {
                        domain: domain.name,
                      }),
                    )
                  )
                    void supabase
                      .from("mail_domains")
                      .delete()
                      .eq("id", domain.id)
                      .then(onChanged);
                }}
              >
                {t("settings.domain.remove")}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AccountRow({
  account,
  domains,
}: {
  account: MailAccount;
  domains: MailDomain[];
}) {
  const { t } = useTranslation("mail");
  const [name, setName] = useState(account.display_name);
  useEffect(() => setName(account.display_name), [account.display_name]);
  const domain = domains.find((d) => d.id === account.domain_id);
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-t-border px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-t-text">{account.address}</span>
        {domain && !domain.verified_at && (
          <Tag color="amber" variant="soft">
            {t("settings.account.receivesOnly", { domain: domain.name })}
          </Tag>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          startIcon={<IconDownload size={14} />}
          onClick={() =>
            void download(
              `/api/mail/accounts/${account.id}/profile`,
              `${account.address}.mobileconfig`,
            )
          }
        >
          {t("settings.account.appleProfile")}
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-t-text-tertiary">
            {t("settings.account.displayName")}
          </span>
          <Input
            size="sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() =>
              name !== account.display_name &&
              void updateAccount(account.id, { display_name: name.trim() })
            }
            placeholder={t("settings.account.displayNamePlaceholder")}
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-t-text-tertiary">
            {t("settings.account.agent")}
          </span>
          <SegmentedControl<MailAccount["assistant"]>
            aria-label={t("settings.account.assistant")}
            size="sm"
            value={account.assistant}
            onValueChange={(assistant) =>
              void updateAccount(account.id, { assistant })
            }
            options={[
              { value: "off", label: t("settings.account.assistantOff") },
              {
                value: "summarize",
                label: t("settings.account.assistantSummarize"),
              },
              { value: "draft", label: t("settings.account.assistantDraft") },
            ]}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-t-text-secondary">
        <Switch.Root
          size="sm"
          checked={account.catch_all}
          onCheckedChange={(catch_all) =>
            void updateAccount(account.id, { catch_all })
          }
        >
          <Switch.Thumb />
        </Switch.Root>
        {t("settings.account.catchAll", {
          domain: domain?.name ?? t("settings.account.thisDomain"),
        })}
      </label>
    </div>
  );
}

function AppPasswords({
  server,
  accounts,
}: {
  server: MailServer | null;
  accounts: MailAccount[];
}) {
  const { t } = useTranslation("mail");
  const { t: tc } = useTranslation("common");
  const [passwords, setPasswords] = useState<
    | {
        id: string;
        name: string;
        last_used_at: string | null;
        created_at: string;
      }[]
    | null
  >(null);
  const [created, setCreated] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const load = useCallback(async () => {
    const { data } = await supabase
      .from("mail_app_passwords")
      .select("id, name, last_used_at, created_at")
      .order("created_at");
    setPasswords(data ?? []);
  }, []);
  useEffect(() => void load(), [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const { password } = await api<{ password: string }>(
        "/api/mail/app-passwords",
        { body: { name: name || t("settings.apps.defaultName") } },
      );
      setCreated(password);
      setName("");
      await load();
    } finally {
      setCreating(false);
    }
  }

  // Each row: its label, its value, and its copy button's label (none for the password, which is not here).
  const rows: [string, string, string | null][] = server
    ? [
        [
          t("settings.apps.username"),
          accounts[0]?.address ?? t("settings.apps.yourAddress"),
          t("settings.copy.username"),
        ],
        [
          "IMAP",
          t("settings.apps.imapValue", {
            host: server.hostname,
            port: server.ports.imaps,
          }),
          t("settings.copy.imap"),
        ],
        [
          "SMTP",
          t("settings.apps.smtpValue", {
            host: server.hostname,
            port: server.ports.submissions,
            submission: server.ports.submission,
          }),
          t("settings.copy.smtp"),
        ],
        [t("settings.apps.password"), t("settings.apps.passwordValue"), null],
      ]
    : [];
  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-lg border border-t-border">
        {rows.map(([label, value, copyLabel]) => (
          <div
            key={label}
            className="flex items-center gap-3 border-b border-t-border-light px-3 py-2 last:border-b-0"
          >
            <span className="w-20 shrink-0 text-[12px] text-t-text-tertiary">
              {label}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-t-text">
              {value}
            </span>
            {copyLabel && (
              <CopyButton value={value.split(",")[0]!} label={copyLabel} />
            )}
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {passwords === null && <Skeleton width="50%" height={12} />}
        {passwords?.map((p) => (
          <div key={p.id} className="flex items-center gap-2 px-1 py-1">
            <IconKey size={14} className="text-t-text-tertiary" />
            <span className="text-t-text">{p.name}</span>
            <span className="flex-1 text-[12px] text-t-text-tertiary">
              {p.last_used_at
                ? t("settings.apps.usedAgo", {
                    when: formatDistanceToNow(new Date(p.last_used_at), {
                      addSuffix: true,
                      locale: dateLocale(),
                    }),
                  })
                : t("settings.apps.neverUsed")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              color="danger"
              onClick={() =>
                void supabase
                  .from("mail_app_passwords")
                  .delete()
                  .eq("id", p.id)
                  .then(load)
              }
            >
              {t("settings.apps.revoke")}
            </Button>
          </div>
        ))}
      </div>
      <form onSubmit={create} className="flex gap-2">
        <Input
          size="sm"
          aria-label={t("settings.apps.deviceName")}
          placeholder={t("settings.apps.devicePlaceholder")}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="max-w-[260px]"
        />
        <Button type="submit" size="sm" variant="outline" loading={creating}>
          {t("settings.apps.create")}
        </Button>
      </form>
      <Dialog.Root
        open={created !== null}
        onOpenChange={(open) => !open && setCreated(null)}
      >
        <Dialog.Portal>
          <Dialog.Backdrop />
          <Dialog.Viewport>
            <Dialog.Popup size="sm">
              <Dialog.Header>
                <Dialog.Title>{t("settings.apps.createdTitle")}</Dialog.Title>
              </Dialog.Header>
              <Dialog.Body className="flex flex-col gap-3">
                <p className="text-t-text-secondary">
                  {t("settings.apps.createdBody")}
                </p>
                <div className="flex items-center gap-2 rounded-md bg-t-tertiary px-3 py-2">
                  <code className="flex-1 font-mono text-[16px] tracking-wider text-t-text">
                    {created}
                  </code>
                  <CopyButton
                    value={created ?? ""}
                    label={t("settings.copy.password")}
                  />
                </div>
              </Dialog.Body>
              <Dialog.Footer>
                <Dialog.Close
                  render={<Button variant="solid" color="accent" />}
                >
                  {tc("done")}
                </Dialog.Close>
              </Dialog.Footer>
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}

export function MailSettings() {
  const { t } = useTranslation("mail");
  const { accounts } = useMailAccounts();
  const [domains, setDomains] = useState<MailDomain[] | null>(null);
  const [server, setServer] = useState<MailServer | null>(null);
  const [hostChecks, setHostChecks] = useState<DnsRecord[] | null>(null);
  const [newDomain, setNewDomain] = useState("");
  const [local, setLocal] = useState("");
  const [domainForAddress, setDomainForAddress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadDomains = useCallback(async () => {
    const { domains } = await api<{ domains: MailDomain[] }>(
      "/api/mail/domains",
    );
    setDomains(domains);
    setDomainForAddress((current) => current || domains[0]?.name || "");
  }, []);
  useEffect(() => {
    void loadDomains();
    void api<MailServer>("/api/mail/server").then(setServer, () => {});
  }, [loadDomains]);

  async function run(what: string, task: () => Promise<unknown>) {
    setBusy(what);
    setError(null);
    try {
      await task();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Page
      title={t("settings.title")}
      icon={
        <IconTile color="blue">
          <IconSettings />
        </IconTile>
      }
      actions={
        <Button
          size="sm"
          variant="ghost"
          startIcon={<IconArrowLeft size={14} />}
          nativeButton={false}
          render={<Link to="/mail" />}
        >
          {t("settings.inbox")}
        </Button>
      }
    >
      <div className="flex-1 overflow-y-auto px-4 py-8">
        <div className="mx-auto flex w-full max-w-[720px] flex-col gap-10">
          {error && (
            <p className="rounded-md bg-[var(--t-color-red3)] px-3 py-2 text-[var(--t-color-red11)]">
              {error}
            </p>
          )}

          <Section
            icon={<IconMail />}
            color="blue"
            title={t("settings.addresses.title")}
            description={t("settings.addresses.description")}
          >
            {accounts === null ? (
              <Loader />
            ) : (
              accounts.map((a) => (
                <AccountRow key={a.id} account={a} domains={domains ?? []} />
              ))
            )}
            {domains && domains.length > 0 && (
              <form
                className="flex flex-wrap items-center gap-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("address", async () => {
                    await api("/api/mail/accounts", {
                      body: { domain: domainForAddress, localPart: local },
                    });
                    setLocal("");
                  });
                }}
              >
                <Input
                  size="sm"
                  aria-label={t("settings.addresses.newAddress")}
                  placeholder="hello"
                  value={local}
                  onChange={(e) => setLocal(e.target.value.toLowerCase())}
                  className="w-40"
                  required
                />
                <span className="text-t-text-tertiary">@</span>
                <SimpleSelect
                  label={t("settings.addresses.domain")}
                  value={domainForAddress}
                  onValueChange={setDomainForAddress}
                  options={domains.map((d) => ({
                    value: d.name,
                    label: d.name,
                  }))}
                  className="w-auto"
                />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  loading={busy === "address"}
                >
                  {t("settings.addresses.add")}
                </Button>
              </form>
            )}
          </Section>

          <Section
            icon={<IconWorld />}
            color="green"
            title={t("settings.domains.title")}
            description={t("settings.domains.description")}
          >
            {domains === null ? (
              <Loader />
            ) : (
              domains.map((d) => (
                <DomainCard
                  key={d.id}
                  domain={d}
                  onChanged={() => void loadDomains()}
                />
              ))
            )}
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void run("domain", async () => {
                  await api("/api/mail/domains", { body: { name: newDomain } });
                  setNewDomain("");
                  await loadDomains();
                });
              }}
            >
              <Input
                size="sm"
                aria-label={t("settings.domains.domain")}
                placeholder="example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                className="max-w-[260px]"
                required
              />
              <Button
                type="submit"
                size="sm"
                variant="outline"
                loading={busy === "domain"}
              >
                {t("settings.domains.add")}
              </Button>
            </form>
          </Section>

          <Section
            icon={<IconKey />}
            color="purple"
            title={t("settings.mailApps.title")}
            description={t("settings.mailApps.description")}
          >
            <AppPasswords server={server} accounts={accounts ?? []} />
          </Section>

          <Section
            icon={<IconServer />}
            color="orange"
            title={t("settings.server.title")}
            description={t("settings.server.description")}
            actions={
              <Button
                size="sm"
                variant="outline"
                loading={busy === "host"}
                startIcon={<IconRefresh size={14} />}
                onClick={() =>
                  void run("host", async () =>
                    setHostChecks(
                      (
                        await api<{ checks: DnsRecord[] }>(
                          "/api/mail/server/check",
                          { method: "POST" },
                        )
                      ).checks,
                    ),
                  )
                }
              >
                {t("settings.server.check")}
              </Button>
            }
          >
            {server ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border border-t-border px-3 py-2.5 text-[13px]">
                  <span className="text-t-text-tertiary">
                    {t("settings.server.hostname")}
                  </span>
                  <span className="font-mono text-t-text">
                    {server.hostname}
                  </span>
                  <span className="text-t-text-tertiary">
                    {t("settings.server.addresses")}
                  </span>
                  <span className="font-mono text-t-text">
                    {server.addresses.join(", ") ||
                      t("settings.server.unknownAddresses")}
                  </span>
                  <span className="text-t-text-tertiary">
                    {t("settings.server.certificate")}
                  </span>
                  <span
                    className={cn(
                      "text-t-text",
                      !server.certificate && "text-[var(--t-color-amber11)]",
                    )}
                  >
                    {server.certificate
                      ? t("settings.server.expires", {
                          issuer: server.certificate.selfSigned
                            ? t("settings.server.selfSigned")
                            : (server.certificate.issuer.match(
                                /CN=([^,]+)/,
                              )?.[1] ?? t("settings.server.issued")),
                          when: formatDistanceToNow(
                            new Date(server.certificate.expiresAt),
                            { addSuffix: true, locale: dateLocale() },
                          ),
                        })
                      : server.tls === "off"
                        ? t("settings.server.tlsOff")
                        : t("settings.server.noCertificate")}
                  </span>
                  <span className="text-t-text-tertiary">
                    {t("settings.server.outgoing")}
                  </span>
                  <span className="text-t-text">
                    {server.relay
                      ? t("settings.server.through", { relay: server.relay })
                      : t("settings.server.direct")}
                  </span>
                </div>
                {(hostChecks ?? server.host).length > 0 && (
                  <div className="overflow-hidden rounded-lg border border-t-border">
                    {(hostChecks ?? server.host).map((record) => (
                      <RecordRow key={record.id} record={record} />
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <Skeleton width="100%" height={80} />
            )}
          </Section>
        </div>
      </div>
    </Page>
  );
}
