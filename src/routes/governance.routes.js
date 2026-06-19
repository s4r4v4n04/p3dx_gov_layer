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
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import {
  storeFormSubmission,
  getAllFormSubmissions,
  getFormSubmissionById,
  deleteFormSubmission,
  getDataProviders,
  storeProviderMessage,
  storeDataProviderForm,
  getAllDataProviderForms,
  getDataProviderFormsByUsernames,
  getLatestSessionForProvider,
  createNotification,
  getNotificationsForUser,
  markNotificationAsRead,
  storeSessionReport,
  getSessionReport,
} from "../services/database.service.js";

const router = express.Router();

// Location of the distribution script (repo root, two levels above p3dx_gov_layer/src).
// Override with DISTRIBUTE_SCRIPT if the layout differs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISTRIBUTE_SCRIPT =
  process.env.DISTRIBUTE_SCRIPT ||
  path.resolve(__dirname, "../../../send_output_owner_config.sh");

// Submission/form ids are embedded in a shell-out; restrict to a safe charset.
const SAFE_ID = /^[A-Za-z0-9._-]+$/;

// FedML client config template (repo: fedml-ng-release-v1.0/src/config/client_config.yaml).
const CLIENT_CONFIG_TEMPLATE =
  process.env.CLIENT_CONFIG_TEMPLATE ||
  path.resolve(__dirname, "../../../fedml-ng-release-v1.0/src/config/client_config.yaml");

// HTTP push (POST /push-config): the path on each provider's receiver, an
// optional shared secret sent as X-Auth-Token, and the per-target timeout.
const PROVIDER_RECEIVER_PATH = process.env.PROVIDER_RECEIVER_PATH || "/update-config";
const PUSH_AUTH_TOKEN = process.env.PUSH_AUTH_TOKEN || "";
const PUSH_TIMEOUT_MS = Number(process.env.PUSH_TIMEOUT_MS || 15000);

/**
 * Render client_config.yaml with the output-owner IP written into BOTH
 * comm_config.mqtt_discovery.broker_host and comm_config.grpc_discovery.host.
 * Only those two lines change — section headers, comments, ports and every other
 * field are preserved (mirrors the section-aware editor in send_output_owner_config.sh).
 */
