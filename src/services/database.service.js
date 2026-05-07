/**
 * Database Service
 * 
 * Handles PostgreSQL database operations for storing Output Owner form submissions.
 * Uses pg (node-postgres) for PostgreSQL connectivity.
 * 
 * @module database.service
 */

import pg from 'pg';

const { Pool } = pg;

/**
 * Initialize database connection and create tables
 * Auto-creates the database if it doesn't exist
 * 
 * @returns {Promise<Pool>} PostgreSQL connection pool
 */
export async function initializeDatabase() {
  const dbName = process.env.DB_NAME || 'p3dx_governance';
  const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: 'postgres', // Connect to default database first
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'postgres',
  };

  // Connect to default database to check/create target database
  const defaultPool = new Pool(dbConfig);
  
  try {
    const client = await defaultPool.connect();
    console.log('[DATABASE] Connected to PostgreSQL (default database)');
    
    // Check if target database exists
    const checkResult = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName]
    );
    
    if (checkResult.rows.length === 0) {
      console.log(`[DATABASE] Database '${dbName}' does not exist, creating...`);
      await client.query(`CREATE DATABASE ${dbName}`);
      console.log(`[DATABASE] Database '${dbName}' created successfully`);
    } else {
      console.log(`[DATABASE] Database '${dbName}' already exists`);
    }
    
    client.release();
  } catch (error) {
    console.error('[DATABASE] Failed to check/create database:', error);
    await defaultPool.end();
    throw error;
  }

  // Close default pool
  await defaultPool.end();

  // Connect to target database
  const targetPool = new Pool({
    ...dbConfig,
    database: dbName
  });

  try {
    const client = await targetPool.connect();
    console.log(`[DATABASE] Connected to database '${dbName}'`);
    client.release();
  } catch (error) {
    console.error('[DATABASE] Failed to connect to target database:', error);
    await targetPool.end();
    throw error;
  }

  // Create form_submissions table if it does not already exist (preserves data across restarts)
  await targetPool.query(`
    CREATE TABLE IF NOT EXISTS form_submissions (
      id TEXT PRIMARY KEY,
      form_id TEXT UNIQUE NOT NULL,
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
  `);

  // Add UNIQUE constraint on form_id if upgrading an existing table without it
  await targetPool.query(`
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'form_submissions_form_id_key'
      ) THEN
        ALTER TABLE form_submissions ADD CONSTRAINT form_submissions_form_id_key UNIQUE (form_id);
      END IF;
    END $$;
  `).catch(() => {}); // Ignore if constraint already exists

  console.log('[DATABASE] Table form_submissions ready');
  console.log('[DATABASE] Database initialization complete');
  return targetPool;
}

/**
 * Store a form submission in the database
 * 
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {Object} formData - Form data to store
 * @returns {Promise<string>} Submission ID
 */
export async function storeFormSubmission(pool, formData) {
  const filledAt = new Date().toISOString();

  // Check if a submission for this form_id already exists
  const existing = await pool.query(
    `SELECT id FROM form_submissions WHERE form_id = $1`,
    [formData.form_id]
  );

  let submissionId;
  if (existing.rows.length > 0) {
    // UPDATE existing record (no duplicate)
    submissionId = existing.rows[0].id;
    await pool.query(
      `UPDATE form_submissions SET
        requested_by = $2,
        output_owner_id = $3,
        num_server_rounds = $4,
        fraction_evaluate = $5,
        local_epochs = $6,
        learning_rate = $7,
        batch_size = $8,
        model = $9,
        framework = $10,
        components = $11,
        filled = true,
        filled_at = $12
      WHERE form_id = $1`,
      [
        formData.form_id,
        formData.requested_by,
        formData.output_owner_id,
        formData.num_server_rounds || null,
        formData.fraction_evaluate || null,
        formData.local_epochs || null,
        formData.learning_rate || null,
        formData.batch_size || null,
        formData.model || null,
        formData.framework || null,
        formData.components || {},
        filledAt
      ]
    );
    console.log('[DATABASE] Form submission UPDATED (no duplicate):', submissionId);
  } else {
    // INSERT new record
    submissionId = `gov-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    await pool.query(
      `INSERT INTO form_submissions (
        id, form_id, requested_by, output_owner_id,
        num_server_rounds, fraction_evaluate, local_epochs,
        learning_rate, batch_size, model, framework,
        components, filled, requested_at, filled_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        submissionId,
        formData.form_id,
        formData.requested_by,
        formData.output_owner_id,
        formData.num_server_rounds || null,
        formData.fraction_evaluate || null,
        formData.local_epochs || null,
        formData.learning_rate || null,
        formData.batch_size || null,
        formData.model || null,
        formData.framework || null,
        formData.components || {},
        true,
        formData.requested_at || filledAt,
        filledAt
      ]
    );
    console.log('[DATABASE] Form submission INSERTED:', submissionId);
  }

  return submissionId;
}

/**
 * Retrieve all form submissions from the database
 * 
 * @param {Pool} pool - PostgreSQL connection pool
 * @returns {Promise<Array>} Array of form submissions
 */
export async function getAllFormSubmissions(pool) {
  const result = await pool.query(
    `SELECT * FROM form_submissions ORDER BY created_at DESC`
  );

  return result.rows;
}

/**
 * Retrieve a specific form submission by ID
 * 
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} id - Submission ID
 * @returns {Promise<Object|null>} Form submission or null
 */
export async function getFormSubmissionById(pool, id) {
  const result = await pool.query(
    `SELECT * FROM form_submissions WHERE id = $1`,
    [id]
  );

  if (result.rows.length === 0) return null;

  return result.rows[0];
}

/**
 * Delete a form submission by ID
 * 
 * @param {Pool} pool - PostgreSQL connection pool
 * @param {string} id - Submission ID
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
export async function deleteFormSubmission(pool, id) {
  const result = await pool.query(
    `DELETE FROM form_submissions WHERE id = $1`,
    [id]
  );

  return result.rowCount > 0;
}

/**
 * Get all data providers (unique from data owner forms)
 * Returns mock data for now - in production would query from actual data provider registrations
 */
export async function getDataProviders(pool) {
  // For now return mock data providers
  // In production, this would query from a data_providers table
  return [
    { id: 'provider-1', name: 'Provider A', email: 'provider-a@example.com' },
    { id: 'provider-2', name: 'Provider B', email: 'provider-b@example.com' },
    { id: 'provider-3', name: 'Provider C', email: 'provider-c@example.com' }
  ];
}

/**
 * Store a provider notification message
 */
export async function storeProviderMessage(pool, messageData) {
  const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  
  // Create provider_messages table if not exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS provider_messages (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      provider_email TEXT NOT NULL,
      provider_name TEXT,
      output_owner_id TEXT NOT NULL,
      message TEXT NOT NULL,
      timestamp TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  await pool.query(
    `INSERT INTO provider_messages (id, provider_id, provider_email, provider_name, output_owner_id, message, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      messageId,
      messageData.provider_id,
      messageData.provider_email,
      messageData.provider_name,
      messageData.output_owner_id,
      messageData.message,
      messageData.timestamp
    ]
  );
  
  console.log('[DATABASE] Provider message stored:', messageId);
  return messageId;
}
