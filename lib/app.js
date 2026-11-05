const express = require("express");
const cors = require("cors");
const {
  CATEGORIES,
  ROLES,
  SELF_SERVICE_ROLES,
  TASK_STATUSES,
} = require("./constants");
const {
  HttpError,
  toId,
  escapeRegex,
  str,
  money,
  isoDate,
  todayISO,
  paginate,
  fillMonths,
} = require("./util");

const OPEN = { $or: [{ status: "open" }, { status: { $exists: false } }] };
const ACTIVE_STATUSES = ["in_progress", "in_review"];

/**
 * Builds the Express app. Everything environment specific is injected so the
 * API can be exercised in tests without MongoDB or Firebase.
 */
function createApp({ getDb, verifyToken, cloudinary, corsOrigin }) {
  const app = express();

  app.use(cors(corsOrigin ? { origin: corsOrigin } : undefined));
  app.use(express.json({ limit: "100kb" }));

  // ---------------------------------------------------------------- helpers
  const db = async (req, _res, next) => {
    req.db = await getDb();
    next();
  };
  app.use(db);

  const bearer = (req) => {
    const h = req.headers.authorization || "";
    return h.startsWith("Bearer ") ? h.slice(7) : null;
  };

  /** Roles live in the `users` collection: the document is the single source of truth. */
  const resolveUser = (req, identity) =>
    req.db.users.findOne({ email: identity.email });

  /** Requires a valid Firebase token. `profile: false` allows users without a TaskWave profile yet. */
  const authenticate =
    ({ profile = true } = {}) =>
    async (req, _res, next) => {
      const token = bearer(req);
      if (!token)
        throw new HttpError(401, "Please log in to continue", "NO_TOKEN");
      try {
        req.identity = await verifyToken(token);
      } catch (e) {
        if (e.status) throw e;
        throw new HttpError(
          401,
          "Your session has expired. Please log in again.",
          "BAD_TOKEN",
        );
      }
      req.user = await resolveUser(req, req.identity);
      if (profile && !req.user) {
        throw new HttpError(
          403,
          "Finish setting up your account first",
          "NO_PROFILE",
        );
      }
      if (req.user?.status === "suspended") {
        throw new HttpError(
          403,
          "This account has been suspended",
          "SUSPENDED",
        );
      }
      next();
    };

  /** Attaches req.user when a valid token is sent, never fails. */
  const optionalAuth = async (req, _res, next) => {
    const token = bearer(req);
    if (token) {
      try {
        req.identity = await verifyToken(token);
        req.user = await resolveUser(req, req.identity);
      } catch {
        /* treat as anonymous */
      }
    }
    next();
  };

  const requireRole =
    (...roles) =>
    (req, _res, next) => {
      if (!roles.includes(req.user.role)) {
        throw new HttpError(
          403,
          "You don't have permission to do this",
          "FORBIDDEN",
        );
      }
      next();
    };

  const auth = authenticate();
  const needClient = [auth, requireRole("client", "admin")];
  const needFreelancer = [auth, requireRole("freelancer")];
  const needAdmin = [auth, requireRole("admin")];

  const statusOf = (t) => t.status || "open";

  /** Shapes a task for the API; private fields only for the owner, assignee and admins. */
  const shapeTask = (t, viewer) => {
    const { bidders, email, submission, feedback, ...rest } = t;
    const isOwner = !!viewer && viewer.email === email;
    const isAssignee = !!viewer && t.assignedTo?.email === viewer.email;
    const privileged = isOwner || isAssignee || viewer?.role === "admin";
    return {
      ...rest,
      status: statusOf(t),
      proposals: t.bid || 0,
      isOwner,
      isAssignee,
      ...(privileged ? { email, submission, feedback } : {}),
    };
  };

  const loadTask = async (req, id) => {
    const task = await req.db.tasks.findOne({ _id: toId(id, "task id") });
    if (!task) throw new HttpError(404, "Task not found");
    return task;
  };
  const assertOwner = (req, task) => {
    if (task.email !== req.user.email && req.user.role !== "admin") {
      throw new HttpError(403, "Only the task owner can do this", "FORBIDDEN");
    }
  };

  const validateTask = (body, { partial = false } = {}) => {
    const out = {};
    const has = (k) => !partial || body[k] !== undefined;
    if (has("title"))
      out.title = str(body.title, { min: 5, max: 120, label: "Title" });
    if (has("category")) {
      if (!CATEGORIES.includes(body.category))
        throw new HttpError(400, "Pick a valid category");
      out.category = body.category;
    }
    if (has("deadline")) {
      if (!isoDate(body.deadline))
        throw new HttpError(400, "Deadline must be a valid date");
      if (body.deadline < todayISO())
        throw new HttpError(400, "Deadline can't be in the past");
      out.deadline = body.deadline;
    }
    if (has("budget")) out.budget = money(body.budget, "Budget");
    if (has("description")) {
      out.description = str(body.description, {
        min: 20,
        max: 5000,
        label: "Description",
      });
    }
    return out;
  };

  // ----------------------------------------------------------------- health
  app.get("/", (_req, res) =>
    res.json({ name: "TaskWave API", status: "ok", version: "2.0.0" }),
  );
  app.get("/meta", (_req, res) =>
    res.json({
      categories: CATEGORIES,
      roles: ROLES,
      taskStatuses: TASK_STATUSES,
    }),
  );

  // ------------------------------------------------------------------ users
  app.get("/users/me", authenticate({ profile: false }), (req, res) => {
    if (!req.user) throw new HttpError(404, "No profile yet", "NO_PROFILE");
    res.json(req.user);
  });

  // Image uploads: the browser uploads straight to Cloudinary using this short-lived signature.
  // The API secret never leaves the server.
  app.post(
    "/uploads/signature",
    authenticate({ profile: false }),
    (_req, res) => {
      if (!cloudinary)
        throw new HttpError(
          503,
          "Image uploads aren't configured on the server yet",
          "UPLOADS_DISABLED",
        );
      res.json(cloudinary.sign());
    },
  );

  // Only images hosted in OUR Cloudinary folder are accepted (or "" to remove the photo),
  // so users upload a file instead of pasting an arbitrary link.
  const checkPhoto = (value, current = "") => {
    const v = str(value, { max: 500 });
    if (v === "" || v === current) return v;
    if (!cloudinary?.isOwnImage(v))
      throw new HttpError(400, "Upload an image file instead of using a link");
    return v;
  };

  app.post(
    "/users/register",
    authenticate({ profile: false }),
    async (req, res) => {
      // An existing document (including a manually created admin) is returned as-is: roles can't be changed here.
      if (req.user) return res.json(req.user);
      const role = req.body.role;
      if (!SELF_SERVICE_ROLES.includes(role)) {
        throw new HttpError(
          400,
          "Choose whether you want to hire (client) or work (freelancer)",
        );
      }
      const uploaded = cloudinary?.isOwnImage(req.body.photo)
        ? req.body.photo
        : "";
      const doc = {
        email: req.identity.email,
        name:
          str(req.body.name, { max: 80 }) ||
          req.identity.name ||
          req.identity.email.split("@")[0],
        photo: uploaded || req.identity.picture || "",
        role,
        status: "active",
        headline: "",
        bio: "",
        location: "",
        createdAt: new Date(),
      };
      try {
        const { insertedId } = await req.db.users.insertOne(doc);
        res.status(201).json({ ...doc, _id: insertedId });
      } catch (e) {
        if (e.code === 11000)
          return res.json(await req.db.users.findOne({ email: doc.email }));
        throw e;
      }
    },
  );

  app.patch("/users/me", auth, async (req, res) => {
    const set = {};
    if (req.body.name !== undefined)
      set.name = str(req.body.name, { min: 2, max: 80, label: "Name" });
    if (req.body.photo !== undefined)
      set.photo = checkPhoto(req.body.photo, req.user.photo || "");
    if (req.body.headline !== undefined)
      set.headline = str(req.body.headline, { max: 100 });
    if (req.body.bio !== undefined) set.bio = str(req.body.bio, { max: 1000 });
    if (req.body.location !== undefined)
      set.location = str(req.body.location, { max: 80 });
    await req.db.users.updateOne({ _id: req.user._id }, { $set: set });
    res.json({ ...req.user, ...set });
  });

  // ------------------------------------------------------------------ tasks
  const taskFilter = (q) => {
    const and = [];
    const status = q.status || "open";
    if (status === "open") and.push(OPEN);
    else if (TASK_STATUSES.includes(status)) and.push({ status });
    if (q.category && CATEGORIES.includes(q.category))
      and.push({ category: q.category });
    if (q.q) {
      const rx = new RegExp(escapeRegex(String(q.q).slice(0, 80)), "i");
      and.push({ $or: [{ title: rx }, { description: rx }, { category: rx }] });
    }
    const min = Number(q.minBudget);
    const max = Number(q.maxBudget);
    if (Number.isFinite(min) && q.minBudget !== "")
      and.push({ budget: { $gte: min } });
    if (Number.isFinite(max) && q.maxBudget !== "")
      and.push({ budget: { $lte: max } });
    return and.length ? { $and: and } : {};
  };
  const SORTS = {
    newest: { createdAt: -1, _id: -1 },
    deadline: { deadline: 1, _id: 1 },
    budgetHigh: { budget: -1, _id: -1 },
    budgetLow: { budget: 1, _id: -1 },
    proposals: { bid: -1, _id: -1 },
  };

  app.get("/tasks", optionalAuth, async (req, res) => {
    const { page, limit, skip } = paginate(req.query);
    const filter = taskFilter(req.query);
    const sort = SORTS[req.query.sort] || SORTS.newest;
    const [items, total] = await Promise.all([
      req.db.tasks.find(filter).sort(sort).skip(skip).limit(limit).toArray(),
      req.db.tasks.countDocuments(filter),
    ]);
    res.json({
      items: items.map((t) => shapeTask(t, req.user)),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  });

  app.get("/featuredTasks", async (req, res) => {
    const items = await req.db.tasks
      .find({ $and: [OPEN, { deadline: { $gte: todayISO() } }] })
      .sort({ deadline: 1, _id: 1 })
      .limit(6)
      .toArray();
    res.json(items.map((t) => shapeTask(t, null)));
  });

  app.get("/stats/public", async (req, res) => {
    const [openTasks, freelancers, completed] = await Promise.all([
      req.db.tasks.countDocuments(OPEN),
      req.db.users.countDocuments({ role: "freelancer" }),
      req.db.tasks.countDocuments({ status: "completed" }),
    ]);
    res.json({ openTasks, freelancers, completed });
  });

  app.get("/tasks/mine", ...needClient, async (req, res) => {
    const filter = { email: req.user.email };
    if (TASK_STATUSES.includes(req.query.status))
      filter.status = req.query.status;
    const tasks = await req.db.tasks
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .toArray();
    const pending = await req.db.bids
      .aggregate([
        {
          $match: {
            status: "pending",
            taskId: { $in: tasks.map((t) => t._id) },
          },
        },
        { $group: { _id: "$taskId", n: { $sum: 1 } } },
      ])
      .toArray();
    const pendingMap = new Map(pending.map((p) => [String(p._id), p.n]));
    res.json(
      tasks.map((t) => ({
        ...shapeTask(t, req.user),
        pendingProposals: pendingMap.get(String(t._id)) || 0,
      })),
    );
  });

  app.get("/jobs/mine", ...needFreelancer, async (req, res) => {
    const filter = { "assignedTo.email": req.user.email };
    if (TASK_STATUSES.includes(req.query.status))
      filter.status = req.query.status;
    const tasks = await req.db.tasks
      .find(filter)
      .sort({ updatedAt: -1, _id: -1 })
      .toArray();
    res.json(tasks.map((t) => shapeTask(t, req.user)));
  });

  app.get("/tasks/:id", optionalAuth, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    const shaped = shapeTask(task, req.user);
    let myBid = null;
    if (req.user && req.user.role === "freelancer") {
      myBid = await req.db.bids.findOne({
        taskId: task._id,
        freelancerEmail: req.user.email,
      });
    }
    res.json({ ...shaped, myBid });
  });

  app.post("/tasks", ...needClient, async (req, res) => {
    const fields = validateTask(req.body);
    const now = new Date();
    const doc = {
      ...fields,
      email: req.user.email,
      name: req.user.name,
      ownerPhoto: req.user.photo || "",
      status: "open",
      bid: 0,
      bidders: [],
      createdAt: now,
      updatedAt: now,
    };
    const { insertedId } = await req.db.tasks.insertOne(doc);
    res
      .status(201)
      .json({ ...shapeTask(doc, req.user), _id: insertedId, insertedId });
  });

  app.put("/tasks/:id", ...needClient, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    assertOwner(req, task);
    if (statusOf(task) !== "open" && req.user.role !== "admin") {
      throw new HttpError(409, "Only open tasks can be edited");
    }
    const fields = validateTask(req.body, { partial: true });
    // A past deadline is only a problem when the deadline is being changed.
    fields.updatedAt = new Date();
    await req.db.tasks.updateOne({ _id: task._id }, { $set: fields });
    res.json({ ...shapeTask({ ...task, ...fields }, req.user) });
  });

  const cancelTask = async (req, task, reason) => {
    await req.db.tasks.updateOne(
      { _id: task._id },
      {
        $set: {
          status: "cancelled",
          cancelledAt: new Date(),
          updatedAt: new Date(),
          cancelReason: reason || "",
        },
      },
    );
    await req.db.bids.updateMany(
      { taskId: task._id, status: "pending" },
      { $set: { status: "rejected", decidedAt: new Date() } },
    );
  };

  app.post("/tasks/:id/cancel", ...needClient, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    assertOwner(req, task);
    const s = statusOf(task);
    const cancellable =
      req.user.role === "admin" ? ["open", ...ACTIVE_STATUSES] : ["open"];
    if (!cancellable.includes(s))
      throw new HttpError(409, "This task can't be cancelled now");
    await cancelTask(req, task, str(req.body?.reason, { max: 300 }));
    res.json({ ok: true, status: "cancelled" });
  });

  app.delete("/tasks/:id", ...needClient, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    assertOwner(req, task);
    if (ACTIVE_STATUSES.includes(statusOf(task)) && req.user.role !== "admin") {
      throw new HttpError(
        409,
        "A task in progress can't be deleted. Cancel or complete it first.",
      );
    }
    await req.db.bids.deleteMany({ taskId: task._id });
    const result = await req.db.tasks.deleteOne({ _id: task._id });
    res.json({ ...result, ok: true });
  });

  // ---------------------------------------------------------------- bids
  app.post("/tasks/:id/bids", ...needFreelancer, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    if (task.email === req.user.email) {
      throw new HttpError(403, "You can't send a proposal to your own task");
    }
    if (statusOf(task) !== "open")
      throw new HttpError(409, "This task is no longer accepting proposals");
    const bid = {
      taskId: task._id,
      freelancerEmail: req.user.email,
      freelancerName: req.user.name,
      freelancerPhoto: req.user.photo || "",
      freelancerHeadline: req.user.headline || "",
      amount: money(req.body.amount, "Your price"),
      message: str(req.body.message, {
        min: 20,
        max: 2000,
        label: "Cover message",
      }),
      deliveryDays: Math.min(
        365,
        Math.max(1, parseInt(req.body.deliveryDays, 10) || 7),
      ),
      status: "pending",
      createdAt: new Date(),
    };
    const previous = await req.db.bids.findOne({
      taskId: task._id,
      freelancerEmail: bid.freelancerEmail,
    });
    if (previous && previous.status !== "withdrawn") {
      throw new HttpError(409, "You already sent a proposal for this task");
    }
    if (previous) {
      await req.db.bids.deleteOne({ _id: previous._id });
    }
    let insertedId;
    try {
      ({ insertedId } = await req.db.bids.insertOne(bid));
    } catch (e) {
      if (e.code === 11000)
        throw new HttpError(409, "You already sent a proposal for this task");
      throw e;
    }
    await req.db.tasks.updateOne(
      { _id: task._id },
      { $inc: { bid: 1 }, $addToSet: { bidders: bid.freelancerEmail } },
    );
    res.status(201).json({ ...bid, _id: insertedId });
  });

  app.get("/tasks/:id/bids", ...needClient, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    assertOwner(req, task);
    const bids = await req.db.bids
      .find({ taskId: task._id })
      .sort({ createdAt: -1 })
      .toArray();
    res.json(bids);
  });

  app.get("/bids/mine", ...needFreelancer, async (req, res) => {
    const bids = await req.db.bids
      .find({ freelancerEmail: req.user.email })
      .sort({ createdAt: -1 })
      .toArray();
    const tasks = await req.db.tasks
      .find({ _id: { $in: bids.map((b) => b.taskId) } })
      .toArray();
    const map = new Map(tasks.map((t) => [String(t._id), t]));
    res.json(
      bids.map((b) => {
        const t = map.get(String(b.taskId));
        return {
          ...b,
          task: t
            ? {
                _id: t._id,
                title: t.title,
                category: t.category,
                budget: t.budget,
                deadline: t.deadline,
                status: statusOf(t),
                clientName: t.name,
              }
            : null,
        };
      }),
    );
  });

  const loadBid = async (req, id) => {
    const bid = await req.db.bids.findOne({ _id: toId(id, "proposal id") });
    if (!bid) throw new HttpError(404, "Proposal not found");
    return bid;
  };

  app.delete("/bids/:id", ...needFreelancer, async (req, res) => {
    const bid = await loadBid(req, req.params.id);
    if (bid.freelancerEmail !== req.user.email)
      throw new HttpError(403, "This isn't your proposal");
    if (bid.status !== "pending")
      throw new HttpError(409, "Only pending proposals can be withdrawn");
    await req.db.bids.updateOne(
      { _id: bid._id },
      { $set: { status: "withdrawn", decidedAt: new Date() } },
    );
    await req.db.tasks.updateOne(
      { _id: bid.taskId },
      { $inc: { bid: -1 }, $pull: { bidders: bid.freelancerEmail } },
    );
    res.json({ ok: true });
  });

  app.post("/bids/:id/accept", ...needClient, async (req, res) => {
    const bid = await loadBid(req, req.params.id);
    const task = await loadTask(req, bid.taskId);
    assertOwner(req, task);
    if (bid.status !== "pending")
      throw new HttpError(409, "This proposal has already been decided");
    const now = new Date();
    // Atomic guard: only one proposal can move an open task to in_progress.
    const claimed = await req.db.tasks.updateOne(
      { _id: task._id, ...OPEN },
      {
        $set: {
          status: "in_progress",
          assignedTo: {
            email: bid.freelancerEmail,
            name: bid.freelancerName,
            photo: bid.freelancerPhoto || "",
          },
          acceptedBidId: bid._id,
          acceptedAmount: bid.amount,
          acceptedAt: now,
          updatedAt: now,
        },
      },
    );
    if (!claimed.modifiedCount)
      throw new HttpError(409, "This task already has a freelancer");
    await req.db.bids.updateOne(
      { _id: bid._id },
      { $set: { status: "accepted", decidedAt: now } },
    );
    await req.db.bids.updateMany(
      { taskId: task._id, status: "pending" },
      { $set: { status: "rejected", decidedAt: now } },
    );
    res.json({ ok: true });
  });

  app.post("/bids/:id/reject", ...needClient, async (req, res) => {
    const bid = await loadBid(req, req.params.id);
    const task = await loadTask(req, bid.taskId);
    assertOwner(req, task);
    if (bid.status !== "pending")
      throw new HttpError(409, "This proposal has already been decided");
    await req.db.bids.updateOne(
      { _id: bid._id },
      { $set: { status: "rejected", decidedAt: new Date() } },
    );
    res.json({ ok: true });
  });

  // ------------------------------------------------- delivery & review
  app.post("/tasks/:id/submit", ...needFreelancer, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    if (task.assignedTo?.email !== req.user.email)
      throw new HttpError(403, "This task isn't assigned to you");
    if (statusOf(task) !== "in_progress")
      throw new HttpError(409, "This task isn't waiting for your delivery");
    const submission = {
      note: str(req.body.note, { min: 10, max: 3000, label: "Delivery note" }),
      link: str(req.body.link, { max: 500 }),
      submittedAt: new Date(),
    };
    if (submission.link && !/^https?:\/\//i.test(submission.link)) {
      throw new HttpError(
        400,
        "Delivery link must start with http:// or https://",
      );
    }
    await req.db.tasks.updateOne(
      { _id: task._id },
      {
        $set: { status: "in_review", submission, updatedAt: new Date() },
        $unset: { feedback: "" },
      },
    );
    res.json({ ok: true, status: "in_review" });
  });

  app.post("/tasks/:id/review", ...needClient, async (req, res) => {
    const task = await loadTask(req, req.params.id);
    assertOwner(req, task);
    if (statusOf(task) !== "in_review")
      throw new HttpError(409, "There is no delivery to review");
    const now = new Date();
    if (req.body.action === "approve") {
      await req.db.tasks.updateOne(
        { _id: task._id },
        { $set: { status: "completed", completedAt: now, updatedAt: now } },
      );
      return res.json({ ok: true, status: "completed" });
    }
    if (req.body.action === "revise") {
      const feedback = str(req.body.feedback, {
        min: 5,
        max: 2000,
        label: "Feedback",
      });
      await req.db.tasks.updateOne(
        { _id: task._id },
        { $set: { status: "in_progress", feedback, updatedAt: now } },
      );
      return res.json({ ok: true, status: "in_progress" });
    }
    throw new HttpError(400, "Action must be approve or revise");
  });

  // ------------------------------------------------------ dashboard stats
  const sumBy = async (coll, match, field) => {
    const [row] = await coll
      .aggregate([
        { $match: match },
        { $group: { _id: null, total: { $sum: field } } },
      ])
      .toArray();
    return row?.total || 0;
  };
  const countMap = async (coll, match, key) => {
    const rows = await coll
      .aggregate([{ $match: match }, { $group: { _id: key, n: { $sum: 1 } } }])
      .toArray();
    return Object.fromEntries(rows.map((r) => [r._id ?? "open", r.n]));
  };
  const monthly = async (coll, match, dateField, valueExpr = 1) => {
    const since = new Date();
    since.setUTCMonth(since.getUTCMonth() - 5, 1);
    since.setUTCHours(0, 0, 0, 0);
    const rows = await coll
      .aggregate([
        { $match: { ...match, [dateField]: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: `$${dateField}` } },
            value: { $sum: valueExpr },
          },
        },
      ])
      .toArray();
    return fillMonths(rows);
  };

  app.get("/dashboard/stats", auth, async (req, res) => {
    const { tasks, bids, users } = req.db;
    const me = req.user.email;

    if (req.user.role === "client") {
      const mine = { email: me };
      const byStatus = await countMap(tasks, mine, "$status");
      const myIds = (await tasks.find(mine).project({ _id: 1 }).toArray()).map(
        (t) => t._id,
      );
      const [
        pendingProposals,
        spent,
        committed,
        series,
        recent,
        inReview,
        withProposals,
      ] = await Promise.all([
        bids.countDocuments({ taskId: { $in: myIds }, status: "pending" }),
        sumBy(tasks, { ...mine, status: "completed" }, "$acceptedAmount"),
        sumBy(
          tasks,
          { ...mine, status: { $in: ACTIVE_STATUSES } },
          "$acceptedAmount",
        ),
        monthly(tasks, mine, "createdAt"),
        tasks.find(mine).sort({ createdAt: -1, _id: -1 }).limit(5).toArray(),
        tasks
          .find({ ...mine, status: "in_review" })
          .limit(5)
          .toArray(),
        tasks
          .find({ ...mine, status: "open", bid: { $gt: 0 } })
          .sort({ bid: -1 })
          .limit(5)
          .toArray(),
      ]);
      return res.json({
        role: "client",
        totals: {
          tasks: myIds.length,
          open: byStatus.open || 0,
          active: (byStatus.in_progress || 0) + (byStatus.in_review || 0),
          completed: byStatus.completed || 0,
          pendingProposals,
          spent,
          committed,
        },
        byStatus,
        series: { label: "Tasks posted", data: series },
        recent: recent.map((t) => shapeTask(t, req.user)),
        attention: {
          review: inReview.map((t) => shapeTask(t, req.user)),
          proposals: withProposals.map((t) => shapeTask(t, req.user)),
        },
      });
    }

    if (req.user.role === "freelancer") {
      const mine = { freelancerEmail: me };
      const job = { "assignedTo.email": me };
      const byBid = await countMap(bids, mine, "$status");
      const [earned, pipeline, series, activeJobs, completedJobs, recentBids] =
        await Promise.all([
          sumBy(tasks, { ...job, status: "completed" }, "$acceptedAmount"),
          sumBy(
            tasks,
            { ...job, status: { $in: ACTIVE_STATUSES } },
            "$acceptedAmount",
          ),
          monthly(
            tasks,
            { ...job, status: "completed" },
            "completedAt",
            "$acceptedAmount",
          ),
          tasks
            .find({ ...job, status: { $in: ACTIVE_STATUSES } })
            .sort({ updatedAt: -1 })
            .limit(5)
            .toArray(),
          tasks.countDocuments({ ...job, status: "completed" }),
          bids.find(mine).sort({ createdAt: -1 }).limit(5).toArray(),
        ]);
      const decided = (byBid.accepted || 0) + (byBid.rejected || 0);
      const titles = await tasks
        .find({ _id: { $in: recentBids.map((b) => b.taskId) } })
        .toArray();
      const tmap = new Map(titles.map((t) => [String(t._id), t]));
      return res.json({
        role: "freelancer",
        totals: {
          earned,
          pipeline,
          proposals: Object.values(byBid).reduce((a, b) => a + b, 0),
          pending: byBid.pending || 0,
          active: activeJobs.length,
          completed: completedJobs,
          winRate: decided
            ? Math.round(((byBid.accepted || 0) / decided) * 100)
            : null,
        },
        byBid,
        series: { label: "Earnings", unit: "$", data: series },
        activeJobs: activeJobs.map((t) => shapeTask(t, req.user)),
        recentBids: recentBids.map((b) => ({
          ...b,
          task: tmap.get(String(b.taskId))
            ? {
                _id: b.taskId,
                title: tmap.get(String(b.taskId)).title,
                status: statusOf(tmap.get(String(b.taskId))),
              }
            : null,
        })),
      });
    }

    // admin
    const [
      byRole,
      byStatus,
      suspended,
      bidCount,
      volume,
      openBudget,
      signups,
      posted,
      recentUsers,
      recentTasks,
    ] = await Promise.all([
      countMap(users, {}, "$role"),
      countMap(tasks, {}, "$status"),
      users.countDocuments({ status: "suspended" }),
      bids.countDocuments({}),
      sumBy(tasks, { status: "completed" }, "$acceptedAmount"),
      sumBy(tasks, OPEN, "$budget"),
      monthly(users, {}, "createdAt"),
      monthly(tasks, {}, "createdAt"),
      users.find({}).sort({ createdAt: -1, _id: -1 }).limit(5).toArray(),
      tasks.find({}).sort({ createdAt: -1, _id: -1 }).limit(5).toArray(),
    ]);
    res.json({
      role: "admin",
      totals: {
        users: Object.values(byRole).reduce((a, b) => a + b, 0),
        clients: byRole.client || 0,
        freelancers: byRole.freelancer || 0,
        admins: byRole.admin || 0,
        suspended,
        tasks: Object.values(byStatus).reduce((a, b) => a + b, 0),
        proposals: bidCount,
        volume,
        openBudget,
      },
      byStatus,
      series: { label: "New users", data: signups },
      seriesTasks: { label: "Tasks posted", data: posted },
      recentUsers,
      recentTasks: recentTasks.map((t) => shapeTask(t, req.user)),
    });
  });

  // ------------------------------------------------------------------ admin
  app.get("/admin/users", ...needAdmin, async (req, res) => {
    const { page, limit, skip } = paginate({ limit: 10, ...req.query });
    const and = [];
    if (ROLES.includes(req.query.role)) and.push({ role: req.query.role });
    if (["active", "suspended"].includes(req.query.status))
      and.push({ status: req.query.status });
    if (req.query.q) {
      const rx = new RegExp(escapeRegex(String(req.query.q).slice(0, 80)), "i");
      and.push({ $or: [{ name: rx }, { email: rx }] });
    }
    const filter = and.length ? { $and: and } : {};
    const [items, total] = await Promise.all([
      req.db.users
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      req.db.users.countDocuments(filter),
    ]);
    res.json({
      items,
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  });

  app.patch("/admin/users/:id", ...needAdmin, async (req, res) => {
    const target = await req.db.users.findOne({
      _id: toId(req.params.id, "user id"),
    });
    if (!target) throw new HttpError(404, "User not found");
    if (String(target._id) === String(req.user._id)) {
      throw new HttpError(400, "You can't change your own role or status");
    }
    const set = {};
    if (req.body.role !== undefined) {
      if (!ROLES.includes(req.body.role))
        throw new HttpError(400, "Invalid role");
      set.role = req.body.role;
    }
    if (req.body.status !== undefined) {
      if (!["active", "suspended"].includes(req.body.status))
        throw new HttpError(400, "Invalid status");
      set.status = req.body.status;
    }
    if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update");
    await req.db.users.updateOne({ _id: target._id }, { $set: set });
    res.json({ ...target, ...set });
  });

  app.get("/admin/tasks", ...needAdmin, async (req, res) => {
    const { page, limit, skip } = paginate({ limit: 10, ...req.query });
    const q = { ...req.query };
    if (!q.status) q.status = "all";
    const filter = taskFilter(q);
    const [items, total] = await Promise.all([
      req.db.tasks
        .find(filter)
        .sort({ createdAt: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
      req.db.tasks.countDocuments(filter),
    ]);
    res.json({
      items: items.map((t) => shapeTask(t, req.user)),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  });

  // ---------------------------------------------------------------- errors
  app.use((req, _res, next) =>
    next(new HttpError(404, `Route not found: ${req.method} ${req.path}`)),
  );
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === "entity.parse.failed")
      err = new HttpError(400, "Invalid JSON body");
    const status = err.status && err.status < 600 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({
      error: status === 500 ? "Something went wrong on our side" : err.message,
      message:
        status === 500 ? "Something went wrong on our side" : err.message,
      code: err.code,
    });
  });

  return app;
}

module.exports = { createApp };