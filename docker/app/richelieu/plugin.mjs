// The builder's dev-server plugin:
// - tags each JSX element of the project's sources with `data-rc-loc="path:line:column"`, so an element picked in
//   the preview leads back to the code that renders it;
// - serves and injects `bridge.js`, which talks to the builder around the preview's iframe.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { parseSync } from "vite";

const BRIDGE_PATH = "/__richelieu/bridge.js";
const bridge = readFileSync(new URL("./bridge.js", import.meta.url), "utf8");

/** Offsets where an attribute can go: right after each JSX element's name, before its own props. */
function tagOffsets(program) {
  const offsets = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "JSXOpeningElement") {
      const name = node.name;
      // A fragment takes no props.
      const fragment =
        (name.type === "JSXIdentifier" && name.name === "Fragment") ||
        (name.type === "JSXMemberExpression" &&
          name.property.name === "Fragment");
      if (!fragment && name.type !== "JSXNamespacedName")
        offsets.push({ start: node.start, at: name.end });
    }
    for (const key in node) if (key !== "parent") walk(node[key]);
  };
  walk(program);
  return offsets;
}

export default function richelieu() {
  let root = process.cwd();
  return {
    name: "richelieu",
    enforce: "pre",
    apply: "serve",
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use(BRIDGE_PATH, (_req, res) => {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(bridge);
      });
    },
    transformIndexHtml() {
      return [
        {
          tag: "script",
          attrs: { src: BRIDGE_PATH },
          injectTo: "head-prepend",
        },
      ];
    },
    transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.[jt]sx$/.test(file) || file.includes("/node_modules/")) return;
      let result;
      try {
        result = parseSync(file, code);
      } catch {
        return;
      }
      if (result.errors.length > 0) return;
      const path = relative(root, file);
      // Line starts, to turn offsets into line:column.
      const lines = [0];
      for (let i = 0; i < code.length; i++)
        if (code[i] === "\n") lines.push(i + 1);
      const lineOf = (offset) => {
        let low = 0;
        let high = lines.length - 1;
        while (low < high) {
          const mid = (low + high + 1) >> 1;
          if (lines[mid] <= offset) low = mid;
          else high = mid - 1;
        }
        return low;
      };
      const offsets = tagOffsets(result.program).sort((a, b) => b.at - a.at);
      if (offsets.length === 0) return;
      let out = code;
      for (const { start, at } of offsets) {
        const line = lineOf(start);
        const loc = `${path}:${line + 1}:${start - lines[line] + 1}`;
        out = `${out.slice(0, at)} data-rc-loc="${loc}"${out.slice(at)}`;
      }
      return { code: out, map: null };
    },
  };
}
