const { MongoClient, ServerApiVersion } = require("mongodb");

let cached = null;

/** Connects once per process (important on serverless) and returns the collections. */
function createGetDb({ uri, dbName }) {
  return function getDb() {
    if (!cached) {
      cached = (async () => {
        const client = new MongoClient(uri, {
          serverApi: { version: ServerApiVersion.v1, strict: false, deprecationErrors: true },
        });
        await client.connect();
        const database = client.db(dbName);
        const collections = {
          tasks: database.collection("taskCollection"),
          users: database.collection("users"),
          bids: database.collection("bids"),
        };
        await prepare(collections);
        return collections;
      })().catch((e) => {
        cached = null;
        throw e;
      });
    }
    return cached;
  };
}

/** Indexes + one-time upgrade of documents created by TaskWave v1. Safe to run repeatedly. */
async function prepare({ tasks, users, bids }) {
  try {
    await Promise.all([
      users.createIndex({ email: 1 }, { unique: true }),
      bids.createIndex({ taskId: 1, freelancerEmail: 1 }, { unique: true }),
      bids.createIndex({ freelancerEmail: 1, createdAt: -1 }),
      tasks.createIndex({ email: 1, createdAt: -1 }),
      tasks.createIndex({ status: 1, createdAt: -1 }),
      tasks.createIndex({ "assignedTo.email": 1 }),
    ]);
    await tasks.updateMany({ budget: { $type: "string" } }, [
      { $set: { budget: { $convert: { input: "$budget", to: "double", onError: 0, onNull: 0 } } } },
    ]);
    await tasks.updateMany({ status: { $exists: false } }, [
      { $set: { status: "open", createdAt: { $toDate: "$_id" }, updatedAt: { $toDate: "$_id" } } },
    ]);
    await tasks.updateMany({ bid: { $exists: false } }, { $set: { bid: 0, bidders: [] } });
  } catch (e) {
    console.error("Database preparation skipped:", e.message);
  }
}

module.exports = { createGetDb };
