# The agent's browser: Playwright's own image (Chromium and its fonts and libraries), serving Playwright's protocol
# on port 3000. The server connects with chromium.connect(); the version matches playwright-core in package.json.
FROM mcr.microsoft.com/playwright:v1.65.0-noble

RUN npm install -g playwright@1.65.0 && npm cache clean --force

USER pwuser
WORKDIR /home/pwuser
EXPOSE 3000
ENTRYPOINT ["playwright", "run-server", "--port", "3000", "--host", "0.0.0.0"]
