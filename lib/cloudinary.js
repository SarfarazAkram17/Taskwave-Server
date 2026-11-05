const crypto = require("crypto");
const { HttpError } = require("./util");

/**
 * Cloudinary helper (no SDK needed).
 *  - sign():       gives an authenticated user a short-lived signature so the browser can upload straight to Cloudinary
 *  - isOwnImage(): only accepts image URLs that live in OUR Cloudinary account/folder, so users can't paste random links
 * The API secret never leaves the server.
 */
function createCloudinary({
  cloudName,
  apiKey,
  apiSecret,
  folder = "taskwave/avatars",
} = {}) {
  const configured = Boolean(cloudName && apiKey && apiSecret);
  const prefix = `https://res.cloudinary.com/${cloudName}/image/upload/`;

  return {
    configured,
    folder,
    sign() {
      if (!configured) {
        throw new HttpError(
          503,
          "Image uploads aren't configured on the server yet",
          "UPLOADS_DISABLED",
        );
      }
      const timestamp = Math.floor(Date.now() / 1000);
      const params = { folder, timestamp };
      const toSign = Object.keys(params)
        .sort()
        .map((k) => `${k}=${params[k]}`)
        .join("&");
      const signature = crypto
        .createHash("sha1")
        .update(toSign + apiSecret)
        .digest("hex");
      return { cloudName, apiKey, timestamp, folder, signature };
    },
    isOwnImage(url) {
      return (
        configured &&
        typeof url === "string" &&
        url.length <= 500 &&
        url.startsWith(prefix) &&
        url.includes(`/${folder}/`) &&
        !/[\s"'<>\\]|\.\./.test(url)
      );
    },
  };
}

module.exports = { createCloudinary };