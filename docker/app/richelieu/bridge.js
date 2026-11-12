// Runs in the preview, inside the builder's iframe. It reports errors and navigation to the builder, lets the
// user pick an element to ask a change about, and switches the app between light and dark. Messages carry
// `source: "richelieu-preview"`.
(() => {
  if (window.parent === window) return;
  const post = (message) =>
    window.parent.postMessage({ source: "richelieu-preview", ...message }, "*");
  const text = (value) => {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  // Errors: uncaught ones, rejected promises, console.error, and the dev server's error overlay.
  const reportError = (message, stack) =>
    post({
      type: "error",
      message: String(message).slice(0, 4000),
      stack: stack ? String(stack).slice(0, 4000) : undefined,
    });
  window.addEventListener("error", (event) =>
    reportError(event.message, event.error && event.error.stack),
  );
  window.addEventListener("unhandledrejection", (event) =>
    reportError(
      `Unhandled rejection: ${text(event.reason)}`,
      event.reason && event.reason.stack,
    ),
  );
  const consoleError = console.error;
  console.error = (...args) => {
    reportError(args.map(text).join(" "));
    consoleError.apply(console, args);
  };
  new MutationObserver(() => {
    const overlay = document.querySelector("vite-error-overlay");
    if (!overlay || overlay.dataset.reported) return;
    overlay.dataset.reported = "1";
    const body =
      overlay.shadowRoot && overlay.shadowRoot.querySelector(".message-body");
    const file =
      overlay.shadowRoot && overlay.shadowRoot.querySelector(".file");
    reportError(
      `Build error: ${body ? body.textContent : "see the dev server log"}${file && file.textContent ? `\n${file.textContent}` : ""}`,
    );
  }).observe(document.documentElement, { childList: true, subtree: true });

  // Navigation, so the builder's address bar follows the app.
  const location = () =>
    post({
      type: "location",
      path:
        window.location.pathname +
        window.location.search +
        window.location.hash,
    });
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      location();
      return result;
    };
  }
  window.addEventListener("popstate", location);
  window.addEventListener("hashchange", location);

  // Picking: while on, hovering outlines the element under the pointer and a click sends it to the builder.
  let picking = false;
  let box;
  const target = (event) => {
    const element =
      event.target instanceof Element
        ? event.target.closest("[data-rc-loc]")
        : null;
    return element;
  };
  const show = (element) => {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText =
        "position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #3b82f6;background:rgba(59,130,246,.08);border-radius:4px;transition:all 60ms ease-out";
      document.documentElement.appendChild(box);
    }
    const rect = element.getBoundingClientRect();
    Object.assign(box.style, {
      display: "block",
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  };
  const hide = () => box && (box.style.display = "none");
  const onMove = (event) => {
    const element = target(event);
    element ? show(element) : hide();
  };
  const onClick = (event) => {
    const element = target(event);
    if (!element) return;
    event.preventDefault();
    event.stopPropagation();
    post({
      type: "picked",
      loc: element.getAttribute("data-rc-loc"),
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || "").trim().replace(/\s+/g, " ").slice(0, 200),
      className:
        typeof element.className === "string"
          ? element.className.slice(0, 300)
          : "",
    });
    setPicking(false);
  };
  const setPicking = (on) => {
    if (picking === on) return;
    picking = on;
    document.documentElement.style.cursor = on ? "crosshair" : "";
    const method = on ? "addEventListener" : "removeEventListener";
    document[method]("mousemove", onMove, true);
    document[method]("click", onClick, true);
    if (!on) hide();
    post({ type: "picking", on });
  };
  window.addEventListener("message", (event) => {
    if (
      event.source !== window.parent ||
      !event.data ||
      event.data.source !== "richelieu-builder"
    )
      return;
    if (event.data.type === "pick") setPicking(Boolean(event.data.on));
    if (event.data.type === "theme") setTheme(event.data.theme);
  });

  // Theme: the template's ThemeProvider keeps the choice in localStorage ("theme") and follows storage events, so
  // writing it there switches the app the way its own toggle does. An app without the provider still gets the
  // `dark` class Tailwind's dark variant reads.
  const THEME_KEY = "theme";
  const currentTheme = () => {
    const root = document.documentElement;
    if (root.classList.contains("dark")) return "dark";
    if (root.classList.contains("light")) return "light";
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  };
  const setTheme = (theme) => {
    if (theme !== "light" && theme !== "dark") return;
    try {
      const previous = localStorage.getItem(THEME_KEY);
      localStorage.setItem(THEME_KEY, theme);
      dispatchEvent(
        new StorageEvent("storage", { key: THEME_KEY, oldValue: previous, newValue: theme, storageArea: localStorage }),
      );
    } catch {}
    const root = document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    root.style.colorScheme = theme;
  };
  // Tell the builder whenever the theme changes, whoever changed it (the app's own toggle, its "d" shortcut).
  let reportedTheme = null;
  const reportTheme = () => {
    const theme = currentTheme();
    if (theme === reportedTheme) return;
    reportedTheme = theme;
    post({ type: "theme", theme });
  };
  new MutationObserver(reportTheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  window.addEventListener(
    "keydown",
    (event) => event.key === "Escape" && setPicking(false),
  );

  addEventListener("DOMContentLoaded", () => {
    post({ type: "ready" });
    location();
    reportedTheme = null;
    reportTheme();
  });
})();
