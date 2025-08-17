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
  }
});

// Index for faster queries
requestSchema.index({ webhook_id: 1, time: -1 });

module.exports = mongoose.model('Request', requestSchema);