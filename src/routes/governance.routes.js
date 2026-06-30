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
import { execFile, spawn } from "child_process";
import fs from "fs";
import os from "os";
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
import { authHeaders } from "../services/keycloak.service.js";

const router = express.Router();

// Location of the distribution script (repo root, two levels above p3dx_gov_layer/src).
// Override with DISTRIBUTE_SCRIPT if the layout differs.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DISTRIBUTE_SCRIPT =
  process.env.DISTRIBUTE_SCRIPT ||
  path.resolve(__dirname, "../../../send_output_owner_config.sh");

// Env provisioning (POST /provision-env): HTTP fan-out to each selected
// provider's receiver, which creates the venv + installs requirements locally
// (same transport as push-config; no SSH). pip installs are slow, so this gets
// a much longer per-target timeout than the config push.
const PROVIDER_PROVISION_PATH = process.env.PROVIDER_PROVISION_PATH || "/provision-env";
const PROVISION_TIMEOUT_MS = Number(process.env.PROVISION_TIMEOUT_MS || 600000);
// Empty => let each provider's receiver decide (it creates "venv" next to itself).
// Set PROVISION_ENV_PATH only to force a specific path on every provider.
const PROVISION_ENV_PATH = process.env.PROVISION_ENV_PATH || "";
// requirements.txt installed into each provider's venv; sent in the request body
// when present. Providers run flo_client.py, so this is the CLIENT requirements
// (the owner side installs src/server/requirements.txt via output_owner_env_receiver).
const PROVISION_REQUIREMENTS =
  process.env.PROVISION_REQUIREMENTS ||
  path.resolve(__dirname, "../../../fedml-ng-release-v1.0/src/client/requirements.txt");

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

// Start-FL-session (POST /start-fl-session): the output owner is THIS host, so
// flo_server.py and flo_session.py are launched locally in the existing venv;
// each selected provider's receiver is asked to launch flo_client.py.
const FEDML_SRC = process.env.FEDML_SRC || path.resolve(__dirname, "../../../fedml-ng-release-v1.0/src");
const FEDML_VENV_PY = process.env.FEDML_VENV_PY || path.resolve(__dirname, "../../../venv/bin/python");
// Output owner is NOT necessarily this host: it is whatever ip:port the owner
// entered on their form (form_submissions.ip_address / .port), where they run
// output_owner_env_receiver.py. start-fl-session POSTs to that receiver to build
// the venv (/provision-env, installing OWNER_REQUIREMENTS = server requirements)
// and to launch flo_server.py (/start-server) ON THE OWNER HOST. When the form
// carries no ip/port we fall back to OWNER_ENV_RECEIVER_FALLBACK (single-host:
// owner == this host).
const OWNER_RECEIVER_PROVISION_PATH = process.env.OWNER_RECEIVER_PROVISION_PATH || "/provision-env";
const OWNER_RECEIVER_START_SERVER_PATH = process.env.OWNER_RECEIVER_START_SERVER_PATH || "/start-server";
const OWNER_RECEIVER_START_SESSION_PATH = process.env.OWNER_RECEIVER_START_SESSION_PATH || "/start-session";
const OWNER_ENV_RECEIVER_FALLBACK = (process.env.OWNER_ENV_RECEIVER_URL || "http://localhost:8090")
  .replace(/\/provision-env\/?$/, "").replace(/\/$/, "");
// Server requirements installed into the owner venv (the client requirements go to
// providers via PROVISION_REQUIREMENTS).
const OWNER_REQUIREMENTS =
  process.env.OWNER_REQUIREMENTS ||
  path.resolve(__dirname, "../../../fedml-ng-release-v1.0/src/server/requirements.txt");
