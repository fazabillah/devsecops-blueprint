# Day 2: Multi-Stage Dockerfile

**Branch:** `feature/docker`

## What You'll Learn

Optimize Docker images with multi-stage builds to reduce image size and improve security.

## Why Multi-Stage Builds Matter

Single-stage builds include build tools in the final image: unnecessary, larger, and a wider attack surface. Multi-stage builds keep only production dependencies in the final image — smaller, faster to pull, and less exposed.

## Prerequisites

This guide assumes you already have:
- A React frontend in `client/` with a `package.json` that includes a `build` script (output goes to `/app/build`)
- A Node.js backend in `api/` with `app.js` as the entry point and a valid `package.json`
- An `api/.env` file with at least `DB_PASSWORD=Faza123` (used by docker-compose)

If you're starting from scratch, complete Day 1 first or clone the starter repo before continuing here.

## Create Frontend Dockerfile

`client/Dockerfile`:

```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build application
RUN npm run build

# Stage 2: Production
FROM nginx:alpine

# Copy custom nginx config
COPY nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy built files from builder stage
COPY --from=builder /app/build /usr/share/nginx/html

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
```

**Why two stages:**
1. **Builder stage** - Installs all dependencies, builds React app
2. **Production stage** - Only takes compiled files, runs on lightweight nginx

## Create nginx/default.conf

