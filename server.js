const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const Webhook = require('./models/webhook');
const Request = require('./models/request');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT;

// Default no-op emitter so routes can call it even if Socket.IO failed to init yet
app.emitRequestEvent = function () { /* no-op until Socket.IO attaches */ };

// Create HTTP server and attach Socket.IO later
const http = require('http');
const server = http.createServer(app);
let io;
const MONGODB_URI = process.env.MONGODB_URI;

// In-memory storage fallback (deprecated) — prefer file-based JSON storage when MongoDB is unreachable
let mongoConnected = false;

const fs = require('fs').promises;
const storageDir = path.join(__dirname, 'storage');

async function ensureStorageDir() {
  try {
    await fs.mkdir(storageDir, { recursive: true });
  } catch (e) {
    console.warn('Failed to ensure storage directory:', e && e.message);
  }
}

function webhookFilePath(id) {
  return path.join(storageDir, `${id}.json`);
}

async function readWebhookFile(id) {
  try {
    const raw = await fs.readFile(webhookFilePath(id), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

async function writeWebhookFile(id, data) {
  try {
    await fs.writeFile(webhookFilePath(id), JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.warn('Failed to write webhook file', id, e && e.message);
  }
}

async function listWebhookFiles() {
  try {
    const files = await fs.readdir(storageDir);
    return files.filter(f => f.endsWith('.json'));
  } catch (e) {
    return [];
  }
}

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    mongoConnected = true;
  })
  .catch(err => {
    console.warn('MongoDB connection failed:', err.message);
  console.warn('Note: Using JSON file storage under storage/ for persistence.');
    mongoConnected = false;
  // Ensure storage dir exists for file fallback
  ensureStorageDir();
  });

// Middleware
app.use(express.static(path.join(__dirname, 'public')));

// Serve Socket.IO client library locally
app.get('/socket.io/socket.io.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules/socket.io/client-dist/socket.io.min.js'));
});

// Raw body middleware for webhook endpoints only
app.use('/webhook', express.raw({ type: '*/*', limit: '10mb' }));

// Regular JSON and URL encoded middleware for other routes  
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Helper functions
function generateId() {
  return uuidv4().replace(/-/g, '').slice(0, 8);
}

function sanitizeId(id) {
  if (!id) return null;
  const sanitized = id.toString().replace(/[^a-zA-Z0-9_-]/g, '');
  return sanitized === '' ? null : sanitized;
}

