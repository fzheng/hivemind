FROM node:20-alpine
WORKDIR /app

# Install dependencies and build TypeScript sources
RUN apk add --no-cache curl
COPY package*.json ./
COPY tsconfig*.json ./
COPY tsconfig.base.json ./
COPY scripts ./scripts
COPY contracts ./contracts
COPY packages ./packages
COPY services ./services
COPY db ./db
RUN npm ci
RUN npm run build

ENV NODE_ENV=production
CMD ["node", "services/hl-scout/dist/index.js"]
