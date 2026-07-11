const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PROJECT_ROOT } = require('../config');

const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CODES_FILE = path.join(DATA_DIR, 'invite_codes.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Password hashing
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
};

// Password verification
const verifyPassword = (password, storedHash) => {
  if (!storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const [, salt, hash] = parts;
  const checkHash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
  return checkHash === hash;
};

// JSON read/write helper
const readJSON = (file, defaultVal = []) => {
  try {
    if (fs.existsSync(file)) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch (err) {
    console.error(`Error reading database file ${file}:`, err);
  }
  return defaultVal;
};

const writeJSON = (file, data) => {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error(`Error writing database file ${file}:`, err);
    return false;
  }
};

const runMigration = () => {
  const { PASSWORD, MULTI_USER_ENABLED } = require('../config');
  if (!MULTI_USER_ENABLED) return;

  const db = module.exports;
  const users = db.getUsers();
  
  // 1. If users database is empty, create default admin using PASSWORD
  if (Object.keys(users).length === 0) {
    console.log('🏁 [Migration] Initializing empty user database. Creating default admin account...');
    users['admin'] = {
      username: 'admin',
      passwordHash: db.hashPassword(PASSWORD),
      role: 'admin',
      createdAt: new Date().toISOString()
    };
    db.saveUsers(users);
    console.log('✅ [Migration] Default admin account successfully created.');
  }

  // 2. If data/workspaces_admin.json doesn't exist yet, copy data from legacy workspaces.json
  // We do NOT rename/delete workspaces.json so single-user mode is unaffected.
  const workspacesFile = path.join(PROJECT_ROOT, 'workspaces.json');
  const adminWorkspacesFile = path.join(DATA_DIR, 'workspaces_admin.json');
  if (!fs.existsSync(adminWorkspacesFile) && fs.existsSync(workspacesFile)) {
    try {
      console.log('🏁 [Migration] Copying legacy workspaces.json -> data/workspaces_admin.json...');
      const workspaces = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'));
      fs.writeFileSync(adminWorkspacesFile, JSON.stringify(workspaces, null, 2), 'utf8');
      console.log('✅ [Migration] Successfully copied workspaces to admin user. Original workspaces.json is untouched.');
    } catch (err) {
      console.error('❌ [Migration] Failed to copy workspaces:', err);
    }
  }

  // 3. Migrate old im_bindings.json
  const imBindingsFile = path.join(PROJECT_ROOT, 'im_bindings.json');
  if (fs.existsSync(imBindingsFile)) {
    try {
      const bindings = JSON.parse(fs.readFileSync(imBindingsFile, 'utf8'));
      let migrated = false;
      if (bindings.telegram && Array.isArray(bindings.telegram)) {
        bindings.telegram.forEach(user => {
          if (!user.webUsername) {
            user.webUsername = 'admin';
            migrated = true;
          }
        });
      }
      if (bindings.wechat && Array.isArray(bindings.wechat)) {
        bindings.wechat.forEach(user => {
          if (!user.webUsername) {
            user.webUsername = 'admin';
            migrated = true;
          }
        });
      }
      if (migrated) {
        console.log('🏁 [Migration] Found legacy im_bindings.json. Migrating user bindings to webUsername: "admin"...');
        fs.writeFileSync(imBindingsFile, JSON.stringify(bindings, null, 2), 'utf8');
        console.log('✅ [Migration] Successfully migrated legacy im_bindings.json.');
      }
    } catch (err) {
      console.error('❌ [Migration] Failed to migrate im_bindings:', err);
    }
  }

  // 4. Rename active legacy tmux sessions
  const { exec } = require('child_process');
  exec('tmux list-sessions -F "#{session_name}"', (err, stdout) => {
    if (err) return;
    const sessions = stdout.trim().split('\n').filter(Boolean);
    sessions.forEach(s => {
      if (s === 'agy' || s === 'claude' || s === 'codex') {
        const newName = `u_admin_${s}`;
        console.log(`🏁 [Migration] Renaming legacy tmux session '${s}' to '${newName}'...`);
        exec(`tmux rename-session -t ${s} ${newName}`, (renameErr) => {
          if (renameErr) {
            console.error(`❌ [Migration] Failed to rename session ${s}:`, renameErr.message);
          } else {
            console.log(`✅ [Migration] Session '${s}' successfully renamed.`);
          }
        });
      }
    });
  });
};

module.exports = {
  getUsers: () => readJSON(USERS_FILE, {}),
  saveUsers: (users) => writeJSON(USERS_FILE, users),
  getCodes: () => readJSON(CODES_FILE, []),
  saveCodes: (codes) => writeJSON(CODES_FILE, codes),
  hashPassword,
  verifyPassword,
  runMigration
};
