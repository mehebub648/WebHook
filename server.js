const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const axios = require('axios');

const Webhook = require('./models/webhook');
const Request = require('./models/request');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/webhook-app';

// Connect to MongoDB
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connected to MongoDB'))
  .catch(err => {
    console.warn('MongoDB connection failed:', err.message);
    console.warn('Note: Install and start MongoDB for data persistence');
    console.warn('For now, the app will run with limited functionality');
  });

// Middleware
app.use(express.static(path.join(__dirname, 'public')));

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

// Routes

// Main dashboard
app.get('/', async (req, res) => {
  try {
    let webhooks = [];
    let webhooksWithCounts = [];
    
    try {
      webhooks = await Webhook.find().sort({ created_at: -1 });
      
      // Get request counts for each webhook
      webhooksWithCounts = await Promise.all(
        webhooks.map(async (webhook) => {
          try {
            const count = await Request.countDocuments({ webhook_id: webhook.id });
            return {
              ...webhook.toObject(),
              request_count: count
            };
          } catch (dbError) {
            console.warn('Failed to get request count for webhook:', webhook.id, dbError.message);
            return {
              ...webhook.toObject(),
              request_count: 0
            };
          }
        })
      );
    } catch (dbError) {
      console.warn('Database not available, using empty webhooks list:', dbError.message);
    }

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
    const { status, content_type, destination, custom_content_type } = req.body;
    
    let webhooks = [];
    try {
      webhooks = await Webhook.find();
    } catch (dbError) {
      console.warn('Database not available for webhook creation:', dbError.message);
      return res.status(503).send('Database not available. Please ensure MongoDB is running.');
    }
    
    let id = generateId();
    
    // Ensure unique ID
    let tries = 0;
    while (tries < 5) {
      try {
        const exists = await Webhook.findOne({ id });
        if (!exists) break;
      } catch (dbError) {
        console.warn('Database error checking for existing ID:', dbError.message);
        break; // Continue with this ID if we can't check
      }
      id = generateId();
      tries++;
    }
    
    const label = getNextLabel(webhooks);
    
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
    
    const webhook = new Webhook({
      id,
      label,
      status: validStatus,
      content_type: contentType,
      destination: validDestination
    });
    
    try {
      await webhook.save();
      res.redirect('/');
    } catch (dbError) {
      console.error('Failed to save webhook:', dbError.message);
      res.status(503).send('Database not available. Please ensure MongoDB is running.');
    }
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
    
    await Webhook.deleteOne({ id });
    await Request.deleteMany({ webhook_id: id });
    
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
    
    const webhook = await Webhook.findOne({ id });
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
      const request = new Request(requestEntry);
      await request.save();
    } catch (dbError) {
      console.warn('Failed to save request to database:', dbError.message);
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
          await Request.updateOne(
            { rid: requestEntry.rid },
            { 
              proxied_status: response.status,
              response_status: response.status
            }
          );
        } catch (dbError) {
          console.warn('Failed to update request in database:', dbError.message);
        }
        
      } catch (proxyError) {
        console.error('Proxy error:', proxyError);
        
        // Update request with proxy error
        try {
          await Request.updateOne(
            { rid: requestEntry.rid },
            { 
              proxy_error: proxyError.message,
              response_status: 502
            }
          );
        } catch (dbError) {
          console.warn('Failed to update request in database:', dbError.message);
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
    
    const requests = await Request.find({ webhook_id: id })
      .sort({ time: -1 })
      .limit(100);
    
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
    
    await Webhook.deleteOne({ id });
    await Request.deleteMany({ webhook_id: id });
    
    res.redirect('/');
  } catch (error) {
    console.error('Error deleting webhook:', error);
    res.status(500).send('Internal Server Error');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Webhook application running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
});

module.exports = app;