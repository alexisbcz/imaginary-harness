// The SMTP server (RFC 5321), in two roles:
// - `mx` on port 25 receives mail from the internet for the server's domains, with STARTTLS, and relays nothing;
// - `submission` on ports 587 (STARTTLS) and 465 (implicit TLS) takes mail from signed-in clients to send anywhere.
// What happens to a message is the handler's business; the server speaks the protocol and guards the door.

import {
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import { createServer as createTlsServer, type SecureContext } from "node:tls";
import { isAddress } from "../mime/address.ts";
import {
  Connection,
  ConnectionClosed,
  LineTooLong,
} from "../net/connection.ts";

export type SmtpMode = "mx" | "submission";

export type SmtpSession = {
  id: string;
  mode: SmtpMode;
  remoteAddress: string;
  helo: string;
  secure: boolean;
  tlsProtocol?: string;
  tlsCipher?: string;
  /** The signed-in user, on submission. */
  login?: { address: string; accountId: string };
};

export type Envelope = { from: string; to: string[]; smtputf8: boolean };

export type Reply = { code: number; message: string };

export interface SmtpHandler {
  /** Whether to accept a recipient. `mx` accepts only local ones; `submission` any well-formed one. */
  recipient(
    session: SmtpSession,
    address: string,
    envelope: Envelope,
  ): Promise<Reply | undefined>;
  /** Takes the message; the reply is the server's final answer to DATA. */
  message(
    session: SmtpSession,
    envelope: Envelope,
    data: Uint8Array,
  ): Promise<Reply>;
  /** Checks a client's credentials (submission). */
  login(
    username: string,
    password: string,
    session: SmtpSession,
  ): Promise<{ address: string; accountId: string } | undefined>;
  /** Refuses a connection before the greeting, for example from an address that keeps failing. */
  connect?(remoteAddress: string, mode: SmtpMode): Reply | undefined;
}

export type SmtpServerOptions = {
  hostname: string;
  maxSize: number;
  handler: SmtpHandler;
  tls: () => SecureContext | undefined;
  log?: (line: string) => void;
};

const MAX_RECIPIENTS = 100;
const MAX_ERRORS = 10;
const MAX_COMMAND = 4096;

/** `<a@b> SIZE=10 BODY=8BITMIME` → the address and its parameters. */
export function parsePath(
  argument: string,
  keyword: "FROM" | "TO",
): { address: string; params: Record<string, string> } | undefined {
  const match = argument.match(
    new RegExp(`^${keyword}:\\s*<([^>]*)>(.*)$`, "i"),
  );
  if (!match) return undefined;
  // Source routes (`<@a,@b:user@c>`) are obsolete: keep the mailbox.
  const address = match[1]!.replace(/^@[^:]+:/, "").trim();
  const params: Record<string, string> = {};
  for (const param of match[2]!.trim().split(/\s+/).filter(Boolean)) {
    const [key, value = ""] = param.split("=");
    params[key!.toUpperCase()] = value;
  }
  return { address, params };
}

class SmtpConnection {
  private session: SmtpSession;
  private envelope: Envelope | undefined;
  private errors = 0;
  private authFailures = 0;

  constructor(
    private readonly connection: Connection,
    private readonly options: SmtpServerOptions,
    mode: SmtpMode,
  ) {
    this.session = {
      id: crypto.randomUUID().slice(0, 13).replace(/-/g, ""),
      mode,
      remoteAddress: connection.remoteAddress,
      helo: "",
      secure: connection.secure,
    };
  }

  private reply(code: number, message: string) {
    const lines = message.split("\n");
    this.connection.write(
      lines
        .map(
          (line, i) =>
            `${code}${i === lines.length - 1 ? " " : "-"}${line}\r\n`,
        )
        .join(""),
    );
  }

  private fail(code: number, message: string) {
    this.reply(code, message);
    if (++this.errors >= MAX_ERRORS) {
      this.reply(421, "4.7.0 Too many errors, closing");
      this.connection.close();
    }
  }

  private extensions(): string[] {
    const { mode, secure } = this.session;
    const canTls = !secure && this.options.tls() !== undefined;
    return [
      "PIPELINING",
      `SIZE ${this.options.maxSize}`,
      "8BITMIME",
      "SMTPUTF8",
      "ENHANCEDSTATUSCODES",
      ...(canTls ? ["STARTTLS"] : []),
      // Credentials only travel encrypted.
      ...(mode === "submission" && secure ? ["AUTH PLAIN LOGIN"] : []),
    ];
  }

  async run() {
    const refused = this.options.handler.connect?.(
      this.session.remoteAddress,
      this.session.mode,
    );
    if (refused) {
      this.reply(refused.code, refused.message);
      this.connection.close();
      return;
    }
    this.reply(220, `${this.options.hostname} ESMTP Richelieu ready`);
    try {
      while (!this.connection.isClosed) {
        const line = await this.connection.readLine(MAX_COMMAND);
        const [verb = "", ...rest] = line.split(" ");
        const argument = rest.join(" ").trim();
        await this.command(verb.toUpperCase(), argument);
      }
    } catch (error) {
      if (error instanceof LineTooLong) {
        this.reply(500, "5.5.2 Line too long");
        this.connection.close();
      } else if (!(error instanceof ConnectionClosed)) {
        this.options.log?.(
          `[smtp ${this.session.id}] ${error instanceof Error ? error.message : error}`,
        );
        this.reply(421, "4.3.0 Internal error, try again later");
        this.connection.close();
      }
    }
  }

  private async command(verb: string, argument: string) {
    const { session } = this;
    switch (verb) {
      case "EHLO":
      case "HELO": {
        if (!argument) return this.fail(501, "5.5.4 Give your hostname");
        session.helo = argument.split(" ")[0]!;
        this.envelope = undefined;
        if (verb === "HELO") return this.reply(250, this.options.hostname);
        return this.reply(
          250,
          [
            `${this.options.hostname} greets ${session.helo}`,
            ...this.extensions(),
          ].join("\n"),
        );
      }
      case "STARTTLS": {
        const context = this.options.tls();
        if (session.secure || !context)
          return this.fail(454, "4.7.0 TLS not available");
        // Commands pipelined after STARTTLS would run as if encrypted: refuse them (CVE-2011-0411).
        if (this.connection.hasBuffered) {
          this.reply(554, "5.5.1 Commands sent after STARTTLS");
          return this.connection.close();
        }
        this.reply(220, "2.0.0 Ready to start TLS");
        try {
          await this.connection.upgradeServer(context);
        } catch {
          return this.connection.close();
        }
        // A new session starts on the encrypted channel: the client says EHLO again.
        Object.assign(session, {
          helo: "",
          secure: true,
          tlsProtocol: this.connection.tlsProtocol,
          tlsCipher: this.connection.tlsCipher,
        });
        this.envelope = undefined;
        return;
      }
      case "AUTH":
        return this.auth(argument);
      case "MAIL": {
        if (!session.helo) return this.fail(503, "5.5.1 Say EHLO first");
        if (this.envelope)
          return this.fail(503, "5.5.1 Already in a transaction");
        if (session.mode === "submission" && !session.login)
          return this.fail(
            530,
            session.secure
              ? "5.7.0 Sign in first"
              : "5.7.0 Use STARTTLS, then sign in",
          );
        const path = parsePath(argument, "FROM");
        if (!path) return this.fail(501, "5.5.4 Syntax: MAIL FROM:<address>");
        if (path.address && !isAddress(path.address))
          return this.fail(553, "5.1.7 Bad sender address");
        const size = Number(path.params.SIZE ?? 0);
        if (size > this.options.maxSize)
          return this.fail(
            552,
            `5.3.4 Messages are limited to ${this.options.maxSize} bytes`,
          );
        this.envelope = {
          from: path.address,
          to: [],
          smtputf8: "SMTPUTF8" in path.params,
        };
        return this.reply(250, "2.1.0 Sender OK");
      }
      case "RCPT": {
        if (!this.envelope) return this.fail(503, "5.5.1 MAIL first");
        if (this.envelope.to.length >= MAX_RECIPIENTS)
          return this.fail(452, "4.5.3 Too many recipients");
        const path = parsePath(argument, "TO");
        if (!path || !isAddress(path.address))
          return this.fail(501, "5.1.3 Syntax: RCPT TO:<address>");
        const refused = await this.options.handler.recipient(
          session,
          path.address,
          this.envelope,
        );
        if (refused) return this.fail(refused.code, refused.message);
        if (!this.envelope.to.includes(path.address))
          this.envelope.to.push(path.address);
        return this.reply(250, "2.1.5 Recipient OK");
      }
      case "DATA": {
        if (!this.envelope) return this.fail(503, "5.5.1 MAIL first");
        if (this.envelope.to.length === 0)
          return this.fail(554, "5.5.1 No valid recipients");
        this.reply(354, "End data with <CR><LF>.<CR><LF>");
        const data = await this.connection.readData(this.options.maxSize);
        const envelope = this.envelope;
        this.envelope = undefined;
        if (!data)
          return this.reply(
            552,
            `5.3.4 Messages are limited to ${this.options.maxSize} bytes`,
          );
        const result = await this.options.handler.message(
          session,
          envelope,
          data,
        );
        return this.reply(result.code, result.message);
      }
      case "RSET":
        this.envelope = undefined;
        return this.reply(250, "2.0.0 OK");
      case "NOOP":
        return this.reply(250, "2.0.0 OK");
      case "VRFY":
        return this.reply(252, "2.5.0 Cannot verify, but will try delivery");
      case "HELP":
        return this.reply(214, "2.0.0 See RFC 5321");
      case "QUIT":
        this.reply(221, "2.0.0 Bye");
        return this.connection.close();
      default:
        return this.fail(502, "5.5.2 Command not recognized");
    }
  }

  private async auth(argument: string) {
    const { session } = this;
    if (session.mode !== "submission")
      return this.fail(502, "5.5.1 AUTH is not offered here; use port 587");
    if (!session.secure)
      return this.fail(538, "5.7.11 Encryption required: use STARTTLS first");
    if (session.login) return this.fail(503, "5.5.1 Already signed in");
    const [mechanism = "", initial] = argument.split(" ");
    let username: string;
    let password: string;
    const decode = (value: string) =>
      Buffer.from(value, "base64").toString("utf8");
    const ask = async (prompt: string) => {
      this.reply(334, prompt);
      const answer = await this.connection.readLine();
      if (answer === "*") throw new Error("cancelled");
      return answer;
    };
    try {
      if (mechanism.toUpperCase() === "PLAIN") {
        const response = initial && initial !== "=" ? initial : await ask("");
        const [, user = "", pass = ""] = decode(response).split("\0");
        username = user;
        password = pass;
      } else if (mechanism.toUpperCase() === "LOGIN") {
        username = decode(
          initial ?? (await ask(Buffer.from("Username:").toString("base64"))),
        );
        password = decode(
          await ask(Buffer.from("Password:").toString("base64")),
        );
      } else return this.fail(504, "5.5.4 Use AUTH PLAIN or AUTH LOGIN");
    } catch {
      return this.fail(501, "5.0.0 Authentication cancelled");
    }
    const login = await this.options.handler.login(username, password, session);
    if (!login) {
      this.authFailures++;
      // Slow down guessing, and hang up on persistent guessers.
      await Bun.sleep(Math.min(5000, 500 * 2 ** this.authFailures));
      if (this.authFailures >= 3) {
        this.reply(421, "4.7.0 Too many failed attempts");
        return this.connection.close();
      }
      return this.fail(535, "5.7.8 Wrong address or app password");
    }
    session.login = login;
    this.options.log?.(
      `[smtp ${session.id}] ${login.address} signed in from ${session.remoteAddress}`,
    );
    return this.reply(235, "2.7.0 Signed in");
  }
}

export type SmtpListener = {
  mode: SmtpMode;
  port: number;
  host: string;
  implicitTls?: boolean;
};

/** Starts one listener; resolves once it listens. */
export function listenSmtp(
  listener: SmtpListener,
  options: SmtpServerOptions,
): Promise<Server> {
  const handle = (socket: Socket) => {
    socket.setNoDelay(true);
    const connection = new Connection(socket);
    void new SmtpConnection(connection, options, listener.mode).run();
  };
  const server = listener.implicitTls
    ? createTlsServer(
        { SNICallback: (_name, callback) => callback(null, options.tls()) },
        handle,
      )
    : createTcpServer(handle);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listener.port, listener.host, () => resolve(server));
  });
}
