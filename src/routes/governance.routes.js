/**
 * Governance Layer Routes
 * 
 * This module defines the API endpoints for the Governance Layer.
 * The primary responsibility is to receive and store Output Owner form submissions.
 * 
 * Endpoints:
 * - POST /api/v1/form-submissions: Store Output Owner form data
 * - GET /api/v1/form-submissions: Retrieve all stored forms (for debugging)
 * 
 * @module governance.routes
 */

import express from "express";
import {
  storeFormSubmission,
  getAllFormSubmissions,
  getFormSubmissionById,
  deleteFormSubmission,
  getDataProviders,
  storeProviderMessage
} from "../services/database.service.js";

const router = express.Router();

/**
 * POST /api/v1/form-submissions
 * 
 * Receives and stores Output Owner form submissions from the AAA backend.
 * Stores data in SQLite database for persistence.
 * 
 * Request Body:
 * {
 *   payload: {
 *     form_id: string,
 *     requested_by: string,
 *     output_owner_id: string,
 *     num_server_rounds: number,
 *     fraction_evaluate: number,
 *     local_epochs: number,
 *     learning_rate: number,
 *     batch_size: number,
 *     model: string,
 *     framework: string,
 *     components: object
 *   }
 * }
 * 
 * Response:
 * {
 *   status: "SUCCESS" | "FAILED",
 *   message: string,
 *   submission_id: string (on success)
 * }
 */
router.post('/form-submissions', async (req, res) => {
  try {
    const { payload } = req.body;
    const db = req.app.locals.db;

    console.log('[GOVERNANCE] ============================================');
    console.log('[GOVERNANCE] Form submission request received');
    console.log('[GOVERNANCE] Timestamp:', new Date().toISOString());
    console.log('[GOVERNANCE] Request body:', JSON.stringify(req.body, null, 2));

    // Validate request body
    if (!payload) {
      console.log('[GOVERNANCE] ❌ Validation failed: Missing payload');
      return res.status(400).json({
        status: 'FAILED',
        error: 'MISSING_PAYLOAD',
        message: 'Request body must contain a payload object'
      });
    }

    // Validate required fields
    const requiredFields = ['form_id', 'requested_by', 'output_owner_id'];
    const missingFields = requiredFields.filter(field => !payload[field]);
    
    if (missingFields.length > 0) {
      console.log('[GOVERNANCE] ❌ Validation failed: Missing fields:', missingFields);
      return res.status(400).json({
        status: 'FAILED',
        error: 'MISSING_REQUIRED_FIELDS',
        message: `Missing required fields: ${missingFields.join(', ')}`
      });
    }

    console.log('[GOVERNANCE] ✅ Validation passed');
    console.log('[GOVERNANCE] Form ID:', payload.form_id);
    console.log('[GOVERNANCE] Output Owner ID:', payload.output_owner_id);
    console.log('[GOVERNANCE] Requested By:', payload.requested_by);
    console.log('[GOVERNANCE] Model:', payload.model);
    console.log('[GOVERNANCE] Framework:', payload.framework);
    console.log('[GOVERNANCE] Num Server Rounds:', payload.num_server_rounds);
    console.log('[GOVERNANCE] Local Epochs:', payload.local_epochs);
    console.log('[GOVERNANCE] Learning Rate:', payload.learning_rate);
    console.log('[GOVERNANCE] Batch Size:', payload.batch_size);

    // Store in database
    console.log('[GOVERNANCE] Storing form in database...');
    const submissionId = await storeFormSubmission(db, payload);

    console.log('[GOVERNANCE] ✅ Form stored successfully');
    console.log('[GOVERNANCE] Submission ID:', submissionId);
    console.log('[GOVERNANCE] ============================================');

    // Return success response
    return res.status(201).json({
      status: 'SUCCESS',
      message: 'Form submission stored successfully',
      submission_id: submissionId
    });

  } catch (error) {
    console.error('[GOVERNANCE] ❌ Error processing form submission:', error);
    console.error('[GOVERNANCE] Error details:', error.message);
    console.error('[GOVERNANCE] Stack trace:', error.stack);
    console.log('[GOVERNANCE] ============================================');
    return res.status(500).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      message: 'Failed to process form submission'
    });
  }
});

/**
 * GET /api/v1/form-submissions
 * 
 * Retrieves all stored form submissions from the database.
 * This endpoint is primarily for debugging and monitoring purposes.
 * 
 * Response:
 * {
 *   status: "SUCCESS",
 *   count: number,
 *   submissions: Array<FormData>
 * }
 */
router.get('/form-submissions', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const submissions = await getAllFormSubmissions(db);
    
    console.log(`[GOVERNANCE] Retrieved ${submissions.length} form submissions`);

    return res.status(200).json({
      status: 'SUCCESS',
      count: submissions.length,
      submissions: submissions
    });

  } catch (error) {
    console.error('[GOVERNANCE] Error retrieving form submissions:', error);
    return res.status(500).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve form submissions'
    });
  }
});

