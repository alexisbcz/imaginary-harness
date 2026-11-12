# The agent's browser

Each project's agent has a real browser: Chromium, in a Docker container of its own. The agent uses it to search
the web, read sites, fill in forms, and test the project's app the way a user would. You watch it live in the
project's **Browser** tab, and you can take the controls at any time, for example to sign in. The workspace
switches to that tab by itself when the agent starts browsing.

## How the agent sees and acts

It works the way [Playwright MCP](https://github.com/microsoft/playwright-mcp) does for coding agents, on the same
Playwright API:

- **The page is a snapshot.** It is an accessibility tree, as text, from Playwright's
  `page.ariaSnapshot({ mode: "ai" })`. Every element the agent can act on has a ref (`[ref=e12]`), and every link
  carries its URL. Snapshots are cut at about 18,000 characters; the agent can read one part of a page by its ref.
- **Actions use refs.** `page.getByRef("e12")` finds the element. Every action answers with what happened and a
  fresh snapshot, so the next action uses current refs.
- **Screenshots are for looks.** `browser_screenshot` returns an image the model sees. It is for checking how
  something looks, not for finding elements.

| Tool | What it does |
| --- | --- |
| `browser_navigate`, `browser_navigate_back` | open a URL, go back |
| `browser_snapshot` | read the page, or one part of it by ref |
| `browser_click`, `browser_hover`, `browser_drag` | act on elements (double or right clicks, modifier keys) |
| `browser_type`, `browser_fill_form`, `browser_select_option` | fill fields, checkboxes, radios, selects |
| `browser_press_key`, `browser_scroll`, `browser_wait_for` | keys and shortcuts, scrolling, waiting for a text |
| `browser_screenshot` | the visible page, the whole page, or one element, as an image |
| `browser_tabs` | list, open, switch or close tabs |
| `browser_console_messages`, `browser_network_requests` | what the page logged and requested since the last look |
| `browser_handle_dialog` | answer a confirm or a prompt (alerts are accepted on their own) |
| `browser_file_upload` | upload the project's files into a file input |
| `browser_evaluate` | run JavaScript in the page |
| `browser_open_app` | open the project's own app (its live preview) to try it |
| `browser_ask_user` | hand the browser to you, with a reason |
| `browser_close` | close it; sign-ins are kept |

## You and the browser

- **Watching** is the default. The tab streams the page (Playwright's screencast, JPEG frames over a WebSocket) and
  shows the address, the tabs, and whether the agent is acting.
- **Take control** sends your mouse, wheel, keyboard and paste to the browser, and turns on the address bar and
  the back, forward and reload buttons. **Give back to the agent** ends it.
- **When the agent needs you**, it never types a password, a card number or a code from your phone, and never
  solves a CAPTCHA. It calls `browser_ask_user` instead. A banner says what to do, you do it, then **I'm done**
  tells the agent to continue.
- **Sign-ins are kept.** When the browser closes, its cookies and storage are saved per project, encrypted
  (`browser_profiles`, with the newsletter's sealing key), and restored when it next starts. **Forget sign-ins and
  cookies** in the tab's menu deletes them.
- The agent asks before anything that cannot be undone or speaks for you: buying, sending, posting, deleting,
  accepting terms.

## Safety

- The browser reaches the public web and the project's own preview. Everything else on this machine and on the
  private network is blocked: localhost, 10/8, 172.16/12, 192.168/16, 169.254/16 (cloud metadata), `.internal`,
  `.local`, and IPv6 local addresses. Only `http`, `https`, `data` and `blob` URLs load. This blocking checks the
  address the browser asks for, not where a public name finally resolves to.
- Each project's browser runs in its own container, with limits on memory, CPU and processes, and
  `no-new-privileges`. Downloads are off.
- What pages say is data: the agent is told never to follow instructions found in them.
- Browsers close after 15 idle minutes, unless someone is watching. Sign-ins are saved first.

## How it works

| Where | What |
| --- | --- |
| `docker/browser/Dockerfile` | Playwright's image (`mcr.microsoft.com/playwright:v1.65.0-noble`) running `playwright run-server` |
| `src/browser/sessions.ts` | containers, the Playwright connection, tabs, logs, dialogs, the network guard, sign-ins, the screencast and your input |
| `src/browser/agent.ts` | the tools and the agent's instructions |
| `src/server/browser-api.ts` | `/api/projects/:id/browser` (start, close, forget) and the live view's WebSocket |
| `src/web/components/browser-panel.tsx` | the Browser tab |
| `supabase/migrations/…_browser.sql` | `browser_profiles` |

The server talks to each container with `chromium.connect()`, over Playwright's own protocol, so every Playwright
feature works, file uploads included. The image is built the first time the server starts with Docker. It takes a
few minutes, because Playwright's base image is about 2 GB. The `playwright-core` version in `package.json` must
match the image's Playwright version (1.65).

The browser needs Docker, so it works on the local server and a VPS, not on Vercel's functions.

## Limits

- Some sites turn away automated browsers or ask for a CAPTCHA (Google search did, in testing). Take control, or
  ask the agent to use web research (`web_research`) instead.
- Native pickers (a `<select>`'s list, the file chooser) do not show in the live view. The agent picks options and
  uploads files without them.
- One browser per project, shared by its chats.
