import dotenv from 'dotenv';

// Load .env with override:true so this service's own .env always wins over any
// environment variables already present in the shell. Without this, generic vars
// like DB_USER / DB_PASSWORD / DB_NAME exported for a sibling service (e.g. p3dx_apd)
// would be inherited and hijack this service's database connection.
dotenv.config({ override: true });