const FL_SESSION_CONFIG = process.env.FL_SESSION_CONFIG || "../config/flotilla_quicksetup_config.yaml";
const FL_SERVER_ENDPOINT = process.env.FL_SERVER_ENDPOINT || "localhost:12345";
const FL_LOG_DIR = process.env.FL_LOG_DIR || path.resolve(__dirname, "../../../logs");
const PROVIDER_START_CLIENT_PATH = process.env.PROVIDER_START_CLIENT_PATH || "/start-client";
// Sequencing: let the server come up before clients connect, and clients
// register before the session command tells the server to begin.
const FL_CLIENT_DELAY_MS = Number(process.env.FL_CLIENT_DELAY_MS || 5000);
// Wait after launching clients so they register with the server before flo_session.py
// kicks off the round (default 30s).
const FL_SESSION_DELAY_MS = Number(process.env.FL_SESSION_DELAY_MS || 30000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const shQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

// IPs that mean "this gov_layer host". Used to rewrite the owner receiver address
// to loopback when the owner is co-located with gov_layer: a VM cannot reach its
// OWN public IP (no hairpin NAT on most clouds incl. Azure), so a form that names
// this host's public IP must be dialed via 127.0.0.1 instead. The client_config
// pushed to providers still uses the form's public IP (providers reach it fine).
// Auto-includes every local interface IP; extend with OWNER_SELF_IPS (CSV) for
// public IP(s) that aren't bound to a local interface (the typical cloud case).
const SELF_IPS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);
for (const ifaces of Object.values(os.networkInterfaces())) {
  for (const ni of ifaces || []) SELF_IPS.add(ni.address);
}
for (const ip of (process.env.OWNER_SELF_IPS || "").split(",")) {
  const t = ip.trim();
  if (t) SELF_IPS.add(t);
}
// Best-effort: discover this host's PUBLIC IP at startup and treat it as self too,
// so a public IP entered in the form "just works" no matter how gov_layer was
// started (the OWNER_SELF_IPS env var is easy to forget). Fire-and-forget; both
// lookups populate well before any user-triggered start-fl-session. Tries Azure
// IMDS first, then generic public-IP services.
(async () => {
  const addIp = (ip) => { const t = (ip || "").trim(); if (/^\d{1,3}(\.\d{1,3}){3}$/.test(t)) SELF_IPS.add(t); };
  // Azure IMDS (may report empty when the public IP lives on the load balancer).
  try {
    const r = await fetch(
      "http://169.254.169.254/metadata/instance/network/interface?api-version=2021-02-01",
      { headers: { Metadata: "true" }, signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const data = await r.json();
      for (const iface of data || [])
        for (const ipcfg of iface?.ipv4?.ipAddress || []) addIp(ipcfg.publicIpAddress);
    }
  } catch { /* not on Azure / IMDS unreachable */ }
  // Generic public-IP services (work off-Azure / when IMDS returns nothing).
  for (const url of ["https://api.ipify.org", "https://ifconfig.me/ip"]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
      if (r.ok) { addIp((await r.text())); break; }
    } catch { /* offline — rely on interfaces + OWNER_SELF_IPS */ }
  }
})();

// Rewrite an IP that names THIS host (see SELF_IPS) to loopback, so a receiver
// co-located with gov_layer is reachable despite no hairpin NAT. Remote IPs pass
// through unchanged. Used for both the owner and the providers.
function reachableHost(ip) {
  return SELF_IPS.has(ip) ? "127.0.0.1" : ip;
}

// Base URL of the output owner's receiver, taken from THEIR form (ip:port). The
// owner can be any host; falls back to OWNER_ENV_RECEIVER_FALLBACK (this host)
// only when the form carries no ip/port.
function ownerBaseUrl(submission) {
  const ip = submission && submission.ip_address;
  const port = submission && submission.port;
  if (ip && port) return `http://${reachableHost(ip)}:${port}`;
  return OWNER_ENV_RECEIVER_FALLBACK;
}

// Auth headers for a call to an FL receiver: a Keycloak service-account Bearer
// token when configured, else the legacy static X-Auth-Token (PUSH_AUTH_TOKEN).
// Async because the Bearer token is fetched/refreshed from Keycloak.
async function ownerAuthHeaders() {
  return authHeaders({ "Content-Type": "application/json" }, PUSH_AUTH_TOKEN);
}

// Build the output-owner FL env by POSTing to output_owner_env_receiver.py on the
// OWNER host (ip:port from the form). That receiver creates the venv + installs the
// server requirements we send. Returns { ok, url, env_path, installed, stage?,
// detail? }. Never throws.
async function provisionOwnerEnv(submission) {
  const url = `${ownerBaseUrl(submission)}${OWNER_RECEIVER_PROVISION_PATH}`;
  let requirements = "";
  try { requirements = fs.readFileSync(OWNER_REQUIREMENTS, "utf8"); } catch { requirements = ""; }
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: await ownerAuthHeaders(),
      body: JSON.stringify({ requirements }), // authoritative server requirements
      signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
    });
    let data = {};
    try { data = await resp.json(); } catch { data = {}; }
    if (!resp.ok || data.status !== "provisioned" || !data.env_path) {
      return { ok: false, url, stage: data.stage || "receiver",
               detail: data.detail || data.message || `HTTP ${resp.status}` };
    }
    return { ok: true, url, env_path: data.env_path, installed: !!data.requirements_installed };
  } catch (e) {
    return { ok: false, url, stage: "receiver",
             detail: `output-owner env receiver unreachable at ${url}: ${e.message}` };
  }
}

