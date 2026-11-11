import { describe, expect, it } from "bun:test";
import { checkDmarc, organizationalDomain } from "../auth/dmarc.ts";
import { generateDkimKey, signMessage, verifyDkim } from "../auth/dkim.ts";
import { staticResolver } from "../auth/dns.ts";
import { inRange } from "../auth/ip.ts";
import { checkSpf } from "../auth/spf.ts";
import { buildMessage } from "../mime/build.ts";

describe("ip ranges", () => {
  it("matches IPv4 and IPv6 networks", () => {
    expect(inRange("192.0.2.10", "192.0.2.0", 24)).toBe(true);
    expect(inRange("192.0.3.10", "192.0.2.0", 24)).toBe(false);
    expect(inRange("::ffff:192.0.2.10", "192.0.2.10")).toBe(true);
    expect(inRange("2001:db8::1", "2001:db8::", 32)).toBe(true);
    expect(inRange("2001:db9::1", "2001:db8::", 32)).toBe(false);
    expect(inRange("192.0.2.1", "2001:db8::", 0)).toBe(false);
  });
});

describe("spf", () => {
  const resolver = staticResolver({
    "TXT example.com": [
      "v=spf1 ip4:192.0.2.0/24 include:_spf.example.net mx -all",
      "unrelated",
    ],
    "TXT _spf.example.net": ["v=spf1 ip6:2001:db8::/32 ~all"],
    "MX example.com": [{ exchange: "mx.example.com", priority: 10 }],
    "A mx.example.com": ["198.51.100.7"],
    "TXT soft.example": ["v=spf1 a:mail.soft.example ~all"],
    "A mail.soft.example": ["203.0.113.5"],
    "TXT loop.example": ["v=spf1 include:loop.example -all"],
    "TXT redirect.example": ["v=spf1 redirect=example.com"],
    "TXT broken.example": ["TEMPFAIL"],
    "TXT macro.example": ["v=spf1 exists:%{i}.allow.macro.example -all"],
    "A 192.0.2.99.allow.macro.example": ["127.0.0.2"],
  });
  const check = (ip: string, sender: string) =>
    checkSpf({ resolver, ip, sender, helo: "client.test" });

  it("passes listed networks, includes and MX hosts", async () => {
    expect((await check("192.0.2.44", "a@example.com")).result).toBe("pass");
    expect((await check("198.51.100.7", "a@example.com")).result).toBe("pass");
    // The include softfails, which is not a match: the outer -all decides.
    expect((await check("2001:db9::1", "a@example.com")).result).toBe("fail");
    expect((await check("2001:db8::25", "a@example.com")).result).toBe("pass");
  });

  it("reports softfail, none, redirects, macros and errors", async () => {
    expect((await check("203.0.113.9", "x@soft.example")).result).toBe(
      "softfail",
    );
    expect((await check("203.0.113.5", "x@soft.example")).result).toBe("pass");
    expect((await check("192.0.2.1", "x@nothing.example")).result).toBe("none");
    expect((await check("192.0.2.1", "x@redirect.example")).result).toBe(
      "pass",
    );
    expect((await check("192.0.2.99", "x@macro.example")).result).toBe("pass");
    expect((await check("192.0.2.98", "x@macro.example")).result).toBe("fail");
    expect((await check("192.0.2.1", "x@loop.example")).result).toBe(
      "permerror",
    );
    expect((await check("192.0.2.1", "x@broken.example")).result).toBe(
      "temperror",
    );
  });
});

