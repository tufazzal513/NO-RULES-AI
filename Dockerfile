# Stage 1: Build Environment
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build tools required for native modules like better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install ALL dependencies (including devDependencies for building)
COPY package*.json ./
RUN npm install

# Copy the rest of the application source code
COPY . .

# Build the frontend (Vite) and backend (esbuild)
RUN npm run build

# Stage 2: Production Environment
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Set environment variables
ENV NODE_ENV="production"
ENV PORT=3000

# Install build tools required for native modules in production
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install ONLY production dependencies
RUN npm install --omit=dev

# Copy the built artifacts from the builder stage
COPY --from=builder /app/dist ./dist

# Create a directory for the database to ensure it has proper permissions if mounted
RUN mkdir -p /app/data && chown -R node:node /app

# Switch to non-root user for security
USER node

# Expose the port the app runs on
EXPOSE 3000

# Start the application
CMD ["npm", "start"]
