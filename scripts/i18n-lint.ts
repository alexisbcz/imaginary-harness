// Finds text in the web app that a person would read and that is not translated: JSX text, the attributes people
// read (placeholder, title, aria-label, alt, label, tooltip…), strings shown from JSX expressions, labels in config
// objects, and error messages. Every one of them belongs in src/web/locales and goes through t().
//
//   bun run i18n:lint            list the strings, exit 1 when there are any
//   bun run i18n:lint --json     the same, as JSON
//
// It ignores what is code rather than text (class names, ids, keys, URLs, comparisons, imports…), strings made only
// of brand names and technical names (BRANDS), and any line carrying `i18n-ignore` (on it, or on the line before it)
// for a deliberate exception.

import { parse } from "@babel/parser";
import _traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

const traverse = ((_traverse as unknown as { default?: typeof _traverse }).default ?? _traverse) as typeof _traverse;

const ROOT = new URL("../src/web/", import.meta.url).pathname;
const SKIP_FILES = [/\/locales\//, /\.test\.tsx?$/, /\.d\.ts$/];

/** Names that stay as they are in every language: brands, products, technical names. */
export const BRANDS = [
  "Richelieu", "Substack", "TikTok", "LinkedIn", "Instagram", "Threads", "Facebook", "YouTube", "Pinterest", "Bluesky",
  "X", "Twitter", "Zernio", "ScrapeCreators", "Supabase", "Postgres", "PostgreSQL", "GitHub", "Google", "Gmail",
  "Outlook", "Apple", "iCloud", "Vercel", "Docker", "Bun", "React", "Vite", "Tailwind", "shadcn", "Pierre", "Twenty",
  "Markdown", "Claude", "Anthropic", "Notes", "MCP", "SQL", "SMTP", "IMAP", "DKIM", "SPF", "DMARC", "MTA-STS", "DNS",
  "MX", "TXT", "CNAME", "PTR", "TLS", "ACME", "HTML", "CSS", "CSV", "JSON", "API", "URL", "HTTP", "HTTPS", "UUID",
  "PNG", "JPEG", "GIF", "WebP", "PDF", "ZIP", "KB", "MB", "GB", "AI", "OK", "Cc", "Bcc", "UTC", "ARR",
];

/** JSX attributes people read. */
const TEXT_ATTRIBUTES = new Set([
  "placeholder", "title", "alt", "label", "tooltip", "description", "hint", "summary", "caption", "message",
  "aria-label", "aria-description", "aria-placeholder", "aria-roledescription", "aria-valuetext", "submit",
  "emptyText", "heading", "subtitle", "text",
]);

/** JSX attributes that hold code, never text. */
const CODE_ATTRIBUTES = /^(className|class|style|key|id|type|role|href|src|srcSet|to|rel|target|name|htmlFor|as|variant|size|color|align|side|sideOffset|mode|method|encType|autoComplete|inputMode|accept|lang|dir|form|d|viewBox|fill|stroke|xmlns|value|defaultValue|orientation|shape|face|placement|loading|decoding|referrerPolicy|sandbox|allow|pattern|min|max|step|list|data-.*|aria-(hidden|pressed|expanded|current|live|selected|checked|controls|labelledby|describedby|haspopup|level|sort|orientation|valuemin|valuemax|valuenow|invalid|disabled|busy|modal|atomic|relevant|owns|activedescendant|colcount|rowcount|colindex|rowindex|setsize|posinset|multiselectable|readonly|required))$/;

/** Object properties whose string values people read. */
const TEXT_PROPERTIES = new Set([
  "label", "title", "description", "hint", "placeholder", "message", "summary", "tooltip", "heading", "subtitle",
  "running", "done", "error", "caption", "emptyText", "help", "detail",
]);

/** Calls whose string arguments are code, keys or debugging, not text. */
const CODE_CALLEES = /^(t|i18n\.t|console\.\w+|cn|cva|clsx|twMerge|require|fetch|api|URL|URLSearchParams|RegExp|Symbol|Intl\.\w+|JSON\.\w+|Date|document\.\w+|window\.\w+|localStorage\.\w+|sessionStorage\.\w+|\w+\.(from|select|eq|neq|in|is|order|channel|on|rpc|insert|update|upsert|delete|match|filter|or|not|like|ilike|contains|limit|range|single|maybeSingle|storage|getItem|setItem|removeItem|querySelector|querySelectorAll|getElementById|closest|matches|addEventListener|removeEventListener|dispatchEvent|setAttribute|getAttribute|removeAttribute|hasAttribute|startsWith|endsWith|includes|indexOf|lastIndexOf|split|replace|replaceAll|padStart|padEnd|join|test|exec|search|localeCompare|toLocaleString|toLocaleDateString|toLocaleTimeString|get|set|has|getAll|append|navigate|createElement|postMessage|toDataURL|toBlob|getContext|matchMedia|isActive|getAttributes|setNode|toggleNode|setMark|unsetMark|toggleMark|command|commands\.\w+|chain|run|format|parse)|navigate|useLoad|useNavigate|useParams|useSearchParams|useState|useRef|useMemo|useCallback|createContext|createClient|createPortal|setTimeout|setInterval|encodeURIComponent|decodeURIComponent|btoa|atob|Number|String|Boolean|parseInt|parseFloat|structuredClone|crypto\.\w+|Bun\.\w+|import|format|formatDistance|formatDistanceToNow|parseISO|isValid|Promise\.\w+|Object\.\w+|Array\.\w+|Math\.\w+|new\s+\w+)$/;

type Finding = { file: string; line: number; column: number; text: string; where: string };

const brandPattern = new RegExp(
  `\\b(${BRANDS.map((b) => b.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&")).join("|")})\\b`,
  "g",
);

/** Whether a string reads as words a person would see, rather than code. */
export function looksLikeText(raw: string): boolean {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return false;
  // Brands, numbers, punctuation and symbols only: nothing to translate.
  const rest = text.replace(brandPattern, " ").replace(/[\d\s\p{P}\p{S}]/gu, "");
  if (!/\p{L}{2,}/u.test(rest)) return false;
  // URLs, paths, emails, mime types, file names.
  if (/^(https?:|mailto:|tel:|data:|blob:|\/|\.\/|#|%%|\{\{)/.test(text)) return false;
  if (/^[\w.+-]+@[\w.-]+$/.test(text) || /^[a-z]+\/[\w.+-]+$/i.test(text) || /^[\w-]+\.[a-z0-9]{2,5}$/i.test(text)) return false;
  // A single token in code style: snake_case, kebab-case, camelCase, dotted keys, ALL_CAPS, lowercase words.
  if (!/\s/.test(text)) {
    if (/^[a-z][a-z0-9]*([_.:-][a-z0-9]+)*$/.test(text)) return false;
    if (/^[a-z]+([A-Z][a-z0-9]*)+$/.test(text)) return false;
    if (/^[A-Z0-9_]+$/.test(text) && text.length > 1) return false;
    if (/[{}()[\]=<>;$\\|`^]/.test(text)) return false;
  }
  // Class lists: every token like a utility class.
  const tokens = text.split(" ");
  if (tokens.every((token) => /^[!a-z0-9@_[\]\/.%#:(),=&>*~+-]+$/.test(token)) && tokens.some((token) => /[-:\[]/.test(token)))
    return false;
  // Developers' invariants (a hook used outside its provider): never shown to people.
  if (/\buse[A-Z]\w* must be used within\b/.test(text)) return false;
  // Font stacks, CSS values, selectors, SQL keywords, key combos.
  if (/(serif|sans-serif|monospace|system-ui)\s*$/.test(text) && text.includes(",")) return false;
  if (/^(\d|var\(|calc\(|rgba?\(|hsla?\(|oklch\(|linear-gradient|\.|\[|&|@media)/.test(text)) return false;
  if (/^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|ALTER|DROP)\b/.test(text)) return false;
  if (/^(Mod|Ctrl|Cmd|Shift|Alt|Meta)(-|\+)/.test(text)) return false;
  return true;
}

function calleeName(node: t.Node): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
    const property = node.property.type === "Identifier" ? node.property.name : "?";
    return `${calleeName(node.object)}.${property}`;
  }
  if (node.type === "CallExpression" || node.type === "OptionalCallExpression") return calleeName(node.callee);
  if (node.type === "ThisExpression") return "this";
  return "?";
}

/** Why a string literal at this place is code, or null when people read it. */
function codeContext(path: NodePath): string | null {
  let child: NodePath = path;
  let parent = path.parentPath;
  // Walk up through expressions that pass a value through unchanged.
  while (
    parent &&
    (parent.isConditionalExpression() ||
      parent.isLogicalExpression() ||
      parent.isTSAsExpression() ||
      parent.isTSSatisfiesExpression() ||
      parent.isParenthesizedExpression() ||
      parent.isTemplateLiteral() ||
      (parent.isBinaryExpression() && parent.node.operator === "+") ||
      parent.isSequenceExpression() ||
      parent.isArrayExpression() ||
      parent.isSpreadElement())
  ) {
    if (parent.isConditionalExpression() && child.node === parent.node.test) return "condition";
    child = parent;
    parent = parent.parentPath;
  }
  if (!parent) return "top";
  const node = parent.node;
  if (parent.isImportDeclaration() || parent.isExportAllDeclaration() || parent.isExportNamedDeclaration()) return "import";
  if (parent.isImportExpression?.()) return "import";
  if (parent.isTSLiteralType() || parent.isTSEnumMember() || parent.isTSPropertySignature()) return "type";
  if (parent.isBinaryExpression() || parent.isSwitchCase()) return "comparison";
  if (parent.isMemberExpression() || parent.isOptionalMemberExpression()) return "member key";
  if (parent.isObjectProperty() && (node as t.ObjectProperty).key === child.node) return "object key";
  if (parent.isObjectProperty()) {
    const key = (node as t.ObjectProperty).key;
    const name = key.type === "Identifier" ? key.name : key.type === "StringLiteral" ? key.value : "";
    return TEXT_PROPERTIES.has(name) ? null : "object value";
  }
  if (parent.isJSXAttribute() || parent.isJSXExpressionContainer()) {
    const attribute = parent.isJSXAttribute() ? parent : parent.parentPath?.isJSXAttribute() ? parent.parentPath : null;
    if (attribute) {
      const raw = (attribute.node as t.JSXAttribute).name;
      const name = raw.type === "JSXIdentifier" ? raw.name : `${raw.namespace.name}:${raw.name.name}`;
      if (TEXT_ATTRIBUTES.has(name)) return null;
      if (CODE_ATTRIBUTES.test(name)) return "code attribute";
      // An attribute this list does not know: text only when it reads like a sentence.
      return "unknown attribute";
    }
    return null; // {"text"} as a child
  }
  if (parent.isCallExpression() || parent.isOptionalCallExpression() || parent.isNewExpression()) {
    const callee = calleeName((node as t.CallExpression).callee);
    if (parent.isNewExpression() && /^(Error|HttpError|TypeError|RangeError)$/.test(callee)) return null;
    if (/^(set(Error|Notice|Message|Status|Toast|Warning)|toast(\.\w+)?|alert|confirm|onError|fail|reject)$/.test(callee)) return null;
    // A method of a chain (supabase.from(…).select("id, title")): its last name decides.
    const method = callee.split(".").at(-1) ?? "";
    if (CODE_CALLEES.test(callee) || CODE_CALLEES.test(`x.${method}`) || parent.isNewExpression()) return `call ${callee}`;
    return `argument of ${callee}`;
  }
  if (parent.isReturnStatement() || parent.isArrowFunctionExpression()) return "returned";
  if (parent.isVariableDeclarator() || parent.isAssignmentExpression() || parent.isAssignmentPattern()) return "assigned";
  if (parent.isThrowStatement()) return null;
  return parent.type;
}

/** Strings that are code wherever they sit, unless they read like a sentence: then they are flagged anyway. */
const SENTENCE = /\p{L}{2,}[\s\p{L}',’]*\s\p{L}{2,}.*[\p{L}.!?…:)]$/u;

function ignored(source: string[], line: number) {
  return /i18n-ignore/.test(source[line - 1] ?? "") || /i18n-ignore/.test(source[line - 2] ?? "");
}

export function lintSource(file: string, code: string): Finding[] {
  const findings: Finding[] = [];
  const lines = code.split("\n");
  let ast: t.File;
  try {
    ast = parse(code, { sourceType: "module", plugins: ["typescript", "jsx"], errorRecovery: true }) as unknown as t.File;
  } catch (error) {
    return [{ file, line: 1, column: 1, text: `cannot parse: ${error instanceof Error ? error.message : error}`, where: "parse" }];
  }
  const report = (node: t.Node, text: string, where: string) => {
    const line = node.loc?.start.line ?? 1;
    if (ignored(lines, line)) return;
    findings.push({ file, line, column: (node.loc?.start.column ?? 0) + 1, text: text.replace(/\s+/g, " ").trim(), where });
  };
  traverse(ast, {
    JSXText(path) {
      if (looksLikeText(path.node.value)) report(path.node, path.node.value, "JSX text");
    },
    StringLiteral(path) {
      if (!looksLikeText(path.node.value)) return;
      if (path.parentPath?.isJSXAttribute()) {
        const raw = path.parentPath.node.name;
        const name = raw.type === "JSXIdentifier" ? raw.name : raw.name.name;
        if (TEXT_ATTRIBUTES.has(name)) return report(path.node, path.node.value, `${name}=`);
        if (!CODE_ATTRIBUTES.test(name) && SENTENCE.test(path.node.value)) return report(path.node, path.node.value, `${name}=`);
        return;
      }
      if (path.parentPath?.isDirective() || path.parentPath?.isDirectiveLiteral?.()) return;
      const context = codeContext(path);
      if (context === null) return report(path.node, path.node.value, "shown");
      if (["import", "type", "comparison", "member key", "object key", "condition"].includes(context)) return;
      if (/^call /.test(context)) return;
      // Anywhere else (a variable, a return, an argument), only what reads like a sentence.
      if (SENTENCE.test(path.node.value)) report(path.node, path.node.value, context);
    },
    TemplateLiteral(path) {
      const text = path.node.quasis.map((q) => q.value.cooked ?? q.value.raw).join(" ");
      if (!looksLikeText(text)) return;
      if (path.parentPath?.isTaggedTemplateExpression()) return; // sql``, css``
      const context = codeContext(path);
      if (context === null) return report(path.node, text, "shown");
      if (["import", "type", "comparison", "member key", "object key", "condition"].includes(context) || /^call /.test(context)) return;
      if (context === "code attribute") return;
      if (SENTENCE.test(text)) report(path.node, text, context);
    },
  });
  return findings;
}

if (import.meta.main) {
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync(ROOT)]
    .map((f) => `${ROOT}${f}`)
    .filter((f) => !SKIP_FILES.some((skip) => skip.test(f)))
    .sort();
  const all: Finding[] = [];
  for (const file of files) all.push(...lintSource(file.replace(`${ROOT}`, "src/web/"), await Bun.file(file).text()));
  if (process.argv.includes("--json")) console.log(JSON.stringify(all, null, 2));
  else {
    for (const f of all) console.log(`${f.file}:${f.line}:${f.column}  ${f.where}  “${f.text.slice(0, 90)}”`);
    const byFile = new Set(all.map((f) => f.file)).size;
    console.log(all.length ? `\n${all.length} untranslated strings in ${byFile} files.` : "Every string is translated.");
  }
  process.exit(all.length ? 1 : 0);
}
