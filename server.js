const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const Webhook = require('./models/webhook');
const Request = require('./models/request');

const app = express();
const PORT = process.env.PORT || 3000;

// Default no-op emitter so routes can call it even if Socket.IO failed to init yet
app.emitRequestEvent = function () { /* no-op until Socket.IO attaches */ };

// Create HTTP server and attach Socket.IO later
const http = require('http');
const server = http.createServer(app);
let io;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/webhook-app';

// In-memory storage fallback
let mongoConnected = false;
let inMemoryWebhooks = [];
let inMemoryRequests = [];

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    mongoConnected = true;
  })
  .catch(err => {
    console.warn('MongoDB connection failed:', err.message);
    console.warn('Note: Using in-memory storage for testing. Data will not persist.');
    mongoConnected = false;
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

function getNextLabel(existingWebhooks) {
  return `URL ${existingWebhooks.length + 1}`;
}

// In-memory storage helpers
async function findWebhooks() {
  if (mongoConnected) {
    return await Webhook.find().sort({ created_at: -1 });
  } else {
    return inMemoryWebhooks.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
}

async function findWebhookById(id) {
  if (mongoConnected) {
    return await Webhook.findOne({ id });
  } else {
    return inMemoryWebhooks.find(w => w.id === id);
  }
}

async function saveWebhook(webhookData) {
  if (mongoConnected) {
    const webhook = new Webhook(webhookData);
    return await webhook.save();
  } else {
    const webhook = { ...webhookData, created_at: new Date() };
    inMemoryWebhooks.push(webhook);
    return webhook;
  }
}

async function deleteWebhook(id) {
  if (mongoConnected) {
    await Webhook.deleteOne({ id });
  } else {
    inMemoryWebhooks = inMemoryWebhooks.filter(w => w.id !== id);
  }
}

async function findRequests(webhookId) {
  if (mongoConnected) {
    return await Request.find({ webhook_id: webhookId }).sort({ time: -1 }).limit(100);
  } else {
    return inMemoryRequests
      .filter(r => r.webhook_id === webhookId)
      .sort((a, b) => new Date(b.time) - new Date(a.time))
      .slice(0, 100);
  }
}

async function countRequests(webhookId) {
  if (mongoConnected) {
    return await Request.countDocuments({ webhook_id: webhookId });
  } else {
    return inMemoryRequests.filter(r => r.webhook_id === webhookId).length;
  }
}

async function saveRequest(requestData) {
  if (mongoConnected) {
    const request = new Request(requestData);
    return await request.save();
  } else {
    const request = { ...requestData, _id: uuidv4() };
    inMemoryRequests.push(request);
    return request;
  }
}

async function updateRequest(rid, updateData) {
  if (mongoConnected) {
    return await Request.updateOne({ rid }, updateData);
  } else {
    const index = inMemoryRequests.findIndex(r => r.rid === rid);
    if (index !== -1) {
      inMemoryRequests[index] = { ...inMemoryRequests[index], ...updateData };
    }
  }
}

async function deleteRequests(webhookId) {
  if (mongoConnected) {
    await Request.deleteMany({ webhook_id: webhookId });
  } else {
    inMemoryRequests = inMemoryRequests.filter(r => r.webhook_id !== webhookId);
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
      webhooks: webhooksWithCounts,
      statusChoices: [200, 201, 204, 301, 302, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503]
    });
  } catch (error) {
    console.error('Error loading webhooks:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Create webhook
app.post('/webhooks', async (req, res) => {
  try {
    const { status, content_type, destination, custom_content_type, label } = req.body;
    
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
    const webhookLabel = (label && label.trim() !== '') ? label.trim() : getNextLabel(webhooks);
    
    // Validate status
    let validStatus = parseInt(status) || 200;
    if (validStatus < 100 || validStatus > 599) {
      validStatus = 200;
    }
    
    // Determine content type
    let contentType = 'text/html';
    switch (content_type) {
      case 'json':
        contentType = 'application/json';
        break;
      case 'text':
        contentType = 'text/plain';
        break;
      case 'xml':
        contentType = 'application/xml';
        break;
      case 'other':
        contentType = custom_content_type && custom_content_type.trim() !== '' 
          ? custom_content_type.trim() 
          : 'text/html';
        break;
      default:
        contentType = 'text/html';
    }
    
    // Validate destination URL
    let validDestination = '';
    if (destination && destination.trim() !== '') {
      try {
        const url = new URL(destination.trim());
        if (url.protocol === 'http:' || url.protocol === 'https:') {
          validDestination = destination.trim();
        }
      } catch (e) {
        // Invalid URL, ignore
      }
    }
    
    const webhookData = {
      id,
      label: webhookLabel,
      status: validStatus,
      content_type: contentType,
      destination: validDestination,
      tags: [] // Keep tags as empty array for backward compatibility
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

// Handle webhook requests
app.all('/webhook/:id', async (req, res) => {
  try {
    const id = sanitizeId(req.params.id);
    if (!id) {
      return res.status(400).send('Missing webhook id');
    }
    
    // Get raw body (should be available as Buffer from express.raw middleware)
    const rawBody = req.body ? req.body.toString() : '';
    
    const webhook = await findWebhookById(id);
    const status = webhook ? webhook.status : 200;
    const contentType = webhook ? webhook.content_type : 'text/html';
    const destination = webhook ? webhook.destination : '';
    
    // Build request entry
    const requestEntry = {
      webhook_id: id,
      rid: uuidv4(),
      time: new Date(),
      ip: req.ip || req.connection.remoteAddress || '',
      method: req.method,
      user_agent: req.get('User-Agent') || '',
      headers: req.headers,
      query: req.query,
      body: rawBody,
      full_url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
      path: req.originalUrl,
      response_status: status
    };
    
    // Save request to database
    try {
      await saveRequest(requestEntry);
      // Emit socket event for new request (serialize Date to ISO)
      try {
        const payload = Object.assign({}, requestEntry, { time: (requestEntry.time && requestEntry.time.toISOString) ? requestEntry.time.toISOString() : requestEntry.time });
        app.emitRequestEvent(id, 'request:new', payload);
      } catch (e) { /* ignore emit errors */ }
    } catch (error) {
      console.warn('Failed to save request:', error.message);
    }
    
    // If destination is configured, proxy the request
    if (destination && destination.trim() !== '') {
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
        
        // Build destination URL
        let destUrl = destination;
        if (destination.endsWith('/')) {
          destUrl = destination.slice(0, -1) + req.originalUrl;
        }
        
        const axiosConfig = {
          method: req.method.toLowerCase(),
          url: destUrl,
          headers,
          timeout: 30000,
          responseType: 'stream'
        };
        
        if (rawBody) {
          axiosConfig.data = rawBody;
        }
        
        const response = await axios(axiosConfig);
        
        // Stream response headers
        Object.entries(response.headers).forEach(([key, value]) => {
          res.set(key, value);
        });
        
        res.status(response.status);
        
        // Stream response body
        response.data.pipe(res);
        
        // Update request with proxied status
        try {
          await updateRequest(requestEntry.rid, {
            proxied_status: response.status,
            response_status: response.status
          });
          // Emit socket update for proxied status
          try {
            app.emitRequestEvent(id, 'request:updated', { rid: requestEntry.rid, proxied_status: response.status, response_status: response.status });
          } catch (e) { }
        } catch (error) {
          console.warn('Failed to update request:', error.message);
        }
        
      } catch (proxyError) {
        console.error('Proxy error:', proxyError);
        
        // Update request with proxy error
        try {
          await updateRequest(requestEntry.rid, {
            proxy_error: proxyError.message,
            response_status: 502
          });
          try { app.emitRequestEvent(id, 'request:updated', { rid: requestEntry.rid, proxy_error: proxyError.message, response_status: 502 }); } catch(e){}
        } catch (error) {
          console.warn('Failed to update request:', error.message);
        }
        
        res.status(502)
           .set('Content-Type', 'text/plain; charset=utf-8')
           .send(`Upstream request failed: ${proxyError.message}\n`);
      }
    } else {
      // Default local response
      res.status(status).set('Content-Type', `${contentType}; charset=utf-8`);
      
      if (contentType.includes('json')) {
        res.json({
          ok: true,
          id,
          method: req.method,
          response_status: status,
          receivedBytes: rawBody.length
        });
      } else if (contentType.includes('html')) {
        res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Webhook ${id}</title></head><body><h1>Webhook ${id}</h1><p>Status: ${status}</p></body></html>`);
      } else {
        res.send(`ok=true\nid=${id}\nmethod=${req.method}\nstatus=${status}\nbytes=${rawBody.length}\n`);
      }
    }
  } catch (error) {
    console.error('Error in webhook handler:', error);
    res.status(500).send('Internal Server Error');
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
    
    // Find selected request
    let selected = null;
    if (rid) {
      selected = requests.find(req => req.rid === rid);
    } else if (requests.length > 0) {
      selected = requests[0];
    }
    
    res.render('requests', {
      webhookId: id,
      webhook: webhook || null,
      requests,
      selected,
      selectedRid: selected ? selected.rid : null
    });
  } catch (error) {
    console.error('Error loading requests:', error);
    res.status(500).send('Internal Server Error');
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