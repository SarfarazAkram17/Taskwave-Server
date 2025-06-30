require("dotenv").config();
const express = require("express");
const app = express();
const port = process.env.PORT || 3000;
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Assignment 10 running");
});

app.listen(port, () => {
  console.log("server work properly");
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.or0q8ig.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();

    const taskCollection = client
      .db("Assignment-10")
      .collection("taskCollection");

    app.get("/tasks", async (req, res) => {
      const result = await taskCollection.find().toArray();
      res.send(result);
    });

    app.get("/tasks/:id", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await taskCollection.findOne(query);
      res.send(result);
    });

    app.post("/tasks", async (req, res) => {
      const task = req.body;
      const result = await taskCollection.insertOne(task);
      res.send(result);
    });

    app.put("/tasks/:id", async (req, res) => {
      const { id } = req.params;
      const updatedTask = req.body;
      const filter = { _id: new ObjectId(id) };
      const updatedDoc = {
        $set: updatedTask,
      };
      const options = { upsert: true };
      const result = await taskCollection.updateOne(
        filter,
        updatedDoc,
        options
      );
      res.send(result);
    });

    app.patch("/tasks/:id", async (req, res) => {
      const { id } = req.params;
      const { email } = req.body;
      const filter = { _id: new ObjectId(id) };

      const task = await taskCollection.findOne(filter);
      const currentBid = task.bid;

      if (task.email === email) {
        return res.send({message: "This task is posted by you. So you don't bid for this task."});
      }

      if (task.bidders.includes(email)) {
        return res.send({message: "You already placed a bid on this task."});
      }

      const updatedDoc = {
        $set: {
          bid: currentBid + 1,
        },
        $push: {
          bidders: email,
        },
      };
      const result = await taskCollection.updateOne(filter, updatedDoc);
      res.send(result);
    });

    app.delete("/tasks/:id", async (req, res) => {
      const { id } = req.params;
      const query = { _id: new ObjectId(id) };
      const result = await taskCollection.deleteOne(query);
      res.send(result);
    });

    app.get("/featuredTasks", async (req, res) => {
      const result = await taskCollection
        .find()
        .sort({ deadline: 1 })
        .limit(6)
        .toArray();
      res.send(result);
    });

    app.get("/tasks/email/:email", async (req, res) => {
      const { email } = req.params;
      const query = { email };
      const result = await taskCollection.find(query).toArray();
      res.send(result);
    });

    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
  }
}
run().catch(console.dir);
