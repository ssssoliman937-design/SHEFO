const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');

// Environment & Secret Configuration
const defaultPort = parseInt(process.env.PORT || '3001', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const app = express();

// Bypass tunnel reminders & allow cross-origin access
app.use((req, res, next) => {
  res.setHeader('bypass-tunnel-reminder', 'true');
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', '*');
  next();
});

// API Resilience: Rate Limiter on all incoming requests
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: 429, error: 'Too many requests, please try again later.' }
});
app.use(apiLimiter);

// Static web app. The web app is fully client-side and talks to Firebase
// directly from the browser (public/js/firebase-engine.js). This server
// just hosts files - it holds no game state.
app.use(express.static(path.join(__dirname, 'public')));

function startServer(portToUse) {
  app.listen(portToUse, () => {
    console.log(`\n=================================================`);
    console.log(` ⚽ Deal Or No Deal Football Server is Running!`);
    console.log(` 👉 Open in browser: http://localhost:${portToUse}`);
    console.log(`=================================================\n`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`⚠️ Port ${portToUse} is in use, trying port ${portToUse + 1}...`);
      startServer(portToUse + 1);
    } else {
      console.error(err);
    }
  });
}

if (!process.env.VERCEL) {
  startServer(defaultPort);
}

module.exports = app;
