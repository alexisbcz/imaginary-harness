// A line-oriented view of a TCP connection, shared by the SMTP and IMAP servers and the SMTP client: read a line,
// a literal of n bytes, or an SMTP DATA block, and upgrade to TLS in place (STARTTLS). Uses node:net and node:tls
// because Bun's own sockets cannot yet become TLS halfway through a connection on the server side.

import type { Socket } from "node:net";
import {
  connect as tlsConnect,
  TLSSocket,
  type ConnectionOptions,
  type SecureContext,
} from "node:tls";

export class ConnectionClosed extends Error {
  constructor() {
    super("The connection closed");
  }
}

export class LineTooLong extends Error {}

export class Connection {
  private buffer: Buffer = Buffer.alloc(0);
  private waiter: (() => void) | undefined;
  private closed = false;
  private socket: Socket;
  private idleTimer: Timer | undefined;
  readonly remoteAddress: string;
  readonly remotePort: number;

  constructor(
    socket: Socket,
    /** Closes a connection silent this long. */
    private idleMs = 5 * 60_000,
  ) {
    this.socket = socket;
    this.remoteAddress = (socket.remoteAddress ?? "").replace(
      /^::ffff:(\d+\.\d+\.\d+\.\d+)$/,
      "$1",
    );
    this.remotePort = socket.remotePort ?? 0;
    this.attach(socket);
  }

  get secure() {
    return this.socket instanceof TLSSocket;
  }

  get tlsProtocol(): string | undefined {
    return this.socket instanceof TLSSocket
      ? (this.socket.getProtocol() ?? undefined)
      : undefined;
  }

  get tlsCipher(): string | undefined {
    return this.socket instanceof TLSSocket
      ? this.socket.getCipher()?.name
      : undefined;
  }

  get isClosed() {
    return this.closed;
  }

  setIdle(ms: number) {
    this.idleMs = ms;
    this.touch();
  }

  private touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), this.idleMs);
  }

  private attach(socket: Socket) {
    this.touch();
    socket.on("data", (chunk: Buffer) => {
      this.buffer = this.buffer.length
        ? Buffer.concat([this.buffer, chunk])
        : chunk;
      this.touch();
      this.wake();
    });
    const end = () => {
      this.closed = true;
      clearTimeout(this.idleTimer);
      this.wake();
    };
    socket.on("end", end);
    socket.on("close", end);
    socket.on("error", end);
  }

  private wake() {
    const waiter = this.waiter;
    this.waiter = undefined;
    waiter?.();
  }

  private async more(): Promise<void> {
    if (this.closed) throw new ConnectionClosed();
    await new Promise<void>((resolve) => (this.waiter = resolve));
  }

  /** Whether bytes the peer sent are waiting: after STARTTLS, any would be an injection attack. */
  get hasBuffered() {
    return this.buffer.length > 0;
  }

  /** The next line, without its line end; LF alone ends a line too. */
  async readLine(maxLength = 16_384): Promise<string> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline !== -1) {
        const line = this.buffer.subarray(
          0,
          newline > 0 && this.buffer[newline - 1] === 0x0d
            ? newline - 1
            : newline,
        );
        this.buffer = this.buffer.subarray(newline + 1);
        if (line.length > maxLength)
          throw new LineTooLong(`Line longer than ${maxLength} bytes`);
        return line.toString("latin1");
      }
      if (this.buffer.length > maxLength) {
        this.buffer = Buffer.alloc(0);
        throw new LineTooLong(`Line longer than ${maxLength} bytes`);
      }
      await this.more();
    }
  }

  /** Exactly `count` bytes: an IMAP literal. */
  async readBytes(count: number): Promise<Uint8Array> {
    while (this.buffer.length < count) await this.more();
    const bytes = new Uint8Array(this.buffer.subarray(0, count));
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  /**
   * An SMTP DATA block up to the lone `.` line, dot-unstuffed, with CRLF line ends. Returns `undefined` when it
   * outgrew `maxSize`; the block is still read to its end, so the session can go on.
   */
  async readData(maxSize: number): Promise<Uint8Array | undefined> {
    const parts: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline === -1) {
        if (this.buffer.length > 1_000_000) {
          // A very long line: keep it, without waiting for its end.
          if (!tooBig) parts.push(this.buffer);
          size += this.buffer.length;
          this.buffer = Buffer.alloc(0);
        }
        await this.more();
        continue;
      }
      let line = this.buffer.subarray(0, newline + 1);
      this.buffer = this.buffer.subarray(newline + 1);
      const content = line.subarray(
        0,
        line.length -
          (line.length > 1 && line[line.length - 2] === 0x0d ? 2 : 1),
      );
      if (content.length === 1 && content[0] === 0x2e) break;
      if (content[0] === 0x2e) line = line.subarray(1);
      // Normalize the line end to CRLF.
      const normalized =
        line[line.length - 2] === 0x0d
          ? line
          : Buffer.concat([
              line.subarray(0, line.length - 1),
              Buffer.from("\r\n"),
            ]);
      size += normalized.length;
      if (size > maxSize) tooBig = true;
      if (!tooBig) parts.push(normalized);
    }
    return tooBig ? undefined : new Uint8Array(Buffer.concat(parts));
  }

  write(data: string | Uint8Array) {
    if (this.closed) return;
    this.socket.write(
      typeof data === "string" ? Buffer.from(data, "latin1") : data,
    );
  }

  /** Writes and waits until the bytes are handed to the kernel, for large responses. */
  async writeAsync(data: string | Uint8Array) {
    if (this.closed) return;
    const ok = this.socket.write(
      typeof data === "string" ? Buffer.from(data, "latin1") : data,
    );
    if (!ok)
      await new Promise<void>((resolve) => this.socket.once("drain", resolve));
  }

  /** Becomes the server side of a TLS session over the same connection. */
  async upgradeServer(secureContext: SecureContext): Promise<void> {
    this.buffer = Buffer.alloc(0);
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("end");
    raw.removeAllListeners("close");
    const secure = new TLSSocket(raw, { isServer: true, secureContext });
    await new Promise<void>((resolve, reject) => {
      secure.once("secure", resolve);
      secure.once("error", reject);
    });
    this.socket = secure;
    this.attach(secure);
  }

  /** Becomes the client side of a TLS session over the same connection. */
  async upgradeClient(options: ConnectionOptions): Promise<void> {
    this.buffer = Buffer.alloc(0);
    const raw = this.socket;
    raw.removeAllListeners("data");
    raw.removeAllListeners("end");
    raw.removeAllListeners("close");
    const secure = await new Promise<TLSSocket>((resolve, reject) => {
      const socket = tlsConnect({ ...options, socket: raw }, () =>
        resolve(socket),
      );
      socket.once("error", reject);
    });
    this.socket = secure;
    this.attach(secure);
  }

  /** Whether the peer's certificate checked out, after `upgradeClient` with `rejectUnauthorized: false`. */
  get peerVerified(): boolean {
    return this.socket instanceof TLSSocket && this.socket.authorized;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 1000).unref?.();
    this.wake();
  }
}
