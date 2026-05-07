/**
 * Express Application Setup
 * 
 * This file configures the Express application with middleware for:
 * - CORS (Cross-Origin Resource Sharing)
 * - JSON body parsing
 * - Route mounting
 * - Error handling
 * - Database initialization
 * 
 * @module app
 */

import express from "express";
import cors from "cors";
import governanceRoutes from "./routes/governance.routes.js";
import errorMiddleware from "./middlewares/error.middleware.js";
import { initializeDatabase } from "./services/database.service.js";

// Initialize Express application
const app = express();

/**
 * CORS Configuration
 * 
 * Controls which origins are allowed to access this API.
 * Origins are read from CORS_ORIGINS environment variable.
 * If no origin is provided in the request, it's allowed (for testing).
 */
const corsOrigins = String(process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow all origins for testing
      console.log(`[CORS] Allowing origin: ${origin || 'none'}`);
      return callback(null, true);
    },
    methods: ["GET", "POST", "OPTIONS"], // Allowed HTTP methods
    allowedHeaders: ["Content-Type", "Authorization"], // Allowed headers
  })
);

/**
 * Body Parsing Middleware
 * 
 * Parses incoming request bodies:
 * - express.json(): Parses JSON payloads (max 5MB)
 * - express.text(): Parses text payloads
 */
app.use(express.json({ limit: "5mb" }));
app.use(express.text({ type: ['text/*', 'application/jwt'] }));

/**
 * Database Initialization
 * 
 * Initializes SQLite database and attaches it to app.locals
 * for access in route handlers.
 */
export async function initializeApp() {
  const db = await initializeDatabase();
  app.locals.db = db;
  return app;
}

/**
 * Route Mounting
 * 
 * Mounts the governance routes under both /api/v1 and /governance paths
 * for flexibility in API versioning and access patterns.
 */
app.use("/api/v1", governanceRoutes);
app.use("/governance", governanceRoutes);

/**
 * Error Handling Middleware
 * 
 * Must be mounted after all other middleware and routes.
 * Catches all errors and returns consistent error responses.
 */
app.use(errorMiddleware);

/**
 * Export the configured Express application
 */
export default app;