// Launch flo_server.py ON THE OWNER HOST by POSTing to its receiver's /start-server.
// The receiver runs it detached in the provisioned venv. Returns { ok, url, pid,
// log, detail? }. Never throws.
async function startOwnerServer(submission) {
  const url = `${ownerBaseUrl(submission)}${OWNER_RECEIVER_START_SERVER_PATH}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: await ownerAuthHeaders(),
      body: "{}",
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    let data = {};
    try { data = await resp.json(); } catch { data = {}; }
    if (!resp.ok || data.status !== "started") {
      return { ok: false, url, detail: (data && (data.detail || data.message)) || `HTTP ${resp.status}` };
    }
    return { ok: true, url, pid: data.pid, log: data.log };
  } catch (e) {
    return { ok: false, url, detail: `output-owner server receiver unreachable at ${url}: ${e.message}` };
  }
}

// Kick off the FL round by running flo_session.py ON THE OWNER HOST (POST
// /start-session). flo_session runs alongside flo_server, so server_endpoint is
// localhost:12345. Returns { ok, url, pid, log, detail? }. Never throws.
async function startOwnerSession(submission) {
  const url = `${ownerBaseUrl(submission)}${OWNER_RECEIVER_START_SESSION_PATH}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: await ownerAuthHeaders(),
      body: JSON.stringify({ config: FL_SESSION_CONFIG, server_endpoint: FL_SERVER_ENDPOINT }),
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    let data = {};
    try { data = await resp.json(); } catch { data = {}; }
    if (!resp.ok || data.status !== "started") {
      return { ok: false, url, detail: (data && (data.detail || data.message)) || `HTTP ${resp.status}` };
    }
    return { ok: true, url, pid: data.pid, log: data.log };
  } catch (e) {
    return { ok: false, url, detail: `output-owner session receiver unreachable at ${url}: ${e.message}` };
  }
}

