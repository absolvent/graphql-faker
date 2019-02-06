FROM node:8.8.1-alpine
COPY ./package.json /app/package.json
WORKDIR /app
RUN yarn install --production
EXPOSE 9002
ENTRYPOINT ["node", "/app/index.js"]
COPY ./dist /app
