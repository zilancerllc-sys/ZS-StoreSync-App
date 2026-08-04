FROM node:20-alpine
RUN apk add --no-cache openssl

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# Generate the Prisma client into the image rather than on every container
# boot. It took ~8s of a ~13s cold start, during which fly-proxy gets connection
# refused and gives up after ~8s — so a deploy (or any machine restart) served
# errors for that window. The schema ships in the same image, so a client baked
# here can never be out of step with it. Only `migrate deploy`, which needs the
# live database, still runs at start.
RUN npx prisma generate

RUN npm run build

CMD ["npm", "run", "docker-start"]
