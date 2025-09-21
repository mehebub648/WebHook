const mongoose = require('mongoose');

const requestSchema = new mongoose.Schema({
  webhook_id: {
    type: String,
    required: true,
    index: true
  },
  rid: {
    type: String,
    required: true
  },
  time: {
    type: Date,
    default: Date.now
  },
  ip: {
    type: String,
    required: true
  },
  method: {
    type: String,
    required: true
  },
  user_agent: {
    type: String,
    default: ''
  },
  headers: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  query: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  body: {
    type: String,
    default: ''
  },
  full_url: {
    type: String,
    required: true
  },
  path: {
    type: String,
    required: true
  },
  response_status: {
    type: Number,
    required: true
  },
  proxied_status: {
    type: Number
  },
  proxy_error: {
    type: String
  },
  // New fields for parsed URL parameters
  parsed_response_status: {
    type: Number
  },
  parsed_response_type: {
    type: String
  },
  parsed_forward_url: {
    type: String
  },
  background_forward: {
    type: Boolean,
    default: false
  },
  // Forward response fields
  forward_response_status: {
    type: Number
  },
  forward_response_headers: {
    type: mongoose.Schema.Types.Mixed
  },
  forward_response_body: {
    type: String
  },
  // Forward request fields (what was sent to the forwarded URL)
  forward_request_headers: {
    type: mongoose.Schema.Types.Mixed
  },
  forward_request_body: {
    type: String
  },
  forward_request_method: {
    type: String
  },
  forward_request_url: {
    type: String
  },
  forward_request_timestamp: {
    type: Date
  },
  forward_response_timestamp: {
    type: Date
  },
  forward_duration_ms: {
    type: Number
  },
  // Additional fields for webhook parameters
  full_body: {
    type: Boolean,
    default: false
  },
  tag: {
    type: String
  },
  // Read/Seen tracking
  seen: {
    type: Boolean,
    default: false
  },
  seen_at: {
    type: Date
  }
});

// Index for faster queries
requestSchema.index({ webhook_id: 1, time: -1 });

module.exports = mongoose.model('Request', requestSchema);