`client/nginx/default.conf`:

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;

    location / {
        root /usr/share/nginx/html;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # Enable gzip compression
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript;

    # Cache static assets
    location ~* \.(jpg|jpeg|png|gif|ico|css|js)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

**What this does:**
- Serves React app on port 80
- Handles client-side routing (try_files)
- Enables gzip compression
- Caches static assets for performance

## Create Backend Dockerfile

`api/Dockerfile`:

```dockerfile
FROM node:22-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev

# Copy source code
COPY . .

# Expose port
EXPOSE 5000

# Start application
CMD ["node", "app.js"]
```

**Why single stage for backend:**
- Node.js apps run from source (no compilation needed)
- Still optimized with --only=production flag
- Uses `node:22-alpine` to match the frontend build stage

# Build and Test Locally

### Build Frontend

```bash
cd client

# Build image
docker build -t fazabillah/frontend:latest .

# Check size
docker images fazabillah/frontend:latest
```

### Build Backend

```bash
cd ../api

# Build image
docker build -t fazabillah/backend:latest .

# Check size
docker images fazabillah/backend:latest
```

### Compare Image Sizes

```bash
# List images
docker images | grep fazabillah

# Single-stage build: ~500-800 MB
# Multi-stage build: ~50-150 MB (5-10x smaller!)
```

# Test with Docker Compose

Create `docker-compose.yml` in project root:

```yaml
version: '3.8'

services:
  mysql:
    image: mysql:8
    container_name: mysql
    environment:
      MYSQL_ROOT_PASSWORD: Faza123
      MYSQL_DATABASE: crud_app
    ports:
      - "3306:3306"
    volumes:
      - mysql_data:/var/lib/mysql
    networks:
      - app-network

  backend:
    build:
      context: ./api
      dockerfile: Dockerfile
    container_name: backend
    environment:
      DB_HOST: mysql
      DB_USER: root
      DB_PASSWORD: Faza123
      DB_NAME: crud_app
      PORT: 5000
      JWT_SECRET: devopsFazaSuperSecretKey
    ports:
      - "5001:5000"
    depends_on:
      - mysql
    networks:
      - app-network

  frontend:
    build:
      context: ./client
      dockerfile: Dockerfile
    container_name: frontend
    ports:
      - "3000:80"
    depends_on:
      - backend
    networks:
      - app-network

volumes:
  mysql_data:

networks:
  app-network:
    driver: bridge
```

> **Known limitation:** `docker-compose.yml` contains hardcoded values for `MYSQL_ROOT_PASSWORD`, `DB_PASSWORD`, and `JWT_SECRET`. This is acceptable for local development. For any shared or production environment, move these values to a `.env` file (excluded from version control via `.gitignore`) or pull them from a secrets manager.

> **Port mapping:** The backend runs on port 5000 inside the container. It maps to port 5001 on the host (`5001:5000`). Access it at `http://localhost:5001` when testing locally.

> **Password consistency:** `MYSQL_ROOT_PASSWORD` in docker-compose and `DB_PASSWORD` in the backend environment must match the value in `api/.env` (`DB_PASSWORD=Faza123`). If you change one, change all three. The containers reference the same credential at runtime.

> **React env vars:** `REACT_APP_*` variables are baked into the JavaScript bundle at build time by `npm run build`. Setting them in the docker-compose `environment:` block has no effect on an already-built image. For local docker-compose testing, set `REACT_APP_API=http://localhost:5001` in `client/.env` before running `docker build`. In production on Kubernetes, the nginx proxy handles `/api` routing — the frontend bundle doesn't need to know the backend URL directly.

### Run with Docker Compose

```bash
# Start all services
docker-compose up -d

# Check status
docker-compose ps

# View logs
docker-compose logs -f

# Access application
# Frontend: http://localhost:3000
# Backend:  http://localhost:5001

# Stop services
docker-compose down

# Stop and remove volumes
docker-compose down -v
```

# Push Images to DockerHub

```bash
# Login to DockerHub
docker login

# Images are already tagged correctly from the build step.
# Push images
docker push fazabillah/frontend:latest
docker push fazabillah/backend:latest
```

# Understanding Multi-Stage Build

### Frontend Build Process

```
Stage 1 (builder):
  node:22-alpine (150 MB)
  + npm install (all dependencies)
  + source code
  + npm run build
  = Build artifacts in /app/build
  Total size: ~800 MB

Stage 2 (production):
  nginx:alpine (23 MB)
  + static files from Stage 1 (/app/build)
  Total size: ~50 MB

Final image: Only Stage 2 (50 MB)
Stage 1 discarded after build
```

### Benefits Demonstrated

**Before multi-stage:**
```bash
REPOSITORY              SIZE
fazabillah/frontend     850 MB
fazabillah/backend      400 MB
```

**After multi-stage:**
```bash
REPOSITORY              SIZE
fazabillah/frontend     52 MB   (94% reduction!)
fazabillah/backend      180 MB  (55% reduction!)
```

# Dockerfile Best Practices

1. **Use specific base image tags** - `node:22-alpine` (both frontend and backend) not `node:latest`
2. **Use alpine images** - Smaller, more secure
3. **Copy package.json first** - Leverage Docker layer caching
4. **Use .dockerignore** - Exclude unnecessary files

### Create .dockerignore

`client/.dockerignore`:
```
node_modules
build
.git
.env
.DS_Store
```

`api/.dockerignore`:
```
node_modules
.git
.env
.DS_Store
```

# Troubleshooting

### Build fails at npm install

```bash
# Clear Docker cache
docker builder prune -a

# Rebuild without cache
docker build --no-cache -t fazabillah/frontend:latest .
```

### nginx serves 404

```bash
# Check nginx config syntax
docker run --rm -v $(pwd)/nginx.conf:/etc/nginx/nginx.conf:ro nginx:alpine nginx -t

# Check build output location
docker run --rm fazabillah/frontend:latest ls -la /usr/share/nginx/html
```

### Backend can't connect to database

```bash
# Check network connectivity
docker-compose exec backend ping mysql

# Check environment variables
docker-compose exec backend env | grep DB_
```

# Self-Check

Three signals confirm the multi-stage builds are working:

```bash
# Image sizes — multi-stage should be dramatically smaller than base node
docker images | grep -E "frontend|backend"
# Expected: frontend ~50-150MB, backend ~150-200MB
# If you see 1GB+ images, the multi-stage build isn't being used
```

```bash
# All three containers running via compose
docker compose ps
# Expected: 3 services listed, all showing "running" status
```

```bash
# Backend health through the compose network
curl http://localhost:5001/api/health
# Expected: {"status":"ok"}
# Port 5001 is the compose-mapped host port — adjust if you used a different mapping
```

Size is the key signal here. A single-stage Node image is typically 900MB–1.2GB. If your image sizes are in that range, the final `FROM` stage in your Dockerfile is still pulling the full base image rather than copying only the build artifacts.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] Frontend Dockerfile created with multi-stage build
- [ ] Backend Dockerfile created
- [ ] nginx/default.conf configured
- [ ] .dockerignore files created
- [ ] Images build successfully
- [ ] Images tested with docker-compose
- [ ] Understand size difference (single vs multi-stage)
- [ ] Images pushed to DockerHub
- [ ] docker-compose.yml created and tested (backend on port 5001)

# What You Learned

- Multi-stage builds reduce image size dramatically
- nginx serves React apps efficiently
- Docker Compose orchestrates multi-container apps
- Layer caching speeds up builds
- .dockerignore excludes unnecessary files

# Next

**Day 3:** Kubernetes Deployment — EKS cluster setup and manual deploy.

# Notes

- Multi-stage builds are production standard
- Always use alpine images when possible
- Test images locally before pushing to registry
- Document Dockerfile changes in commit messages
