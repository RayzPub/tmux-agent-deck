const deviceService = require('../services/deviceService');
const { verifyToken } = require('./auth');

/**
 * Middleware: Verify device ownership for incoming requests.
 * If req.params.deviceId, req.query.deviceId, req.body.deviceId, or req.headers['x-device-id']
 * is specified and is not 'cloud', it ensures:
 * 1. The user is authenticated (req.user exists or valid cookie token present).
 * 2. The device exists in the device registry.
 * 3. The device's userId strictly matches req.user.username.
 */
function requireDeviceOwnership(req, res, next) {
  const deviceId = req.params?.deviceId || req.query?.deviceId || req.body?.deviceId || req.headers['x-device-id'];

  // If no deviceId is specified, or it explicitly targets cloud, allow it through
  if (!deviceId || deviceId === 'cloud') {
    return next();
  }

  // Ensure req.user is set (support standalone mounting before or after requireAuth)
  if (!req.user) {
    const decoded = verifyToken(req);
    if (decoded && decoded.username) {
      req.user = {
        username: decoded.username,
        role: decoded.role || 'user'
      };
    }
  }

  // Must be authenticated
  if (!req.user || !req.user.username) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized: Authentication required to access remote device'
    });
  }

  const username = req.user.username;
  const device = deviceService.getDeviceById(deviceId);

  if (!device) {
    return res.status(404).json({
      success: false,
      error: `Device '${deviceId}' not found`
    });
  }

  if (device.userId !== username) {
    console.warn(`[Security Alert] Access denied: User "${username}" attempted unauthorized access to device "${deviceId}" (owned by "${device.userId}")`);
    return res.status(403).json({
      success: false,
      error: 'Forbidden: You do not have permission to access this device'
    });
  }

  req.targetDevice = device;
  next();
}

module.exports = {
  requireDeviceOwnership
};
