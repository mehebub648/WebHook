# Modern Webhook Testing Application

A Node.js webhook testing application with MongoDB storage, built with Express.js and featuring a modern responsive UI.

## Features

- Create webhook URLs with custom response status codes and content types
- Optional destination URL forwarding (proxy functionality)
- Real-time request logging and viewing
- Modern responsive UI with Tailwind CSS
- MongoDB storage for persistent data
- Copy webhook URLs to clipboard
- View detailed request information including headers, query parameters, and body

## Prerequisites

- Node.js 14+ 
- MongoDB (local or cloud instance)

## Installation

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Set environment variables (optional):
   ```bash
   export MONGODB_URI="mongodb://localhost:27017/webhook-app"
   export PORT=3000
   ```
4. Start the application:
   ```bash
   npm start
   ```

## Usage

1. Open your browser to `http://localhost:3000`
2. Create webhook URLs with desired response codes and content types
3. Send HTTP requests to your webhook URLs
4. View captured requests in real-time
5. Optionally forward requests to destination URLs

## API Endpoints

- `GET /` - Main dashboard
- `POST /webhooks` - Create new webhook
- `DELETE /webhooks/:id` - Delete webhook
- `ALL /webhook/:id` - Handle webhook requests
- `GET /request/:id` - View requests for a webhook

## Technology Stack

- **Backend**: Node.js with Express.js (CommonJS)
- **Database**: MongoDB with Mongoose
- **HTTP Client**: Axios (for proxying)
- **Templating**: EJS
- **Frontend**: Tailwind CSS + Font Awesome
- **ID Generation**: UUID

## Environment Variables

- `MONGODB_URI` - MongoDB connection string (default: `mongodb://localhost:27017/webhook-app`)
- `PORT` - Application port (default: `3000`)