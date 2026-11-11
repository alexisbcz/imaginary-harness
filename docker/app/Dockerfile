# The preview image: Node with the app template's packages installed in /app. A project's files are copied into
# /app when its preview starts; `.richelieu/` holds the dev server's wrapper config, invisible to the project.
FROM node:22-slim
WORKDIR /app
RUN chown node:node /app
USER node
COPY --chown=node:node templates/app/package.json ./
RUN npm install --no-audit --no-fund --loglevel=error && cp package.json /tmp/installed.json
COPY --chown=node:node docker/app/richelieu ./.richelieu
RUN mv /tmp/installed.json .richelieu/installed.json
EXPOSE 5173
CMD ["sh", ".richelieu/start.sh"]
