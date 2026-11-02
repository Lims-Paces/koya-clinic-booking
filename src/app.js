const path = require('path');
const express = require('express');
const { ensureSchema } = require('./db');
const cors = require('./middleware/cors');
const requireApiKey = require('./middleware/auth');
const { notFound, errorHandler } = require('./middleware/errors');
const slotRoutes = require('./routes/slots');
const bookingRoutes = require('./routes/bookings');

const app = express();
app.disable('x-powered-by');

app.use(cors);

// The web page. Its files are public; every API call it makes still needs the key.
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(requireApiKey);
app.use(express.json({ limit: '1mb' }));
app.use(async (req, res, next) => {
  await ensureSchema();
  next();
});

app.use('/', slotRoutes); // POST /reset, GET /slots
app.use('/bookings', bookingRoutes);

app.use(notFound);
app.use(errorHandler);

module.exports = app;
