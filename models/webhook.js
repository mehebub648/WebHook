const mongoose = require('mongoose');

const webhookSchema = new mongoose.Schema({
  id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  label: {
    type: String,
    required: true
  },
  status: {
    type: Number,
    required: true,
    min: 100,
    max: 599,
    default: 200
  },
  content_type: {
    type: String,
    required: true,
    default: 'text/html'
  },
  destination: {
    type: String,
    default: ''
  },
  created_at: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Webhook', webhookSchema);