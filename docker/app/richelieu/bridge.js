// Runs in the preview, inside the builder's iframe. It reports errors and navigation to the builder, and lets the
// user pick an element to ask a change about. Messages carry `source: "richelieu-preview"`.
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
  });
  window.addEventListener(
    "keydown",
    (event) => event.key === "Escape" && setPicking(false),
  );

  addEventListener("DOMContentLoaded", () => {
    post({ type: "ready" });
    location();
  });
})();