function parseWebhookPath(path) {
  // Parse /webhook/<id>/res:<status><type>/fwd:$$<url>$$/fullbody:true/tag:<string> format
  // The new fwd:$$url$$ format safely extracts complex URLs with fragments, query params, etc.
  // Legacy fwd:url format is still supported for backward compatibility
  // Remove /webhook/ prefix
  const cleanPath = path.replace(/^\/webhook\//, '');
  
  if (!cleanPath) {
    return { id: null, error: 'Missing webhook ID' };
  }
  
  // Find the first segment (ID) and then parse the rest as a single string
  const firstSlash = cleanPath.indexOf('/');
  let id, paramString;
  
  if (firstSlash === -1) {
    // No parameters, just ID
    id = sanitizeId(cleanPath);
    paramString = '';
  } else {
    id = sanitizeId(cleanPath.substring(0, firstSlash));
    paramString = cleanPath.substring(firstSlash + 1);
  }
  
  if (!id) {
    return { id: null, error: 'Invalid webhook ID' };
  }
  
  const result = {
    id,
    responseStatus: null,
    responseType: null,
    forwardUrl: null,
    fullBody: false,
    tag: null,
    error: null
  };
  
  if (!paramString) {
    return result; // No parameters
  }
  
  // Parse parameters more carefully to handle URLs with slashes
  // Look for res: pattern first
  const resMatch = paramString.match(/(^|\/)(res:\d{3}(?:plain|json|html))(?=\/|$)/);
  if (resMatch) {
    const resParam = resMatch[2].substring(4); // Remove 'res:'
    
    // Parse status code and type (e.g., "404html", "200json")
    const match = resParam.match(/^(\d{3})(plain|json|html)$/);
    if (match) {
      const [, status, type] = match;
      result.responseStatus = parseInt(status, 10);
      result.responseType = type;
    } else {
      result.error = `Invalid res parameter format: ${resMatch[2]}`;
    }
  }
  
  // Look for fullbody parameter
  const fullBodyMatch = paramString.match(/(^|\/)fullbody:true(?=\/|$)/);
  if (fullBodyMatch) {
    result.fullBody = true;
  }
  
  // Look for tag parameter
  const tagMatch = paramString.match(/(^|\/)tag:([^\/]+)(?=\/|$)/);
  if (tagMatch) {
    result.tag = decodeURIComponent(tagMatch[2]);
  }
  
  // Look for fwd: pattern with $$ bounded URLs for safe extraction of complex URLs
  // First try the new $$url$$ format: /fwd:$$https://example.com/path?param=value#fragment$$
  const fwdBoundedMatch = paramString.match(/(^|\/)fwd:\$\$(.*?)\$\$/);
  if (fwdBoundedMatch) {
    const forwardUrl = fwdBoundedMatch[2];
    
    try {
      const url = new URL(forwardUrl);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        result.forwardUrl = forwardUrl;
      } else {
        result.error = `Invalid forward URL protocol: ${forwardUrl}`;
      }
    } catch (e) {
      result.error = `Invalid forward URL: ${forwardUrl}`;
    }
  } else {
    // Fallback to legacy format for backward compatibility: /fwd:https://url
    const fwdMatch = paramString.match(/(^|\/)fwd:(https?:\/\/[^\s]+)/);
    if (fwdMatch) {
      let forwardUrl = fwdMatch[2];
      
      // The forward URL might extend to the end of the string or until the next parameter
      // Find where this fwd parameter ends (either at end of string or before next known parameter)
      const fwdStart = paramString.indexOf(fwdMatch[0]);
      const fwdValueStart = fwdStart + fwdMatch[0].length - forwardUrl.length;
      
      // Look for the next parameter that starts with res:, fullbody:, tag:, or another known pattern
      const remainingString = paramString.substring(fwdValueStart);
      const nextParamMatch = remainingString.match(/\/(res:\d{3}(?:plain|json|html)|fullbody:true|tag:[^\/]+)/);
      
      if (nextParamMatch) {
        // There's another parameter after the fwd URL
        forwardUrl = remainingString.substring(0, nextParamMatch.index);
      } else {
        // fwd URL extends to the end
        forwardUrl = remainingString;
      }
      
      try {
        const url = new URL(forwardUrl);
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          result.forwardUrl = forwardUrl;
        } else {
          result.error = `Invalid forward URL protocol: ${forwardUrl}`;
        }
      } catch (e) {
        result.error = `Invalid forward URL: ${forwardUrl}`;
      }
    }
  }
  
  return result;
}

