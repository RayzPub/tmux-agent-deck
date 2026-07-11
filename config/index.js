const path = require('path');
const fs = require('fs');

// Load env from project root
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const PROJECT_ROOT = path.resolve(__dirname, '..');

const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;
const PASSWORD = process.env.PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const MULTI_USER_ENABLED = process.env.MULTI_USER_ENABLED === 'true';

let useHttps = false;
let sslOptions = null;

if (SSL_CERT_PATH && SSL_KEY_PATH) {
  try {
    if (fs.existsSync(SSL_CERT_PATH) && fs.existsSync(SSL_KEY_PATH)) {
      sslOptions = {
        cert: fs.readFileSync(SSL_CERT_PATH),
        key: fs.readFileSync(SSL_KEY_PATH)
      };
      useHttps = true;
      console.log(`🔒 SSL Certificates successfully loaded: cert=${SSL_CERT_PATH}, key=${SSL_KEY_PATH}`);
    } else {
      console.warn(`⚠️ WARNING: SSL certificate files configured but not found on disk.`);
      console.warn(`Expected Cert at: ${SSL_CERT_PATH}`);
      console.warn(`Expected Key at: ${SSL_KEY_PATH}`);
    }
  } catch (err) {
    console.error('❌ ERROR: Failed to load SSL certificates:', err);
  }
}

if (!PASSWORD || PASSWORD.length < 16) {
  console.error('FATAL: PASSWORD must be set in environment and be at least 16 characters');
  process.exit(1);
}

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET must be set in environment and be at least 32 characters');
  process.exit(1);
}

module.exports = {
  PROJECT_ROOT,
  PORT,
  HTTPS_PORT,
  PASSWORD,
  JWT_SECRET,
  SSL_CERT_PATH,
  SSL_KEY_PATH,
  useHttps,
  sslOptions,
  MULTI_USER_ENABLED
};