/**
 * GET /api/v1/form-submissions/export
 *
 * Downloads all data provider form submissions as a JSON file.
 */
router.get('/form-submissions/export', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const submissions = await getAllFormSubmissions(db);

    const exportData = {
      exported_at: new Date().toISOString(),
      count: submissions.length,
      submissions: submissions
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="data_provider_forms.json"');
    return res.status(200).json(exportData);

  } catch (error) {
    console.error('[GOVERNANCE] Error exporting form submissions:', error);
    return res.status(500).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      message: 'Failed to export form submissions'
    });
  }
});

/**
 * GET /api/v1/form-submissions/:id
 * 
 * Retrieves a specific form submission by ID from the database.
 * 
 * Response:
 * {
 *   status: "SUCCESS" | "FAILED",
 *   submission: FormData | null
 * }
 */
router.get('/form-submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.locals.db;
    const submission = await getFormSubmissionById(db, id);

    if (!submission) {
      return res.status(404).json({
        status: 'FAILED',
        error: 'NOT_FOUND',
        message: 'Form submission not found'
      });
    }

    return res.status(200).json({
      status: 'SUCCESS',
      submission: submission
    });

  } catch (error) {
    console.error('[GOVERNANCE] Error retrieving form submission:', error);
    return res.status(500).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve form submission'
    });
  }
});

/**
 * DELETE /api/v1/form-submissions/:id
 * 
 * Deletes a specific form submission by ID from the database.
 * This endpoint is for administrative purposes.
 * 
 * Response:
 * {
 *   status: "SUCCESS" | "FAILED",
 *   message: string
 * }
 */
router.delete('/form-submissions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.locals.db;
    const deleted = await deleteFormSubmission(db, id);

    if (!deleted) {
      return res.status(404).json({
        status: 'FAILED',
        error: 'NOT_FOUND',
        message: 'Form submission not found'
      });
    }

    console.log(`[GOVERNANCE] Deleted form submission: ${id}`);

    return res.status(200).json({
      status: 'SUCCESS',
      message: 'Form submission deleted successfully'
    });

  } catch (error) {
    console.error('[GOVERNANCE] Error deleting form submission:', error);
    return res.status(500).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      message: 'Failed to delete form submission'
    });
  }
});

/**
 * GET /p3dx/api/v1/data-providers
 * 
 * Retrieves all available data providers for federated learning
 */
router.get('/data-providers', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const providers = await getDataProviders(db);
    
    console.log(`[GOVERNANCE] Retrieved ${providers.length} data providers`);
    
    return res.status(200).json({
      status: 'SUCCESS',
      data_providers: providers
    });
  } catch (error) {
    console.error('[GOVERNANCE] Error retrieving data providers:', error);
    return res.status(500).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve data providers'
    });
  }
});

/**
 * POST /api/v1/send-provider-message
 * 
 * Sends a notification message to selected data providers
 */
router.post('/send-provider-message', async (req, res) => {
  try {
    const { provider_id, provider_email, provider_name, output_owner_id, message, timestamp } = req.body;
    const db = req.app.locals.db;
    
    console.log('[GOVERNANCE] ============================================');
    console.log('[GOVERNANCE] Provider message request received');
    console.log('[GOVERNANCE] Provider:', provider_name, '(' + provider_email + ')');
    console.log('[GOVERNANCE] Output Owner:', output_owner_id);
    console.log('[GOVERNANCE] Message:', message);
    
    // Validate request
    if (!provider_id || !provider_email) {
      console.log('[GOVERNANCE] ❌ Validation failed: Missing provider info');
      return res.status(400).json({
        status: 'FAILED',
        error: 'MISSING_PROVIDER_INFO',
        message: 'provider_id and provider_email are required'
      });
    }
    
    // Store the message in database
    const messageId = await storeProviderMessage(db, {
      provider_id,
      provider_email,
      provider_name,
      output_owner_id,
      message,
      timestamp
    });
    
    console.log('[GOVERNANCE] ✅ Message stored successfully');
    console.log('[GOVERNANCE] Message ID:', messageId);
    console.log('[GOVERNANCE] ============================================');
    
    return res.status(200).json({
      status: 'success',
      message: 'Message sent to provider',
      message_id: messageId,
      data: {
        provider_id,
        provider_name,
        provider_email,
        message
      }
    });
  } catch (error) {
    console.error('[GOVERNANCE] ❌ Error sending provider message:', error);
    return res.status(500).json({
      status: 'FAILED',
      error: 'INTERNAL_ERROR',
      message: 'Failed to send provider message'
    });
  }
});

/**
 * Export the router for use in the Express application
 */
export default router;
