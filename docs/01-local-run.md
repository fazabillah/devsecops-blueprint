# Day 1: 3-Tier Project Local Run

**Branch:** `feature/local-setup`

## What You'll Learn

Run the complete 3-tier application on your local machine to understand how it works before containerizing and deploying it to the cloud.

## Prerequisites

- macOS (Apple Silicon)
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Homebrew](https://brew.sh/) installed

---

## Step 1: Install Node.js via NVM

NVM lets you switch Node versions per project — standard practice in any team with multiple repos.

```bash
# Install NVM
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash

# Reload shell
source ~/.zshrc

# Install Node.js 22 LTS (matches node:22-alpine used in Docker builds)
nvm install 22
nvm use 22

# Verify
node -v
npm -v
```

---

## Step 2: Clone the Repository

```bash
git clone https://github.com/fazabillah/devsecops-blueprint.git
cd devsecops-blueprint

# Switch to develop branch
git checkout develop
```

---

## Step 3: Start MySQL with Docker

No need to install MySQL on your machine. Run it in a container — this is how most teams handle local database dependencies.

```bash
docker run --name mysql-local \
  -e MYSQL_ROOT_PASSWORD=Faza123 \
  -e MYSQL_DATABASE=crud_app \
  -p 3306:3306 \
  -d mysql:8
```

Wait about 10 seconds for MySQL to initialize, then verify it's ready:

```bash
docker exec -it mysql-local mysql -u root -pFaza123 -e "SHOW DATABASES;"
# crud_app should appear in the list
```

The `users` table is created automatically by the backend on first connect (via the init script). You don't need to create it manually.

> To stop and remove the container when done: `docker rm -f mysql-local`

---

## Step 4: Configure Backend

```bash
cd api
```

Create `api/.env` if it doesn't exist:

```bash
cat > .env << 'EOF'
DB_HOST=127.0.0.1
DB_USER=root
DB_PASSWORD=Faza123
DB_NAME=crud_app
PORT=5000
JWT_SECRET=devopsFazaSuperSecretKey
EOF
```

> Use `127.0.0.1` instead of `localhost`. On macOS, `localhost` can resolve to IPv6 (`::1`) which MySQL's Docker binding doesn't listen on, causing a connection refused error.

---

## Step 5: Start the Backend

```bash
# From api/
npm install
npm start
# Should print: "MySQL connected" and "Server running on port 5000"
```

Test it:

```bash
curl http://localhost:5000/api/health
# Should return a 200 response
```

---

## Step 6: Configure and Start the Frontend

Open a new terminal tab:

```bash
cd devsecops-blueprint/client
```

Create `client/.env`:

```bash
echo 'REACT_APP_API=http://localhost:5000' > .env
```

Start the frontend:

```bash
npm install
npm start
# Opens http://localhost:3000 in your browser automatically
```

---

## Step 7: Access the Application

```
http://localhost:3000

Default admin login:
  Email:    admin@example.com
  Password: admin123
```

Try creating a user, editing, and deleting — verify all three tiers are talking to each other.

---

# Understanding Project Structure

### Frontend (client/)

- `package.json` — dependencies and scripts
- `src/App.js` — entry point
- `src/pages/` — UI components
- `.env` — API base URL (never commit)

### Backend (api/)

- `package.json` — dependencies and scripts
- `app.js` — entry point, port configuration
- `models/db.js` — database connection
- `routes/` — API endpoints
- `.env` — database credentials (never commit)

### Database

- MySQL 8 running in Docker on port 3306
- Database: `crud_app`
- Table: `users` (auto-created on first backend start)

## Key Files as a DevOps Engineer

You don't need to understand every line of application code, but you need to know:

- `package.json` — what dependencies the app needs, what scripts run it
- `app.js` — entry point, what port it listens on
- `models/db.js` — how the backend connects to the database
- `.env` — where credentials and config live (never commit this)

---

# Troubleshooting

### Backend can't connect to MySQL

```bash
# Confirm the container is running
docker ps | grep mysql-local

# Check MySQL is accepting connections
docker exec -it mysql-local mysql -u root -pFaza123 -e "SELECT 1;"

# Confirm api/.env uses 127.0.0.1, not localhost
cat api/.env | grep DB_HOST
```

### Frontend can't reach backend

```bash
# Test backend directly
curl http://localhost:5000/api/health

# Confirm client/.env points to correct URL
cat client/.env
```

### Port already in use

```bash
# Find what's on port 5000 or 3000
lsof -i :5000
lsof -i :3000

# Kill the process
kill -9 <PID>
```

### react-scripts: not found

```bash
# node_modules missing — run install first
cd client && npm install
```

---

# Self-Check

Three signals confirm the local run is working. Run them in order:

```bash
# Backend health
curl http://localhost:5000/api/health
# Expected: {"status":"ok"} or similar JSON
```

```bash
# Login returns a JWT token
curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@example.com","password":"admin123"}' | grep -o '"token":"[^"]*"'
# Expected: "token":"eyJ..." (the exact value varies — any JWT string is correct)
```

```bash
# All three processes are listening
lsof -i :3000 -i :5000 -i :3306 | grep LISTEN
# Expected: 3 lines, one per port
```

If the health check returns a connection error, the backend isn't running. If login returns empty output, the database seed hasn't run or the credentials are wrong. If `lsof` shows fewer than 3 lines, one process failed to start — check that terminal's output.

If your output doesn't match, paste it here — the expected output above is the baseline for diagnosis.

# Checklist

- [ ] Node.js 22 installed via NVM
- [ ] MySQL running in Docker (`docker ps` shows mysql-local)
- [ ] `api/.env` created with correct values
- [ ] Backend running on port 5000 (`MySQL connected` in terminal)
- [ ] `client/.env` pointing to `http://localhost:5000`
- [ ] Frontend running on port 3000
- [ ] Can log in and perform CRUD operations in the browser

# What You Learned

- How the three tiers connect: browser → React → Express → MySQL
- How environment variables decouple config from code
- How to run a database dependency with Docker instead of installing it locally
- What files a DevOps engineer needs to understand in an app repo

# Next

**Day 2:** Multi-stage Dockerfile and Docker Compose — optimize images with multi-stage builds and test the full stack locally with compose.

