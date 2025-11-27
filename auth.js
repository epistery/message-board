import crypto from 'crypto';

/**
 * Authentication middleware for message board
 * Uses delegation tokens from epistery white-list agent client
 */

const EPISTERY_AGENT_URL = process.env.EPISTERY_AGENT_URL || 'http://localhost:4080/agent/epistery/white-list';

/**
 * Verify delegation token with white-list agent
 */
async function verifyWithWhiteListAgent(delegationToken) {
  try {
    const response = await fetch(`${EPISTERY_AGENT_URL}/check`, {
      method: 'GET',
      headers: {
        'X-Epistery-Delegation': JSON.stringify(delegationToken),
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      return { valid: false, error: error.error || `Agent returned ${response.status}` };
    }

    const result = await response.json();
    return {
      valid: result.allowed,
      address: result.address,
      domain: result.domain,
      error: result.error
    };
  } catch (error) {
    console.error('[auth] White-list agent check failed:', error);
    return { valid: false, error: error.message };
  }
}

/**
 * Parse delegation token from request
 */
function parseDelegationToken(req) {
  // Check header first
  const headerToken = req.headers['x-epistery-delegation'];
  if (headerToken) {
    try {
      return typeof headerToken === 'string' ? JSON.parse(headerToken) : headerToken;
    } catch (e) {
      console.error('[auth] Invalid delegation header:', e);
    }
  }

  // Check cookie
  const cookieToken = req.cookies?.epistery_delegation;
  if (cookieToken) {
    try {
      return typeof cookieToken === 'string' ? JSON.parse(cookieToken) : cookieToken;
    } catch (e) {
      console.error('[auth] Invalid delegation cookie:', e);
    }
  }

  // Check body (for POST requests)
  if (req.body?.delegationToken) {
    return req.body.delegationToken;
  }

  return null;
}

/**
 * Authentication middleware
 * Verifies user via epistery white-list agent
 */
export async function requireAuth(req, res, next) {
  const token = parseDelegationToken(req);

  if (!token) {
    console.log('[auth] No delegation token found in request');
    return res.status(401).json({
      error: 'Authentication required',
      message: 'No delegation token provided'
    });
  }

  console.log('[auth] Verifying token for:', token.delegation?.subject);

  // Verify with white-list agent
  const verification = await verifyWithWhiteListAgent(token);

  if (!verification.valid) {
    console.log('[auth] Verification failed:', verification.error);
    return res.status(403).json({
      error: 'Access denied',
      message: verification.error || 'Not authorized'
    });
  }

  console.log('[auth] Access granted for:', verification.address);

  // Attach user info to request
  req.user = {
    id: verification.address,
    address: verification.address,
    domain: verification.domain
  };

  next();
}

/**
 * Optional authentication middleware
 * Allows anonymous access but attaches user if authenticated
 */
export async function optionalAuth(req, res, next) {
  const token = parseDelegationToken(req);

  if (!token) {
    // Anonymous user
    req.user = {
      id: 'anonymous-' + crypto.randomBytes(8).toString('hex'),
      address: null,
      anonymous: true
    };
    return next();
  }

  // Try to verify
  const verification = await verifyWithWhiteListAgent(token);

  if (verification.valid) {
    req.user = {
      id: verification.address,
      address: verification.address,
      domain: verification.domain,
      anonymous: false
    };
  } else {
    req.user = {
      id: 'anonymous-' + crypto.randomBytes(8).toString('hex'),
      address: null,
      anonymous: true
    };
  }

  next();
}