function renderClientConfig(src, ownerIp) {
  const edits = {
    grpc_discovery: { host: ownerIp },
    mqtt_discovery: { broker_host: ownerIp },
  };
  const secRe = /^( {2})([A-Za-z_]+):\s*(#.*)?$/; // 2-space section header
  let section = null;
  return src
    .split("\n")
    .map((line) => {
      const m = line.match(secRe);
      if (m) {
        section = m[2];
        return line;
      }
      if (section && edits[section]) {
        for (const [key, val] of Object.entries(edits[section])) {
          const kv = line.match(new RegExp(`^(\\s*${key}:\\s+)(\\S+)(\\s*(?:#.*)?)$`));
          if (kv) return `${kv[1]}${val}${kv[3]}`;
        }
      }
      return line;
    })
    .join("\n");
}

/**
 * Serve the rendered config for a given output-owner submission as a YAML download.
 * Returns 409 if that submission has no ip_address (nothing to put in the hosts).
 */
function sendRenderedConfig(res, submission) {
  const ownerIp = submission.ip_address;
  if (!ownerIp) {
    return res.status(409).json({
      status: "FAILED",
      error: "NO_OWNER_IP",
      message: "The output owner has not set an IP address for this session yet.",
    });
  }
  let template;
  try {
    template = fs.readFileSync(CLIENT_CONFIG_TEMPLATE, "utf8");
  } catch (e) {
    return res.status(500).json({ status: "FAILED", error: "TEMPLATE_NOT_FOUND", message: e.message });
  }
  const yaml = renderClientConfig(template, ownerIp);
  res.setHeader("Content-Type", "application/x-yaml; charset=utf-8");
  res.setHeader("Content-Disposition", 'attachment; filename="client_config.yaml"');
  return res.status(200).send(yaml);
}

/**
 * Build the combined FL session report from a stored output-owner submission and
 * the latest data-provider form for each selected provider.
 *
 * Includes the full set of fields for both sides so the downloaded report is a
 * complete record of the session configuration.
 *
 * @param {Object} submission - A row from form_submissions
 * @param {Array}  providerForms - Rows from data_provider_forms (latest per provider)
 * @returns {Object} The combined report object
 */
function buildCombinedReport(submission, providerForms) {
  return {
    generated_at: new Date().toISOString(),
    submission_id: submission.id,
    form_id: submission.form_id,
    output_owner: {
      username: submission.output_owner_id,
      requested_by: submission.requested_by,
      ip_address: submission.ip_address,
      port: submission.port,
      model: submission.model,
      framework: submission.framework,
      num_server_rounds: submission.num_server_rounds,
      fraction_evaluate: submission.fraction_evaluate,
      local_epochs: submission.local_epochs,
      learning_rate: submission.learning_rate,
      batch_size: submission.batch_size,
      components: submission.components,
    },
    data_providers: (providerForms || []).map(f => ({
      data_owner_id: f.data_owner_id,
      ram: f.ram,
      memory_mb: f.memory_mb,
      data_size_bytes: f.data_size_bytes,
      data_resource_id: f.data_resource_id,
      ip_address: f.ip_address,
      port: f.port,
    })),
  };
}

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

    // Build and persist the combined session report (output owner + selected data
    // providers) so it can be downloaded at any time. A failure here must not lose
    // the form submission itself — the download endpoint can rebuild on the fly.
    try {
      const submission = await getFormSubmissionById(db, submissionId);
      const usernames = (submission.selected_providers || [])
        .map(p => p.username)
        .filter(Boolean);
      const providerForms = await getDataProviderFormsByUsernames(db, usernames);
      const report = buildCombinedReport(submission, providerForms);
      await storeSessionReport(db, {
        submissionId,
        formId: submission.form_id,
        outputOwnerId: submission.output_owner_id,
        report,
      });
      console.log('[GOVERNANCE] ✅ Session report persisted for submission:', submissionId);
    } catch (reportErr) {
      console.error('[GOVERNANCE] ⚠ Failed to persist session report:', reportErr.message);
    }

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
 * POST /api/v1/data-provider-forms
 * Stores a data provider's form submission in the governance layer DB.
 */
router.post('/data-provider-forms', async (req, res) => {
  try {
    const { payload } = req.body;
    const db = req.app.locals.db;

    if (!payload) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_PAYLOAD' });
    }

    console.log('[GOVERNANCE] Data provider form received:', JSON.stringify(payload, null, 2));

    const id = await storeDataProviderForm(db, payload);

    console.log('[GOVERNANCE] ✅ Data provider form stored:', id);
    return res.status(201).json({ status: 'SUCCESS', submission_id: id });
  } catch (error) {
    console.error('[GOVERNANCE] Error storing data provider form:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * GET /api/v1/data-provider-forms
 * Lists all data provider form submissions.
 */
router.get('/data-provider-forms', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const forms = await getAllDataProviderForms(db);
    return res.status(200).json({ status: 'SUCCESS', count: forms.length, forms });
  } catch (error) {
    console.error('[GOVERNANCE] Error fetching data provider forms:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

// POST /api/v1/notifications — create notifications for multiple recipients in parallel
router.post('/notifications', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { recipients, senderUsername, message, payload } = req.body;

    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_RECIPIENTS' });
    }

    // Send to all recipients in parallel
    const results = await Promise.all(
      recipients.map(r =>
        createNotification(db, {
          recipientId: r.id,
          recipientUsername: r.username,
          senderUsername,
          message,
          payload,
        })
      )
    );

    return res.status(201).json({ status: 'SUCCESS', created: results.length, notifications: results });
  } catch (error) {
    console.error('[GOVERNANCE] Error creating notifications:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

// GET /api/v1/notifications/:username — fetch notifications for a user
router.get('/notifications/:username', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { username } = req.params;
    const rows = await getNotificationsForUser(db, username);
    return res.json({ status: 'SUCCESS', notifications: rows });
  } catch (error) {
    console.error('[GOVERNANCE] Error fetching notifications:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR' });
  }
});

// PATCH /api/v1/notifications/:id/read — mark a notification as read
router.patch('/notifications/:id/read', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;
    const { username } = req.body;
    const updated = await markNotificationAsRead(db, id, username);
    if (!updated) return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND' });
    return res.json({ status: 'SUCCESS', notification: updated });
  } catch (error) {
    console.error('[GOVERNANCE] Error marking notification read:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR' });
  }
});

/**
 * GET /api/v1/form-submissions/:id/report
 *
 * Returns the persisted combined JSON report for a submission: the output owner's
 * form plus the full details of each selected data provider. Served from the
 * session_reports table. For submissions stored before reports were persisted,
 * the report is rebuilt on the fly and saved so future downloads are served from
 * the stored record. Intended for download as a JSON file.
 */
router.get('/form-submissions/:id/report', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.locals.db;

    // Prefer the persisted report.
    let report = await getSessionReport(db, id);

    if (!report) {
      // Fallback: rebuild from source tables and persist for next time.
      const submission = await getFormSubmissionById(db, id);
      if (!submission) {
        return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND' });
      }

      const selectedProviders = submission.selected_providers || [];
      const usernames = selectedProviders.map(p => p.username).filter(Boolean);
      const providerForms = await getDataProviderFormsByUsernames(db, usernames);

      report = buildCombinedReport(submission, providerForms);

      try {
        await storeSessionReport(db, {
          submissionId: id,
          formId: submission.form_id,
          outputOwnerId: submission.output_owner_id,
          report,
        });
      } catch (persistErr) {
        console.error('[GOVERNANCE] ⚠ Failed to persist rebuilt report:', persistErr.message);
      }
    }

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="fl_session_${id}.json"`);
    return res.status(200).json(report);
  } catch (error) {
    console.error('[GOVERNANCE] Error generating report:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * POST /api/v1/distribute-config
 *
 * Renders client_config.yaml with the output owner's IP written into both the
 * MQTT broker_host and the gRPC host, then scp's it to each data provider the
 * owner selected. Runs send_output_owner_config.sh on the host (the browser
 * cannot scp). By default targets the owner's selected providers; pass
 * { all_providers: true } to fan out to every registered provider instead.
 *
 * Request Body: { submission_id?: string, form_id?: string, all_providers?: boolean }
 *   exactly one of submission_id / form_id identifies the owner submission.
 *
 * Response: { status: 'SUCCESS' | 'PARTIAL' | 'FAILED', summary?, output }
 *   summary = { sent, failed, skipped } parsed from the script's final line.
 */
router.post('/distribute-config', async (req, res) => {
  try {
    const { submission_id, form_id, all_providers } = req.body || {};

    if (!submission_id && !form_id) {
      return res.status(400).json({
        status: 'FAILED', error: 'MISSING_SELECTOR',
        message: 'submission_id or form_id is required',
      });
    }
    if (submission_id && !SAFE_ID.test(submission_id)) {
      return res.status(400).json({ status: 'FAILED', error: 'INVALID_SUBMISSION_ID' });
    }
    if (form_id && !SAFE_ID.test(form_id)) {
      return res.status(400).json({ status: 'FAILED', error: 'INVALID_FORM_ID' });
    }

    // execFile (no shell) + arg array => the ids cannot be interpreted by a shell.
    const args = [DISTRIBUTE_SCRIPT];
    if (submission_id) args.push('--submission-id', submission_id);
    else args.push('--form-id', form_id);
    if (all_providers === true) args.push('--all-providers');

    console.log('[GOVERNANCE] distribute-config:', 'bash', args.join(' '));

    execFile('bash', args, { timeout: 180000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const output = `${stdout || ''}${stderr || ''}`.trim();
      // Final line: "Done. ok=N fail=M skipped(...)=K   configs in: ..."
      const m = output.match(/ok=(\d+)\s+fail=(\d+)\s+skipped[^=]*=(\d+)/);
      const summary = m ? { sent: +m[1], failed: +m[2], skipped: +m[3] } : null;

      // The script exits non-zero when any send fails; that's still a useful
      // result as long as we got a summary line. Only treat it as a hard error
      // when there's no summary at all (e.g. bad selector, DB unreachable).
      if (err && !summary) {
        console.error('[GOVERNANCE] distribute-config failed:', err.message);
        return res.status(500).json({
          status: 'FAILED', error: 'DISTRIBUTE_ERROR',
          message: err.message, output,
        });
      }

      return res.status(200).json({
        status: summary && summary.failed === 0 ? 'SUCCESS' : 'PARTIAL',
        summary,
        output,
      });
    });
  } catch (error) {
    console.error('[GOVERNANCE] Error in distribute-config:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * POST /api/v1/push-config
 *
 * HTTP push (no SSH): renders client_config.yaml with the output owner's IP and
 * POSTs it to each selected provider's receiver at http://<ip>:<port><PATH>.
 * The provider runs provider_config_receiver.py, which writes the file locally.
 *
 * The destination ip/port come from each provider's latest data_provider_forms
 * row (the IP Address + Port they registered). Providers missing an ip or port
 * are reported as skipped.
 *
 * Request Body: { submission_id: string }
 * Response: { status: 'SUCCESS'|'PARTIAL'|'FAILED', summary:{sent,failed,skipped}, results:[...] }
 */
router.post('/push-config', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { submission_id } = req.body || {};

    if (!submission_id) {
      return res.status(400).json({ status: 'FAILED', error: 'MISSING_SELECTOR', message: 'submission_id is required' });
    }
    if (!SAFE_ID.test(submission_id)) {
      return res.status(400).json({ status: 'FAILED', error: 'INVALID_SUBMISSION_ID' });
    }

    const submission = await getFormSubmissionById(db, submission_id);
    if (!submission) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND', message: 'Submission not found' });
    }
    const ownerIp = submission.ip_address;
    if (!ownerIp) {
      return res.status(409).json({
        status: 'FAILED', error: 'NO_OWNER_IP',
        message: 'The output owner has not set an IP address for this session yet.',
      });
    }

    const selected = (submission.selected_providers || [])
      .map(p => p && p.username).filter(Boolean);
    if (selected.length === 0) {
      return res.status(200).json({
        status: 'FAILED', error: 'NO_PROVIDERS',
        message: 'This session has no selected providers.',
        summary: { sent: 0, failed: 0, skipped: 0 }, results: [],
      });
    }

    let template;
    try {
      template = fs.readFileSync(CLIENT_CONFIG_TEMPLATE, 'utf8');
    } catch (e) {
      return res.status(500).json({ status: 'FAILED', error: 'TEMPLATE_NOT_FOUND', message: e.message });
    }
    const yaml = renderClientConfig(template, ownerIp);

    // Latest data_provider_forms row per selected provider -> ip/port targets.
    const forms = await getDataProviderFormsByUsernames(db, selected);
    const byUser = new Map(forms.map(f => [f.data_owner_id, f]));

    const headers = { 'Content-Type': 'application/x-yaml' };
    if (PUSH_AUTH_TOKEN) headers['X-Auth-Token'] = PUSH_AUTH_TOKEN;

    // Push to all providers in parallel; never throw — collect a per-target result.
    const results = await Promise.all(selected.map(async (username) => {
      const f = byUser.get(username);
      const ip = f && f.ip_address;
      const port = f && f.port;
      if (!ip || !port) {
        return { username, ip: ip || null, port: port || null, status: 'skipped', reason: 'no registered ip/port' };
      }
      const url = `http://${ip}:${port}${PROVIDER_RECEIVER_PATH}`;
      try {
        const resp = await fetch(url, {
          method: 'POST', headers, body: yaml,
          signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
        });
        const ok = resp.ok;
        let detail; try { detail = await resp.text(); } catch { detail = ''; }
        return { username, ip, port, url, status: ok ? 'sent' : 'failed', http: resp.status,
                 detail: detail && detail.slice(0, 200) };
      } catch (e) {
        return { username, ip, port, url, status: 'failed', reason: e.message };
      }
    }));

    const sent = results.filter(r => r.status === 'sent').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const status = sent > 0 && failed === 0 ? 'SUCCESS' : sent > 0 ? 'PARTIAL' : 'FAILED';

    console.log(`[GOVERNANCE] push-config ${submission_id}: sent=${sent} failed=${failed} skipped=${skipped}`);
    return res.status(200).json({ status, summary: { sent, failed, skipped }, results });
  } catch (error) {
    console.error('[GOVERNANCE] Error in push-config:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * GET /api/v1/client-config/by-submission/:submissionId
 *
 * Owner-side preview/download: returns client_config.yaml rendered with this
 * submission's output-owner IP. (Registered before the :username route; it has a
 * deeper path so there is no ambiguity.)
 */
router.get('/client-config/by-submission/:submissionId', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const submission = await getFormSubmissionById(db, req.params.submissionId);
    if (!submission) {
      return res.status(404).json({ status: 'FAILED', error: 'NOT_FOUND', message: 'Submission not found' });
    }
    return sendRenderedConfig(res, submission);
  } catch (error) {
    console.error('[GOVERNANCE] client-config by-submission error:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * GET /api/v1/client-config/:username[?submission_id=...]
 *
 * Data-provider pull: returns client_config.yaml with the output-owner IP in the
 * MQTT broker_host and the gRPC host. Without submission_id, uses the most recent
 * session that selected this provider (and has an owner IP). The provider must be
 * part of the session, otherwise 403.
 */
router.get('/client-config/:username', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { username } = req.params;
    const { submission_id } = req.query;

    const submission = submission_id
      ? await getFormSubmissionById(db, submission_id)
      : await getLatestSessionForProvider(db, username);

    if (!submission) {
      return res.status(404).json({
        status: 'FAILED', error: 'NO_SESSION',
        message: 'No FL session with an owner IP has selected this provider yet.',
      });
    }

    const isSelected = (submission.selected_providers || []).some(p => p && p.username === username);
    if (!isSelected) {
      return res.status(403).json({
        status: 'FAILED', error: 'NOT_SELECTED',
        message: 'This provider is not part of the requested session.',
      });
    }

    return sendRenderedConfig(res, submission);
  } catch (error) {
    console.error('[GOVERNANCE] client-config error:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * Export the router for use in the Express application
 */
export default router;
