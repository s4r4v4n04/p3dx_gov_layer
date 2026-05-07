/**
 * Error Handling Middleware
 * 
 * Catches all errors that occur during request processing
 * and returns a consistent error response to the client.
 * 
 * @module error.middleware
 */

export default function errorMiddleware(err, req, res, next) {
  // Log the error for debugging
  console.error('[ERROR]', err);

  // Handle CORS errors
  if (err.message === 'CORS: origin not allowed') {
    return res.status(403).json({
      status: 'FAILED',
      error: 'CORS_ERROR',
      message: 'Origin not allowed'
    });
  }

  // Handle JSON parsing errors
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      status: 'FAILED',
      error: 'INVALID_JSON',
      message: 'Invalid JSON in request body'
    });
  }

  // Default error response
  return res.status(500).json({
    status: 'FAILED',
    error: 'INTERNAL_ERROR',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An unexpected error occurred'
  });
}