describe("dkim", () => {
  for (const algorithm of ["rsa-sha256", "ed25519-sha256"] as const) {
    it(`signs and verifies with ${algorithm}`, async () => {
      const key = generateDkimKey(algorithm);
      const resolver = staticResolver({
        "TXT mail._domainkey.example.com": [key.dnsValue],
      });
      const { raw } = buildMessage({
        from: { name: "Ada", address: "ada@example.com" },
        to: [{ name: "", address: "bob@example.org" }],
        subject: "Signed  and   spaced",
        text: "Body line   with spaces   \n\n\n",
      });
      const signed = signMessage(raw, {
        domain: "example.com",
        selector: "mail",
        privateKey: key.privateKey,
      });
      for (const line of signed.split("\r\n").slice(0, 6))
        expect(line.length).toBeLessThanOrEqual(80);
      expect(await verifyDkim(signed, resolver)).toMatchObject([
        { result: "pass", domain: "example.com" },
      ]);

      // Relaxed canonicalization survives whitespace changes in transit...
      const rewhitespaced = signed.replace(
        "Subject: Signed  and   spaced",
        "Subject:   Signed and spaced",
      );
      expect((await verifyDkim(rewhitespaced, resolver))[0]!.result).toBe(
        "pass",
      );
      // ...but not a changed word, nor a changed body.
      expect(
        (await verifyDkim(signed.replace("Signed", "Changed"), resolver))[0]!
          .result,
      ).toBe("fail");
      expect(
        (
          await verifyDkim(signed.replace("Body line", "Body lime"), resolver)
        )[0],
      ).toMatchObject({
        result: "fail",
        reason: "the body hash does not match",
      });
      // A second From, added after signing, breaks the signature.
      expect(
        (
          await verifyDkim(`From: evil@attacker.test\r\n${signed}`, resolver)
        )[0]!.result,
      ).toBe("fail");
    });
  }

  it("reports unsigned messages and missing keys", async () => {
    const resolver = staticResolver({});
    expect(await verifyDkim("From: a@b.c\r\n\r\nhi", resolver)).toEqual([
      { result: "none" },
    ]);
    const key = generateDkimKey();
    const signed = signMessage("From: a@b.c\r\nSubject: x\r\n\r\nhi\r\n", {
      domain: "b.c",
      selector: "gone",
      privateKey: key.privateKey,
    });
    expect((await verifyDkim(signed, resolver))[0]!.result).toBe("permerror");
  });
});

describe("dmarc", () => {
  it("finds the organizational domain", () => {
    expect(organizationalDomain("mail.eu.example.com")).toBe("example.com");
    expect(organizationalDomain("shop.example.co.uk")).toBe("example.co.uk");
  });

  const resolver = staticResolver({
    "TXT _dmarc.example.com": [
      "v=DMARC1; p=reject; sp=quarantine; adkim=s; pct=100",
    ],
  });
  const spfPass = {
    result: "pass" as const,
    domain: "bounces.example.com",
    reason: "",
  };
  const spfFail = {
    result: "fail" as const,
    domain: "example.com",
    reason: "",
  };

  it("passes on aligned SPF or DKIM, with the alignment modes", async () => {
    // SPF is relaxed by default: a subdomain of the From domain aligns.
    expect(
      await checkDmarc({
        resolver,
        fromDomain: "example.com",
        spf: spfPass,
        dkim: [],
      }),
    ).toMatchObject({ result: "pass", spfAligned: true });
    // DKIM is strict here: a subdomain signature does not align.
    const sub = await checkDmarc({
      resolver,
      fromDomain: "example.com",
      spf: spfFail,
      dkim: [{ result: "pass", domain: "mail.example.com" }],
    });
    expect(sub).toMatchObject({
      result: "fail",
      policy: "reject",
      dkimAligned: false,
    });
    const exact = await checkDmarc({
      resolver,
      fromDomain: "example.com",
      spf: spfFail,
      dkim: [{ result: "pass", domain: "example.com" }],
    });
    expect(exact.result).toBe("pass");
  });

  it("applies the subdomain policy and reports a missing record", async () => {
    expect(
      await checkDmarc({
        resolver,
        fromDomain: "news.example.com",
        spf: spfFail,
        dkim: [],
      }),
    ).toMatchObject({ result: "fail", policy: "quarantine" });
    expect(
      (
        await checkDmarc({
          resolver,
          fromDomain: "other.test",
          spf: spfFail,
          dkim: [],
        })
      ).result,
    ).toBe("none");
  });
});