// Helper function to send immediate response based on type
async function sendImmediateResponse(res, status, type, data) {
  const { id, method, rawBody } = data;
  
  res.status(status);
  
  switch (type) {
    case 'json':
      res.set('Content-Type', 'application/json; charset=utf-8');
      res.json({
        ok: true,
        id,
        method,
        response_status: status,
        receivedBytes: rawBody.length
      });
      break;
      
    case 'html':
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Webhook ${id}</title></head><body><h1>Webhook ${id}</h1><p>Status: ${status}</p><p>Method: ${method}</p><p>Received: ${rawBody.length} bytes</p></body></html>`);
      break;
      
    case 'plain':
    default:
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(`ok=true\nid=${id}\nmethod=${method}\nstatus=${status}\nbytes=${rawBody.length}\n`);
      break;
  }
}

// Helper function to forward request and respond with forwarded response
async function forwardRequestAndRespond(res, requestEntry, forwardUrl, req, rawBody, fullBody = false) {
  const startTime = Date.now();
  
  try {
    // Prepare headers for proxying
    const headers = { ...req.headers };
    
    // Remove hop-by-hop headers
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-authenticate'];
    delete headers['proxy-authorization'];
    delete headers.te;
    delete headers.trailers;
    delete headers['transfer-encoding'];
    delete headers.upgrade;
    delete headers.host; // Let axios handle this
    
    const axiosConfig = {
      method: req.method.toLowerCase(),
      url: forwardUrl,
      headers,
      timeout: 30000,
      responseType: 'text' // Get response as text to capture body
    };
    
    if (rawBody) {
      axiosConfig.data = rawBody;
    }
    
    const forwardRequestTimestamp = new Date();
    const response = await axios(axiosConfig);
    const forwardResponseTimestamp = new Date();
    const duration = Date.now() - startTime;
    
    // Capture response details
    let responseBody = response.data || '';
    
    // Truncate body if not fullBody and not JSON, and if it's too large
    if (!fullBody && responseBody.length > 1000) {
      const contentType = response.headers['content-type'] || '';
      const isJson = contentType.includes('application/json');
      
      if (!isJson) {
        responseBody = responseBody.substring(0, 1000) + '\n... [truncated, use /fullbody:true to see complete response]';
      }
    }
    
    // Stream response headers
    Object.entries(response.headers).forEach(([key, value]) => {
      res.set(key, value);
    });
    
    res.status(response.status);
    res.send(response.data); // Send original full response to client
    
    // Update request with comprehensive forwarded details
    try {
      await updateRequest(requestEntry.rid, {
        proxied_status: response.status,
        response_status: response.status,
        forward_response_status: response.status,
        forward_response_headers: response.headers,
        forward_response_body: responseBody,
        forward_request_headers: headers,
        forward_request_body: rawBody ? rawBody.toString('utf8') : '',
        forward_request_method: req.method,
        forward_request_url: forwardUrl,
        forward_request_timestamp: forwardRequestTimestamp,
        forward_response_timestamp: forwardResponseTimestamp,
        forward_duration_ms: duration
      });
      // Emit socket update for proxied status
      try {
        app.emitRequestEvent(requestEntry.webhook_id, 'request:updated', { 
          rid: requestEntry.rid, 
          proxied_status: response.status, 
          response_status: response.status,
          forward_response_status: response.status,
          forward_duration_ms: duration
        });
      } catch (e) { /* ignore emit errors */ }
    } catch (error) {
      console.warn('Failed to update request:', error.message);
    }
    
  } catch (proxyError) {
    console.error('Forward request error:', proxyError);
    const duration = Date.now() - startTime;
    
    // Prepare headers for error logging
    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-authenticate'];
    delete headers['proxy-authorization'];
    delete headers.te;
    delete headers.trailers;
    delete headers['transfer-encoding'];
    delete headers.upgrade;
    delete headers.host;
    
    // Update request with proxy error
    try {
      await updateRequest(requestEntry.rid, {
        proxy_error: proxyError.message,
        response_status: 502,
        forward_response_status: 502,
        forward_response_body: `Error: ${proxyError.message}`,
        forward_request_headers: headers || {},
        forward_request_body: rawBody ? rawBody.toString('utf8') : '',
        forward_request_method: req.method,
        forward_request_url: forwardUrl,
        forward_request_timestamp: new Date(),
        forward_duration_ms: duration
      });
      try { 
        app.emitRequestEvent(requestEntry.webhook_id, 'request:updated', { 
          rid: requestEntry.rid, 
          proxy_error: proxyError.message, 
          response_status: 502,
          forward_response_status: 502,
          forward_duration_ms: duration
        }); 
      } catch(e) { /* ignore emit errors */ }
    } catch (error) {
      console.warn('Failed to update request:', error.message);
    }
    
    // Return consistent JSON error response
    res.status(502)
       .set('Content-Type', 'application/json; charset=utf-8')
       .json({
         ok: false,
         error: 'Upstream request failed',
         message: proxyError.message,
         id: requestEntry.webhook_id,
         method: requestEntry.method,
         status: 502
       });
  }
}

// Helper function to forward request in background (fire and forget)
async function forwardRequestInBackground(requestEntry, forwardUrl, req, rawBody, fullBody = false) {
  const startTime = Date.now();
  
  try {
    // Prepare headers for proxying
    const headers = { ...req.headers };
    
    // Remove hop-by-hop headers
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-authenticate'];
    delete headers['proxy-authorization'];
    delete headers.te;
    delete headers.trailers;
    delete headers['transfer-encoding'];
    delete headers.upgrade;
    delete headers.host; // Let axios handle this
    
    const axiosConfig = {
      method: req.method.toLowerCase(),
      url: forwardUrl,
      headers,
      timeout: 30000,
      responseType: 'text' // Get response as text to capture body
    };
    
    if (rawBody) {
      axiosConfig.data = rawBody;
    }
    
    const forwardRequestTimestamp = new Date();
    const response = await axios(axiosConfig);
    const forwardResponseTimestamp = new Date();
    const duration = Date.now() - startTime;
    
    // Capture response details
    let responseBody = response.data || '';
    
    // Truncate body if not fullBody and not JSON, and if it's too large
    if (!fullBody && responseBody.length > 1000) {
      const contentType = response.headers['content-type'] || '';
      const isJson = contentType.includes('application/json');
      
      if (!isJson) {
        responseBody = responseBody.substring(0, 1000) + '\n... [truncated, use /fullbody:true to see complete response]';
      }
    }
    
    // Update request with comprehensive background forward details
    try {
      await updateRequest(requestEntry.rid, {
        proxied_status: response.status,
        background_forward: true,
        forward_response_status: response.status,
        forward_response_headers: response.headers,
        forward_response_body: responseBody,
        forward_request_headers: headers,
        forward_request_body: rawBody ? rawBody.toString('utf8') : '',
        forward_request_method: req.method,
        forward_request_url: forwardUrl,
        forward_request_timestamp: forwardRequestTimestamp,
        forward_response_timestamp: forwardResponseTimestamp,
        forward_duration_ms: duration
      });
      // Emit socket update for background forward status
      try {
        app.emitRequestEvent(requestEntry.webhook_id, 'request:updated', { 
          rid: requestEntry.rid, 
          proxied_status: response.status,
          background_forward: true,
          forward_response_status: response.status,
          forward_duration_ms: duration
        });
      } catch (e) { /* ignore emit errors */ }
    } catch (error) {
      console.warn('Failed to update background forward request:', error.message);
    }
    
  } catch (proxyError) {
    console.error('Background forward error:', proxyError);
    const duration = Date.now() - startTime;
    
    // Prepare headers for error logging
    const headers = { ...req.headers };
    delete headers.connection;
    delete headers['keep-alive'];
    delete headers['proxy-authenticate'];
    delete headers['proxy-authorization'];
    delete headers.te;
    delete headers.trailers;
    delete headers['transfer-encoding'];
    delete headers.upgrade;
    delete headers.host;
    
    // Update request with background proxy error
    try {
      await updateRequest(requestEntry.rid, {
        proxy_error: proxyError.message,
        background_forward: true,
        forward_response_status: 502,
        forward_response_body: `Error: ${proxyError.message}`,
        forward_request_headers: headers || {},
        forward_request_body: rawBody ? rawBody.toString('utf8') : '',
        forward_request_method: req.method,
        forward_request_url: forwardUrl,
        forward_request_timestamp: new Date(),
        forward_duration_ms: duration
      });
      try { 
        app.emitRequestEvent(requestEntry.webhook_id, 'request:updated', { 
          rid: requestEntry.rid, 
          proxy_error: proxyError.message,
          background_forward: true,
          forward_response_status: 502,
          forward_duration_ms: duration
        }); 
      } catch(e) { /* ignore emit errors */ }
    } catch (error) {
      console.warn('Failed to update background forward request:', error.message);
    }
  }
}

function getNextLabel(existingWebhooks) {
  return `URL ${existingWebhooks.length + 1}`;
}

// In-memory storage helpers
async function findWebhooks() {
  if (mongoConnected) {
    const docs = await Webhook.find().sort({ created_at: -1 }).lean();
    // Ensure each returned object has an `id` property (fallback to `_id` for legacy docs)
    return docs.map(w => {
      if (!w) return w;
      if (!w.id && w._id) w.id = String(w._id);
      return w;
    });
  } else {
    const files = await listWebhookFiles();
    const webhooks = [];
    for (const f of files) {
      try {
        const raw = await fs.readFile(path.join(storageDir, f), 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && parsed.webhook) webhooks.push(parsed.webhook);
      } catch (e) { /* ignore corrupted file */ }
    }
    return webhooks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
}

async function findWebhookById(id) {
  if (mongoConnected) {
  const doc = await Webhook.findOne({ id }).lean();
  if (doc && !doc.id && doc._id) doc.id = String(doc._id);
  return doc;
  } else {
  const parsed = await readWebhookFile(id);
  return parsed && parsed.webhook ? parsed.webhook : null;
  }
}

async function saveWebhook(webhookData) {
  if (mongoConnected) {
    const webhook = new Webhook(webhookData);
    return await webhook.save();
  } else {
  const webhook = { ...webhookData };
  if (!webhook.created_at) webhook.created_at = new Date().toISOString();
  const record = { webhook, requests: [] };
  await ensureStorageDir();
  await writeWebhookFile(webhook.id, record);
  return webhook;
  }
}

async function deleteWebhook(id) {
  if (mongoConnected) {
    await Webhook.deleteOne({ id });
  } else {
    try {
      await fs.unlink(webhookFilePath(id));
    } catch (e) { /* ignore if not exists */ }
  }
}

async function findRequests(webhookId) {
  if (mongoConnected) {
    return await Request.find({ webhook_id: webhookId }).sort({ time: -1 }).limit(100);
  } else {
    const parsed = await readWebhookFile(webhookId);
    const requests = (parsed && Array.isArray(parsed.requests)) ? parsed.requests : [];
    return requests
      .slice() // copy
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 100);
  }
}

async function countRequests(webhookId) {
  if (mongoConnected) {
    return await Request.countDocuments({ webhook_id: webhookId });
  } else {
  const parsed = await readWebhookFile(webhookId);
  const requests = (parsed && Array.isArray(parsed.requests)) ? parsed.requests : [];
  return requests.length;
  }
}

async function saveRequest(requestData) {
  if (mongoConnected) {
    const request = new Request(requestData);
    return await request.save();
  } else {
    const request = { ...requestData };
    // Normalize time to ISO string for JSON storage
    if (request.time && request.time.toISOString) request.time = request.time.toISOString();
    else if (!request.time) request.time = new Date().toISOString();

    await ensureStorageDir();
    const parsed = await readWebhookFile(request.webhook_id);
    if (!parsed) {
      // Create placeholder webhook record if missing
      const placeholder = {
        webhook: {
          id: request.webhook_id,
          label: `URL ${request.webhook_id}`,
          status: 200,
          content_type: 'text/html',
          destination: '',
          tags: [],
          created_at: new Date().toISOString()
        },
        requests: [request]
      };
      await writeWebhookFile(request.webhook_id, placeholder);
      return request;
    }

    parsed.requests = parsed.requests || [];
    parsed.requests.push(request);
    await writeWebhookFile(request.webhook_id, parsed);
    return request;
  }
}

async function updateRequest(rid, updateData) {
  if (mongoConnected) {
    return await Request.updateOne({ rid }, updateData);
  } else {
    // Find request across all webhook files and update in-place
    const files = await listWebhookFiles();
    for (const f of files) {
      try {
        const full = path.join(storageDir, f);
        const raw = await fs.readFile(full, 'utf8');
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.requests)) continue;
        const idx = parsed.requests.findIndex(r => r.rid === rid);
        if (idx !== -1) {
          parsed.requests[idx] = { ...parsed.requests[idx], ...updateData };
          await fs.writeFile(full, JSON.stringify(parsed, null, 2), 'utf8');
          return;
        }
      } catch (e) { /* ignore and continue */ }
    }
  }
}

async function deleteRequests(webhookId) {
  if (mongoConnected) {
    await Request.deleteMany({ webhook_id: webhookId });
  } else {
    const parsed = await readWebhookFile(webhookId);
    if (parsed) {
      parsed.requests = [];
      await writeWebhookFile(webhookId, parsed);
    }
  }
}

// Routes

// Main dashboard
app.get('/', async (req, res) => {
  try {
    const webhooks = await findWebhooks();
    
    // Get request counts for each webhook
    const webhooksWithCounts = await Promise.all(
      webhooks.map(async (webhook) => {
        try {
          const count = await countRequests(webhook.id);
          return {
            ...webhook,
            request_count: count
          };
        } catch (error) {
          console.warn('Failed to get request count for webhook:', webhook.id, error.message);
          return {
            ...webhook,
            request_count: 0
          };
        }
      })
    );

    res.render('index', { 
      webhooks: webhooksWithCounts
    });
  } catch (error) {
    console.error('Error loading webhooks:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Create webhook
app.post('/webhooks', async (req, res) => {
  try {
    const { label } = req.body;
    
    const webhooks = await findWebhooks();
    let id = generateId();
    
    // Ensure unique ID
    let tries = 0;
    while (tries < 5) {
      const exists = await findWebhookById(id);
      if (!exists) break;
      id = generateId();
      tries++;
    }
    
    // Use provided label or generate default
    function sanitizeLabelInput(rawLabel){
      if(!rawLabel || typeof rawLabel !== 'string') return '';
      // Replace disallowed characters with a space so segments separated by invalid chars split cleanly
      const replaced = rawLabel.replace(/[^A-Za-z0-9 _-]/g, ' ');
      // Collapse multiple spaces
      const collapsed = replaced.replace(/\s+/g, ' ').trim();
      return collapsed;
    }

    let webhookLabel = getNextLabel(webhooks);
    if (label && label.trim() !== '') {
      const cleaned = sanitizeLabelInput(label.trim());
      if (cleaned !== '') {
        // If cleaned contains spaces (was multi-part), keep the first token as the primary label
        webhookLabel = cleaned.split(' ').filter(Boolean)[0] || cleaned;
      }
    }
    
    const webhookData = {
      id,
      label: webhookLabel
    };
    
    await saveWebhook(webhookData);
    res.redirect('/');
  } catch (error) {
    console.error('Error creating webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Delete webhook
app.delete('/webhooks/:id', async (req, res) => {
  try {
    const id = sanitizeId(req.params.id);
    if (!id) {
      return res.status(400).json({ error: 'Invalid webhook ID' });
    }
    
    await deleteWebhook(id);
    await deleteRequests(id);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting webhook:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Handle webhook requests with dynamic parameters
app.all(/^\/webhook\/(.+)/, async (req, res) => {
  try {
    const fullPath = '/webhook/' + req.params[0];
    const parsedPath = parseWebhookPath(fullPath);
    
    if (parsedPath.error || !parsedPath.id) {
      return res.status(400)
        .set('Content-Type', 'application/json; charset=utf-8')
        .json({
          ok: false,
          error: 'Invalid webhook URL',
          message: parsedPath.error || 'Invalid webhook URL format',
          status: 400
        });
    }
    
    const { id, responseStatus, responseType, forwardUrl, fullBody, tag } = parsedPath;
    
    // Get raw body (should be available as Buffer from express.raw middleware)
    const rawBody = req.body ? req.body.toString() : '';
    
    const webhook = await findWebhookById(id);
    
    // Determine response behavior
    const hasResponseParams = responseStatus !== null && responseType !== null;
    const hasForwardParams = forwardUrl !== null;
    
    // Default response if no parameters provided
    const defaultStatus = 200;
    const defaultType = 'json';
    
    // Build request entry with parsed parameters
    const requestEntry = {
      webhook_id: id,
      rid: uuidv4(),
      time: new Date(),
      ip: req.get('X-Forwarded-For')?.split(',')[0]?.trim() || 
          req.get('X-Real-IP') || 
          req.get('X-Client-IP') || 
          req.ip || 
          req.connection.remoteAddress || 
          req.socket.remoteAddress || 
          (req.connection.socket ? req.connection.socket.remoteAddress : null) || 
          'unknown',
      method: req.method,
      user_agent: req.get('User-Agent') || '',
      headers: req.headers,
      query: req.query,
      body: rawBody,
      full_url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      path: req.originalUrl,
      response_status: hasResponseParams ? responseStatus : defaultStatus,
      // Store parsed parameters for logging
      parsed_response_status: responseStatus,
      parsed_response_type: responseType,
      parsed_forward_url: forwardUrl,
      full_body: fullBody,
      tag: tag,
      // Initialize forward response fields
      forward_response_status: null,
      forward_response_headers: null,
      forward_response_body: null
    };
    
    // Save request to database first
    try {
      await saveRequest(requestEntry);
      // Emit socket event for new request (serialize Date to ISO)
      try {
        const payload = Object.assign({}, requestEntry, { 
          time: (requestEntry.time && requestEntry.time.toISOString) ? requestEntry.time.toISOString() : requestEntry.time 
        });
        app.emitRequestEvent(id, 'request:new', payload);
      } catch (e) { /* ignore emit errors */ }
    } catch (error) {
      console.warn('Failed to save request:', error.message);
    }
    
    // Handle response logic based on parameters
    if (hasResponseParams && hasForwardParams) {
      // Both res: and fwd: provided - respond immediately with specified response
      await sendImmediateResponse(res, responseStatus, responseType, { id, method: req.method, rawBody });
      
      // Forward request in background (don't wait)
      forwardRequestInBackground(requestEntry, forwardUrl, req, rawBody, fullBody);
      
    } else if (hasForwardParams && !hasResponseParams) {
      // Only fwd: provided - forward and wait for response
      await forwardRequestAndRespond(res, requestEntry, forwardUrl, req, rawBody, fullBody);
      
    } else if (hasResponseParams && !hasForwardParams) {
      // Only res: provided - respond immediately
      await sendImmediateResponse(res, responseStatus, responseType, { id, method: req.method, rawBody });
      
    } else {
      // No parameters - default response
      await sendImmediateResponse(res, defaultStatus, defaultType, { id, method: req.method, rawBody });
    }
    
  } catch (error) {
    console.error('Error in webhook handler:', error);
    res.status(500)
      .set('Content-Type', 'application/json; charset=utf-8')
      .json({
        ok: false,
        error: 'Internal Server Error',
        message: error.message,
        status: 500
      });
  }
});

// View requests for a webhook
app.get('/request/:id', async (req, res) => {
  try {
    const id = sanitizeId(req.params.id) || 'default';
    const rid = req.query.rid;
    
    const requests = await findRequests(id);
  const webhook = await findWebhookById(id);
    
    // Assign request IDs for selection
    requests.forEach((request, index) => {
      if (!request.rid) {
        request.rid = `idx-${index}`;
      }
    });
    
    // Don't pre-select any request - let JavaScript handle selection
    res.render('requests', {
      webhookId: id,
      webhook: webhook || null,
      requests,
      selected: null,  // Always null - use JavaScript to load details
      selectedRid: rid || null  // Pass the requested rid for JavaScript to use
    });
  } catch (error) {
    console.error('Error loading requests:', error);
    res.status(500).send('Internal Server Error');
  }
});

// API endpoint to fetch individual request details (for AJAX)
app.get('/api/request/:webhookId/:rid', async (req, res) => {
  try {
    const webhookId = sanitizeId(req.params.webhookId);
    const rid = req.params.rid;
    
    if (!webhookId || !rid) {
      return res.status(400).json({ error: 'Invalid webhook ID or request ID' });
    }
    
  const requests = await findRequests(webhookId);
  let request = requests.find(r => r.rid === rid);
    
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    // Ensure we have a plain object (Mongoose documents need to be converted)
    if (request && typeof request.toObject === 'function') {
      request = request.toObject();
    }

    // Process the request data for display
    const prettyHeaders = JSON.stringify(request.headers || {}, null, 2);
    const prettyQuery = JSON.stringify(request.query || {}, null, 2);
    let prettyBody = request.body || '';
    try {
      const decoded = JSON.parse(request.body);
      prettyBody = JSON.stringify(decoded, null, 2);
    } catch (e) { /* leave as-is */ }
    
    // Process forward response data if available
    let prettyForwardHeaders = '';
    let prettyForwardBody = '';
    if (request.forward_response_headers) {
      prettyForwardHeaders = JSON.stringify(request.forward_response_headers, null, 2);
    }
    if (request.forward_response_body) {
      try {
        const decoded = JSON.parse(request.forward_response_body);
        prettyForwardBody = JSON.stringify(decoded, null, 2);
      } catch (e) {
        prettyForwardBody = request.forward_response_body;
      }
    }

    // Compute what was forwarded (request) headers/body for display
    let prettyForwardRequestHeaders = '';
    if (request.forward_request_headers) {
      // Use stored forward request headers if available
      prettyForwardRequestHeaders = JSON.stringify(request.forward_request_headers, null, 2);
    } else {
      // Fallback to computing from original headers (legacy requests)
      try {
        const hopByHop = new Set([
          'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
          'te', 'trailers', 'transfer-encoding', 'upgrade', 'host'
        ]);
        const headersObj = request.headers || {};
        const forwardedHeaders = Object.fromEntries(
          Object.entries(headersObj).filter(([k]) => !hopByHop.has(String(k).toLowerCase()))
        );
        prettyForwardRequestHeaders = JSON.stringify(forwardedHeaders, null, 2);
      } catch (e) {
        prettyForwardRequestHeaders = JSON.stringify(request.headers || {}, null, 2);
      }
    }

    let prettyForwardRequestBody = '';
    if (request.forward_request_body !== undefined && request.forward_request_body !== null) {
      // Use stored forward request body if available
      try {
        const decodedReqBody = JSON.parse(request.forward_request_body);
        prettyForwardRequestBody = JSON.stringify(decodedReqBody, null, 2);
      } catch (e) {
        prettyForwardRequestBody = request.forward_request_body;
      }
    } else {
      // Fallback to original body (legacy requests)
      try {
        const decodedReqBody = JSON.parse(request.body || '');
        prettyForwardRequestBody = JSON.stringify(decodedReqBody, null, 2);
      } catch (e) {
        prettyForwardRequestBody = request.body || '';
      }
    }
    
    const processedRequest = Object.assign({}, request, {
      // Ensure undefined/null values have fallbacks
      ip: request.ip || 'N/A',
      method: request.method || 'N/A',
      full_url: request.full_url || 'N/A',
      user_agent: request.user_agent || 'N/A',
      path: request.path || 'N/A',
      // Pretty formatted data
      prettyHeaders,
      prettyQuery,
      prettyBody,
      prettyForwardHeaders,
      prettyForwardBody,
      prettyForwardRequestHeaders,
      prettyForwardRequestBody,
      requestTime: new Date(request.time).toISOString(),
      ridSafe: (request.rid || 'req').replace(/[^a-zA-Z0-9_-]/g,'')
    });
    // Also include raw forward fields if present (for client-side logic)
    if (request.forward_response_headers) processedRequest.forward_response_headers = request.forward_response_headers;
    if (request.forward_response_body !== undefined) processedRequest.forward_response_body = request.forward_response_body;
    if (request.forward_request_headers) processedRequest.forward_request_headers = request.forward_request_headers;
    if (request.forward_request_body !== undefined) processedRequest.forward_request_body = request.forward_request_body;
    if (request.forward_request_method) processedRequest.forward_request_method = request.forward_request_method;
    if (request.forward_request_url) processedRequest.forward_request_url = request.forward_request_url;
    if (request.parsed_forward_url) processedRequest.parsed_forward_url = request.parsed_forward_url;
    if (request.background_forward !== undefined) processedRequest.background_forward = request.background_forward;
    if (request.forward_response_status !== undefined) processedRequest.forward_response_status = request.forward_response_status;
    if (request.forward_request_timestamp) processedRequest.forward_request_timestamp = request.forward_request_timestamp;
    if (request.forward_response_timestamp) processedRequest.forward_response_timestamp = request.forward_response_timestamp;
    
    res.json(processedRequest);
  } catch (error) {
    console.error('Error fetching request details:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// Handle POST request for webhook deletion (for form compatibility)
app.post('/webhooks/delete', async (req, res) => {
  try {
    const id = sanitizeId(req.body.id);
    if (!id) {
      return res.status(400).send('Invalid webhook ID');
    }
    
    await deleteWebhook(id);
    await deleteRequests(id);
    
    res.redirect('/');
  } catch (error) {
    console.error('Error deleting webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Start server (use http server so Socket.IO can attach)
function startServer() {
  try {
    const { Server } = require('socket.io');
    io = new Server(server, {
      cors: { origin: '*' }
    });

    io.on('connection', (socket) => {
      console.log('Socket.IO client connected:', socket.id);
      // Join room for a particular webhook id
      socket.on('join', (room) => {
        if (!room) return;
        socket.join(String(room));
        console.log('Socket joined room', String(room), 'by', socket.id);
      });
      socket.on('leave', (room) => {
        if (!room) return;
        socket.leave(String(room));
      });
    });

    // Attach a helper to emit webhook request events
    app.emitRequestEvent = function (webhookId, eventName, payload) {
      try {
        if (io && webhookId) {
          io.to(String(webhookId)).emit(eventName, payload);
          console.log('Emitted', eventName, 'to', String(webhookId));
        }
      } catch (e) {
        console.warn('emitRequestEvent failed:', e && e.message);
      }
    };
  } catch (e) {
    console.warn('Socket.IO not available:', e && e.message);
  }

  server.listen(PORT, () => {
    console.log(`Webhook application running on port ${PORT}`);
    console.log(`Dashboard: http://localhost:${PORT}`);
  });
}

startServer();

module.exports = app;