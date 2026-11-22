const { spawn } = require('child_process');
const { getRunUser } = require('./tmuxService');

// Helper for running shell commands securely (e.g. git)
const execCommand = (cmd, args, cwd, callback) => {
  const user = getRunUser();
  let finalCmd = cmd;
  let finalArgs = args;
  
  if (user) {
    finalCmd = 'sudo';
    finalArgs = ['-u', user, cmd, ...args];
  }
  
  try {
    const proc = spawn(finalCmd, finalArgs, { cwd });
    let stdout = '', stderr = '';
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    proc.on('error', (err) => {
      callback(err, stdout, stderr);
    });
    
    proc.on('close', (code) => {
      if (code !== 0 && code !== 1) { // git diff and git diff --no-index can exit with 1 on differences, which is normal
        const err = new Error(`exit ${code}`);
        err.code = code;
        callback(err, stdout, stderr);
      } else {
        callback(null, stdout, stderr);
      }
    });
  } catch (err) {
    callback(err, '', '');
  }
};

module.exports = {
  execCommand
};
