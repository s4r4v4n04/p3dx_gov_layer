# P3DX Governance Layer

A lightweight Node.js backend service for storing Output Owner form submissions in the P3DX system.

## Purpose

The Governance Layer receives and stores Output Owner form submissions from the AAA backend. It provides a simple REST API for form submission and retrieval.

## Features

- **Form Storage**: Stores Output Owner form submissions in PostgreSQL database
- **Persistent Storage**: Data persists across server restarts
- **REST API**: Simple HTTP endpoints for form operations
- **CORS Support**: Configurable CORS for frontend integration
- **Error Handling**: Consistent error responses

## Architecture

```
AAA Backend → POST /api/v1/form-submissions → Governance Layer (stores form)
Frontend → GET /api/v1/form-submissions → Governance Layer (retrieves forms)
```

## Setup

### Prerequisites

- Node.js (v18 or higher)
- npm

### Installation

1. Navigate to the project directory:
```bash
cd c:\Users\Saravan_04\OneDrive\Desktop\p3dx_gov_layer
```

2. Install dependencies:
```bash
npm install
```

3. Ensure PostgreSQL is running:
```bash
# On Windows with PostgreSQL installed
# Start PostgreSQL service

# On Linux/WSL
sudo service postgresql start
```

4. Create database:
```bash
# Using psql
psql -U postgres
CREATE DATABASE p3dx_governance;
\q
```

5. Create environment file:
```bash
cp .env.example .env
```

6. Configure `.env`:
```env
PORT=8083
CORS_ORIGINS=http://localhost:5173,http://localhost:3000
DB_HOST=localhost
DB_PORT=5432
DB_NAME=p3dx_governance
DB_USER=postgres
DB_PASSWORD=your_password
```

### Running the Server

**Development mode (with auto-reload):**
```bash
npm run dev
```

**Production mode:**
```bash
npm start
```

The server will start on port 8083 by default.

## API Endpoints

### POST /api/v1/form-submissions

Store an Output Owner form submission.

**Request Body:**
```json
{
  "payload": {
    "form_id": "outputform-001",
    "requested_by": "admin-uuid-001",
    "output_owner_id": "outputowner1",
    "num_server_rounds": 10,
    "fraction_evaluate": 0.5,
    "local_epochs": 1,
    "learning_rate": 0.01,
    "batch_size": 32,
    "model": "AlexNet",
    "framework": "flwrlabs",
    "components": {}
  }
}
```

**Response:**
```json
{
  "status": "SUCCESS",
  "message": "Form submission stored successfully",
  "submission_id": "gov-1713761234567-abc123def"
}
```

### GET /api/v1/form-submissions

Retrieve all stored form submissions.

**Response:**
```json
{
  "status": "SUCCESS",
  "count": 2,
  "submissions": [
    {
      "form_id": "outputform-001",
      "output_owner_id": "outputowner1",
      "submission_id": "gov-1713761234567-abc123def",
      "filled_at": "2024-04-22T10:30:00.000Z"
    }
  ]
}
```

### GET /api/v1/form-submissions/:id

Retrieve a specific form submission by ID.

### DELETE /api/v1/form-submissions/:id

Delete a specific form submission by ID.

## Data Storage

Form submissions are stored in a **PostgreSQL database**. Data persists across server restarts. The database table is automatically created on first startup.

**Database Schema:**
```sql
CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  output_owner_id TEXT NOT NULL,
  num_server_rounds INTEGER,
  fraction_evaluate REAL,
  local_epochs INTEGER,
  learning_rate REAL,
  batch_size INTEGER,
  model TEXT,
  framework TEXT,
  components JSONB,
  filled BOOLEAN DEFAULT true,
  requested_at TIMESTAMP,
  filled_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

## Integration with AAA Backend

The AAA backend sends Output Owner form data to this service:

```javascript
// In AAA backend (p3dx.routes.js)
const governanceRes = await fetch('http://localhost:8083/api/v1/form-submissions', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({ payload: outputOwnerPayload })
});
```

## Project Structure

```
p3dx_gov_layer/
├── src/
│   ├── app.js              # Express app configuration
│   ├── server.js           # Server entry point
│   ├── routes/
│   │   └── governance.routes.js  # API endpoints
│   └── middlewares/
│       └── error.middleware.js   # Error handling
├── package.json            # Dependencies
├── .env.example            # Environment variables template
└── README.md               # This file
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Server port | 8083 |
| NODE_ENV | Environment (development/production) | development |
| CORS_ORIGINS | Comma-separated allowed origins | (none) |

## Testing

Test the API using curl:

```bash
# Store a form submission
curl -X POST http://localhost:8083/api/v1/form-submissions \
  -H "Content-Type: application/json" \
  -d '{"payload":{"form_id":"test-001","output_owner_id":"test-user"}}'

# Retrieve all submissions
curl http://localhost:8083/api/v1/form-submissions
```

## Troubleshooting

**Port already in use:**
- Change the PORT in `.env` file
- Or stop the process using port 8083

**CORS errors:**
- Add your frontend URL to CORS_ORIGINS in `.env`

**Data lost on restart:**
- This is expected behavior (in-memory storage)
- For persistence, integrate a database
