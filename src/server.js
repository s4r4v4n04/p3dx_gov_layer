/**
 * Governance Layer Server Entry Point
 * 
 * This is the main entry point for the Governance Layer backend service.
 * It initializes the Express application with database support and starts both:
 * 1. REST API server (Express) on port 8083 for frontend communication
 * 2. gRPC server on port 50052 for backend-to-backend communication
 * 
 * The Governance Layer is responsible for:
 * - Receiving and storing Output Owner form submissions
 * - Providing REST API endpoints for form submission
 * - Providing gRPC endpoints for inter-service communication
 * - Storing forms in PostgreSQL database for persistence
 * 
 * @module server
 */

import './load-env.js'; // Load .env (override:true) before anything else — must be first import
import app, { initializeApp } from './app.js';
import { startGrpcServer } from './grpc/governance.server.js';

/**
 * Server Configuration
 * 
 * REST_PORT: The port for the REST API server (Express)
 * Defaults to 8083 if not specified in environment variables
 * 
 * GRPC_PORT: The port for the gRPC server
 * Defaults to 50052 if not specified in environment variables
 */
const REST_PORT = process.env.PORT || 8083;
const GRPC_PORT = process.env.GRPC_PORT || 50052;

/**
 * Start the HTTP Server
 * 
 * Initializes the database and starts the REST server on the configured port.
 * The server handles incoming HTTP requests for form submissions and other governance operations.
 * 
 * Also starts the gRPC server for backend-to-backend communication.
 */
async function startServer() {
  try {
    // Initialize database and get the initialized app
    // initializeApp() returns the Express app with database attached via app.locals.db
    const initializedApp = await initializeApp();
    
    // Get the database instance from the app
    // This is needed to pass to the gRPC server
    const db = initializedApp.locals.db;
    
    // Start REST (HTTP) server
    // This server handles REST API calls from the frontend
    const restServer = initializedApp.listen(REST_PORT, () => {
      console.log(`[REST] Governance Layer server running on port ${REST_PORT}`);
      console.log(`[REST] Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log(`[REST] CORS Origins: ${process.env.CORS_ORIGINS || 'Not configured'}`);
      console.log(`[REST] Database: PostgreSQL`);
    });
    
    // Start gRPC server
    // This server handles gRPC calls from other backend services
    // It runs on a different port (50052) to avoid conflicts with the REST server
    const grpcServer = startGrpcServer(db, GRPC_PORT);
    
    console.log(`[INFO] Both servers started successfully`);
    console.log(`[INFO] REST API: http://localhost:${REST_PORT}`);
    console.log(`[INFO] gRPC: localhost:${GRPC_PORT}`);
    
    // Graceful shutdown handling
    // This ensures both servers close properly when the process is terminated
    process.on('SIGTERM', () => {
      console.log('[INFO] SIGTERM signal received: closing HTTP and gRPC servers');
      restServer.close(() => {
        console.log('[INFO] HTTP server closed');
      });
      grpcServer.tryShutdown((err) => {
        if (err) {
          console.error('[ERROR] Error shutting down gRPC server:', err);
        } else {
          console.log('[INFO] gRPC server shut down');
        }
        process.exit(0);
      });
    });
    
  } catch (error) {
    console.error('[ERROR] Failed to start server:', error);
    process.exit(1);
  }
}

// Start the server
startServer();
