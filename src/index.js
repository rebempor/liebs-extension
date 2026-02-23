require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const creditsRoutes = require('./routes/credits');
const generateRoutes = require('./routes/generate');
const monitoringRoutes = require('./routes/monitoring');
const { startGenerationJobWorker } = require('./services/generationJobs');
const { trackError } = require('./services/errorTracker');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    /^chrome-extension:\/\//
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json({ limit: '50mb' })); // Large limit for base64 images

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/credits', creditsRoutes);
app.use('/api/generate', generateRoutes);
app.use('/api/monitoring', monitoringRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  trackError({
    source: 'backend',
    route: req.originalUrl || req.url || null,
    method: req.method || null,
    statusCode: 500,
    userId: req.user?.id || null,
    errorCode: err.code || null,
    message: err.message || 'Unhandled server error',
    stack: err.stack || null,
  }).catch(() => {});
  res.status(500).json({ error: err.message });
});

app.listen(PORT, () => {
  startGenerationJobWorker();

  console.log(`
╔════════════════════════════════════════════════════════╗
║  LinkedIn Pixar SaaS Backend                           ║
║  Running on http://localhost:${PORT}                       ║
╚════════════════════════════════════════════════════════╝
  `);
});
