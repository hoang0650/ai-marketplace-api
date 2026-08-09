const mongoose = require('mongoose');
const config = require('./env');

const RECONNECT_DELAY_MS = 5000;
let listenersBound = false;
let reconnectTimer = null;
let isConnecting = false;

const mongoOptions = {
  serverSelectionTimeoutMS: 8000,
  socketTimeoutMS: 20000,
  connectTimeoutMS: 8000,
  maxPoolSize: 10,
  minPoolSize: 2,
  retryWrites: true,
  retryReads: true,
};

function scheduleReconnect(reason) {
  if (reconnectTimer || isConnecting || mongoose.connection.readyState === 1) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.log(`[db] ${reason}`);
    connectDb();
  }, RECONNECT_DELAY_MS);
}

function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;

  mongoose.connection.on('connected', () => {
    console.info('[db] Connected to MongoDB successful');
  });

  mongoose.connection.on('error', (err) => {
    console.error('[db] Mongoose connection error:', err);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[db] Database connection is disconnected');
    scheduleReconnect('Attempting to reconnect to MongoDB...');
  });
  // Graceful shutdown (SIGINT/SIGTERM) is handled centrally in server.js.
}

function connectDb() {
  if (mongoose.connection.readyState === 1) {
    return Promise.resolve(mongoose.connection);
  }
  if (isConnecting) {
    return new Promise((resolve, reject) => {
      mongoose.connection.once('connected', () => resolve(mongoose.connection));
      mongoose.connection.once('error', reject);
    });
  }
  isConnecting = true;

  try {
    mongoose.set('bufferCommands', false);
    mongoose.set('bufferTimeoutMS', 10000);
  } catch (_) {}

  bindListeners();

  return mongoose
    .connect(config.mongoUri, mongoOptions)
    .then((conn) => conn)
    .catch((err) => {
      console.error('[db] Mongoose connection error:', err);
      scheduleReconnect('Retrying MongoDB connection...');
      throw err;
    })
    .finally(() => {
      isConnecting = false;
    });
}

function isDbReady() {
  return mongoose.connection.readyState === 1;
}

module.exports = { connectDb, isDbReady };
