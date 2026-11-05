require("dotenv").config();
const { createApp } = require("./lib/app");
const { createGetDb } = require("./lib/db");
const { createTokenVerifier } = require("./lib/auth");
const { createCloudinary } = require("./lib/cloudinary");
const dns = require("dns");

dns.setServers(["1.1.1.1", "8.8.8.8"]);
const uri = process.env.MONGODB_URI;
const app = createApp({
  getDb: createGetDb({ uri, dbName: process.env.DB_NAME || "Assignment-10" }),
  verifyToken: createTokenVerifier({
    projectId: process.env.FIREBASE_PROJECT_ID,
  }),
  cloudinary: createCloudinary({
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  }),
  corsOrigin: process.env.CLIENT_ORIGIN
});

// Vercel imports the exported app; locally (or on any Node host) we listen.
if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`TaskWave API listening on port ${port}`));
}

module.exports = app;
