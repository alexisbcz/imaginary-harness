// A minimal ustar writer: enough to hand files to `docker cp -`, owned by the container's user, with none of the
// metadata files a host's own tar would add.

const BLOCK = 512;
const encoder = new TextEncoder();

function octal(value: number, length: number) {
  return value.toString(8).padStart(length - 1, "0") + "\0";
}

function header(path: string, size: number, uid: number, gid: number) {
  const block = new Uint8Array(BLOCK);
  let name = path;
  let prefix = "";
  if (encoder.encode(name).length > 100) {
    // Split at a slash: up to 155 bytes of prefix, up to 100 of name.
    const cut = path.lastIndexOf("/", 155);
    if (cut <= 0 || encoder.encode(path.slice(cut + 1)).length > 100)
      throw new Error(`Path too long for the archive: ${path}`);
    prefix = path.slice(0, cut);
    name = path.slice(cut + 1);
  }
  const write = (text: string, offset: number) =>
    block.set(encoder.encode(text), offset);
  write(name, 0);
  write(octal(0o644, 8), 100);
  write(octal(uid, 8), 108);
  write(octal(gid, 8), 116);
  write(octal(size, 12), 124);
  write(octal(Math.floor(Date.now() / 1000), 12), 136);
  write("        ", 148); // checksum placeholder: spaces
  write("0", 156); // regular file
  write("ustar\0", 257);
  write("00", 263);
  write(prefix, 345);
  let sum = 0;
  for (const byte of block) sum += byte;
  write(octal(sum, 7) + " ", 148);
  return block;
}

/** A tar archive of text files, each owned by `uid:gid`. Directories are implied by the paths. */
export function tar(
  files: Record<string, string>,
  { uid = 1000, gid = 1000 } = {},
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [path, contents] of Object.entries(files)) {
    const data = encoder.encode(contents);
    parts.push(header(path, data.length, uid, gid), data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) parts.push(new Uint8Array(padding));
  }
  parts.push(new Uint8Array(BLOCK * 2));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
