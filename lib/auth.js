const { jwtVerify, createRemoteJWKSet } = require("jose");

const FIREBASE_JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

/**
 * Builds a function that verifies a Firebase ID token (JWT) and returns
 * { uid, email, name, picture }. Only the Firebase project id is required,
 * no service account / firebase-admin needed.
 *
 * `keySet` can be injected (used by the tests).
 */
function createTokenVerifier({ projectId, keySet } = {}) {
  let jwks = keySet;
  return async function verifyToken(token) {
    if (!projectId) {
      const err = new Error("Server is missing FIREBASE_PROJECT_ID");
      err.status = 500;
      throw err;
    }
    if (!jwks) jwks = createRemoteJWKSet(new URL(FIREBASE_JWKS_URL));
    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    });
    if (!payload.email) {
      const err = new Error("Token has no email");
      err.status = 401;
      throw err;
    }
    return {
      uid: payload.user_id || payload.sub,
      email: String(payload.email).toLowerCase(),
      name: payload.name || "",
      picture: payload.picture || "",
    };
  };
}

module.exports = { createTokenVerifier };