// Launch a command as a DETACHED background process (no tmux). stdout+stderr are
// redirected to logFile; the process survives the gov_layer request. Watch it
// with `tail -f <logFile>`. Returns { ok, pid, log, error? }.
function launchDetached(argv, cwd, logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const out = fs.openSync(logFile, "a");
    const child = spawn(argv[0], argv.slice(1), {
      cwd, detached: true, stdio: ["ignore", out, out],
    });
    child.unref();
    fs.closeSync(out);
    return { ok: true, pid: child.pid, log: logFile };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

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
 * Provision a python venv (+ optional requirements install) on each selected
 * provider by HTTP-POSTing to its receiver's /provision-env. The receiver runs
 * `python3 -m venv` + pip install locally on the provider VM (no SSH). Targets
 * ip:port from each provider's latest data_provider_forms row. Never throws —
 * returns { status, summary:{ok,failed,skipped}, results:[...] }.
 *
 * Shared by POST /provision-env and step 0 of POST /start-fl-session.
 */
async function provisionProviders(db, selected) {
  // Optional requirements.txt — sent in the body so the receiver can pip install
  // it. Absent file is fine: providers just get an empty venv.
  let requirements = '';
  try { requirements = fs.readFileSync(PROVISION_REQUIREMENTS, 'utf8'); }
  catch { requirements = ''; }
  const reqNote = requirements ? `${PROVISION_REQUIREMENTS}` : 'none (empty venv)';
  console.log(`[GOVERNANCE] provision: env=${PROVISION_ENV_PATH || 'receiver default (./venv)'} requirements=${reqNote} providers=${selected.length}`);

  // Omit env_path unless explicitly configured, so each receiver creates "venv"
  // in its own directory.
  const payload = { requirements };
  if (PROVISION_ENV_PATH) payload.env_path = PROVISION_ENV_PATH;
  const body = JSON.stringify(payload);
  const headers = await authHeaders({ 'Content-Type': 'application/json' }, PUSH_AUTH_TOKEN);

  const forms = await getDataProviderFormsByUsernames(db, selected);
  const byUser = new Map(forms.map(f => [f.data_owner_id, f]));

  // Provision all providers in parallel; never throw — collect a per-target result.
  const results = await Promise.all(selected.map(async (username) => {
    const f = byUser.get(username);
    const ip = f && f.ip_address;
    const port = f && f.port;
    if (!ip || !port) {
      return { username, ip: ip || null, port: port || null, status: 'skipped', reason: 'no registered ip/port' };
    }
    const url = `http://${reachableHost(ip)}:${port}${PROVIDER_PROVISION_PATH}`;
    try {
      const resp = await fetch(url, {
        method: 'POST', headers, body,
        signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
      });
      let detail; try { detail = await resp.text(); } catch { detail = ''; }
      return { username, ip, port, url, status: resp.ok ? 'ok' : 'failed', http: resp.status,
               detail: detail && detail.slice(0, 300) };
    } catch (e) {
      return { username, ip, port, url, status: 'failed', reason: e.message };
    }
  }));

  const ok = results.filter(r => r.status === 'ok').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const status = ok > 0 && failed === 0 ? 'SUCCESS' : ok > 0 ? 'PARTIAL' : 'FAILED';
  return { status, summary: { ok, failed, skipped }, results };
}

/**
 * POST /api/v1/provision-env
 *
 * Standalone provisioning (also runs automatically as step 0 of start-fl-session).
 * Request Body: { submission_id: string }
 * Response: { status: 'SUCCESS'|'PARTIAL'|'FAILED', summary:{ok,failed,skipped}, results:[...] }
 */
router.post('/provision-env', async (req, res) => {
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

    const selected = (submission.selected_providers || [])
      .map(p => p && p.username).filter(Boolean);
    if (selected.length === 0) {
      return res.status(200).json({
        status: 'FAILED', error: 'NO_PROVIDERS',
        message: 'This session has no selected providers.',
        summary: { ok: 0, failed: 0, skipped: 0 }, results: [],
      });
    }

    const result = await provisionProviders(db, selected);
    console.log(`[GOVERNANCE] provision-env ${submission_id}: ok=${result.summary.ok} failed=${result.summary.failed} skipped=${result.summary.skipped}`);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[GOVERNANCE] Error in provision-env:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * Render client_config.yaml with the output owner's IP and POST it to each selected
 * provider's receiver (/update-config), so flo_client.py points at the owner before
 * it launches. Destination ip/port come from each provider's latest
 * data_provider_forms row. Never throws. Returns { status, summary, results,
 * error?, message? }. Shared by POST /push-config and step 3.5 of start-fl-session.
 */
async function renderAndPushClientConfig(db, submission) {
  const empty = { sent: 0, failed: 0, skipped: 0 };
  const ownerIp = submission.ip_address;
  if (!ownerIp) {
    return { status: 'FAILED', error: 'NO_OWNER_IP',
             message: 'The output owner has not set an IP address for this session yet.',
             summary: empty, results: [] };
  }
  const selected = (submission.selected_providers || []).map(p => p && p.username).filter(Boolean);
  if (selected.length === 0) {
    return { status: 'FAILED', error: 'NO_PROVIDERS',
             message: 'This session has no selected providers.', summary: empty, results: [] };
  }

  let template;
  try {
    template = fs.readFileSync(CLIENT_CONFIG_TEMPLATE, 'utf8');
  } catch (e) {
    return { status: 'FAILED', error: 'TEMPLATE_NOT_FOUND', message: e.message, summary: empty, results: [] };
  }
  const yaml = renderClientConfig(template, ownerIp);

  const forms = await getDataProviderFormsByUsernames(db, selected);
  const byUser = new Map(forms.map(f => [f.data_owner_id, f]));
  const headers = await authHeaders({ 'Content-Type': 'application/x-yaml' }, PUSH_AUTH_TOKEN);

  // Push to all providers in parallel; never throw — collect a per-target result.
  const results = await Promise.all(selected.map(async (username) => {
    const f = byUser.get(username);
    const ip = f && f.ip_address;
    const port = f && f.port;
    if (!ip || !port) {
      return { username, ip: ip || null, port: port || null, status: 'skipped', reason: 'no registered ip/port' };
    }
    const url = `http://${reachableHost(ip)}:${port}${PROVIDER_RECEIVER_PATH}`;
    try {
      const resp = await fetch(url, {
        method: 'POST', headers, body: yaml,
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      let detail; try { detail = await resp.text(); } catch { detail = ''; }
      return { username, ip, port, url, status: resp.ok ? 'sent' : 'failed', http: resp.status,
               detail: detail && detail.slice(0, 200) };
    } catch (e) {
      return { username, ip, port, url, status: 'failed', reason: e.message };
    }
  }));

  const sent = results.filter(r => r.status === 'sent').length;
  const failed = results.filter(r => r.status === 'failed').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const status = sent > 0 && failed === 0 ? 'SUCCESS' : sent > 0 ? 'PARTIAL' : 'FAILED';
  return { status, summary: { sent, failed, skipped }, results };
}

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

    const r = await renderAndPushClientConfig(db, submission);
    const code = r.error === 'NO_OWNER_IP' ? 409 : r.error === 'TEMPLATE_NOT_FOUND' ? 500 : 200;
    console.log(`[GOVERNANCE] push-config ${submission_id}: sent=${r.summary.sent} failed=${r.summary.failed} skipped=${r.summary.skipped}`);
    return res.status(code).json(r);
  } catch (error) {
    console.error('[GOVERNANCE] Error in push-config:', error.message);
    return res.status(500).json({ status: 'FAILED', error: 'INTERNAL_ERROR', message: error.message });
  }
});

/**
 * POST /api/v1/start-fl-session
 *
 * Brings up the output owner, then provisions the data providers, in order:
 *   1. OWNER: POST the owner's receiver (ip:port from the form) /provision-env to
 *      create the venv + install src/server/requirements.txt ON THE OWNER HOST;
 *   2. OWNER: POST the owner's receiver /start-server to launch flo_server.py
 *      detached in that venv ON THE OWNER HOST;
 *   3. PROVIDERS: provision each selected provider's venv + install
 *      src/client/requirements.txt by POSTing to its receiver's /provision-env;
 *   3.5 PROVIDERS: push client_config.yaml (owner IP) to each provider so the
 *      client points at the server before it starts;
 *   4. PROVIDERS: launch flo_client.py on each provider (POST /start-client);
 *   5. OWNER: wait FL_SESSION_DELAY_MS (default 30s) for clients to register, then
 *      run flo_session.py ON THE OWNER HOST (POST /start-session) to kick the round.
 *
 * The output owner can be ANY host — its ip:port come from form_submissions
 * (the owner's own form), not hardcoded to this gov_layer host.
 *
 * Request Body: { submission_id: string }
 * Response: { status, owner, server, provision, push_config, clients, session }
 */
router.post('/start-fl-session', async (req, res) => {
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

    // The output owner is whatever ip:port they entered on the form — it can be any
    // host, not necessarily this one. flo_server.py / requirements live on THAT host.
    const ownerUrl = ownerBaseUrl(submission);
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: output owner at ${ownerUrl}`);

    // 1) OWNER ENV: tell the owner's receiver to create the venv + install the server
    //    requirements (src/server/requirements.txt) ON THE OWNER HOST. Abort if this
    //    fails — the server can't start without its environment.
    const ownerEnv = await provisionOwnerEnv(submission);
    if (!ownerEnv.ok) {
      return res.status(502).json({ status: 'FAILED', error: 'OWNER_ENV_FAILED', stage: ownerEnv.stage,
        message: `Output-owner env provisioning failed at ${ownerEnv.stage} (${ownerEnv.url})`, detail: ownerEnv.detail });
    }
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: owner env ${ownerEnv.env_path} (requirements installed: ${ownerEnv.installed})`);

    // 2) FLO_SERVER: ask the owner's receiver to launch flo_server.py (detached, in
    //    the provisioned venv) ON THE OWNER HOST. The owner is fully up before we
    //    touch the providers.
    const server = await startOwnerServer(submission);
    if (!server.ok) {
      return res.status(502).json({ status: 'FAILED', error: 'SERVER_LAUNCH_FAILED',
        message: `Could not start flo_server.py on the output owner (${server.url})`, detail: server.detail });
    }
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: flo_server pid=${server.pid} log=${server.log} @ ${ownerUrl}`);

    // 3) DATA-PROVIDER SIDE: now that the server is up, provision each selected
    //    provider's venv (+ install src/client/requirements.txt) by POSTing to its
    //    receiver's /provision-env. Failures are reported, not fatal.
    const selected = (submission.selected_providers || []).map(p => p && p.username).filter(Boolean);
    const provision = await provisionProviders(db, selected);
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: provision ok=${provision.summary.ok} failed=${provision.summary.failed} skipped=${provision.summary.skipped}`);

    // 3.5) PUSH CONFIG: write the owner's IP into each provider's client_config.yaml
    //      (grpc_discovery.host + mqtt broker_host) BEFORE launching flo_client.py.
    //      Without this the client reads its stale/template config (host 127.0.0.1)
    //      and never registers with the server -> session sees "No active clients".
    const pushConfig = await renderAndPushClientConfig(db, submission);
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: push-config sent=${pushConfig.summary.sent} failed=${pushConfig.summary.failed} skipped=${pushConfig.summary.skipped}`);

    // 4) START CLIENTS: with each provider's env ready and config pointing at the
    //    owner, ask its receiver to launch flo_client.py (POST /start-client) after a
    //    short warmup so the server is accepting connections. Per-provider result; a
    //    failure here is reported, not fatal. flo_session.py is still NOT launched.
    await sleep(FL_CLIENT_DELAY_MS);
    const forms = await getDataProviderFormsByUsernames(db, selected);
    const byUser = new Map(forms.map(f => [f.data_owner_id, f]));
    const headers = await authHeaders({ 'Content-Type': 'application/json' }, PUSH_AUTH_TOKEN);

    const clientResults = await Promise.all(selected.map(async (username) => {
      const f = byUser.get(username);
      const ip = f && f.ip_address;
      const port = f && f.port;
      if (!ip || !port) return { username, ip: ip || null, port: port || null, status: 'skipped', reason: 'no registered ip/port' };
      const url = `http://${reachableHost(ip)}:${port}${PROVIDER_START_CLIENT_PATH}`;
      try {
        const resp = await fetch(url, { method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(PUSH_TIMEOUT_MS) });
        let detail; try { detail = await resp.text(); } catch { detail = ''; }
        return { username, ip, port, url, status: resp.ok ? 'started' : 'failed', http: resp.status, detail: detail && detail.slice(0, 200) };
      } catch (e) {
        return { username, ip, port, url, status: 'failed', reason: e.message };
      }
    }));
    const cstarted = clientResults.filter(r => r.status === 'started').length;
    const cfailed = clientResults.filter(r => r.status === 'failed').length;
    const cskipped = clientResults.filter(r => r.status === 'skipped').length;
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: clients started=${cstarted} failed=${cfailed} skipped=${cskipped}`);

    // 5) START SESSION: wait FL_SESSION_DELAY_MS (default 30s) for the clients to
    //    register with the server, then run flo_session.py ON THE OWNER HOST to kick
    //    off the round (POST /start-session). Reported, not fatal.
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: waiting ${FL_SESSION_DELAY_MS}ms for clients to register before flo_session.py`);
    await sleep(FL_SESSION_DELAY_MS);
    const session = await startOwnerSession(submission);
    console.log(`[GOVERNANCE] start-fl-session ${submission_id}: flo_session ${session.ok ? `pid=${session.pid} log=${session.log}` : `FAILED: ${session.detail}`} @ ${ownerUrl}`);

    return res.status(200).json({
      status: 'SUCCESS',
      owner: { url: ownerUrl, env_path: ownerEnv.env_path, requirements_installed: ownerEnv.installed },
      server: { pid: server.pid, log: server.log, url: server.url },
      provision: { summary: provision.summary, results: provision.results },
      push_config: { status: pushConfig.status, summary: pushConfig.summary, results: pushConfig.results },
      clients: { summary: { started: cstarted, failed: cfailed, skipped: cskipped }, results: clientResults },
      session: session.ok
        ? { status: 'started', pid: session.pid, log: session.log, server_endpoint: FL_SERVER_ENDPOINT, waited_ms: FL_SESSION_DELAY_MS }
        : { status: 'failed', detail: session.detail, waited_ms: FL_SESSION_DELAY_MS },
    });
  } catch (error) {
    console.error('[GOVERNANCE] Error in start-fl-session:', error.message);
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
