# TaskWave: Server

REST API for **TaskWave**, a freelance marketplace where clients post tasks, freelancers send proposals, and work moves from brief to approved delivery. Built with Express 5 and MongoDB, with Firebase ID-token authentication and role-based access (**client**, **freelancer**, **admin**).

🔗 **Client repo:** https://github.com/SarfarazAkram17/TaskWave-Client
🔗 **Live client:** https://assignment-10-sarfaraz-akram.netlify.app

---

## ✨ What's new in v2

- **Image uploads** to Cloudinary using server-signed uploads (users upload a file; links are not accepted)
- Firebase **ID token verification** on every protected route (identity comes from the token, never from the request body)
- **Roles**: client, freelancer, admin, with per-route permission checks
- **Proposals** (`bids` collection) with price, delivery time and message, replacing the old "bid counter"
- **Task lifecycle**: `open → in_progress → in_review → completed` (or `cancelled`)
- **Role-based dashboard statistics** and **admin** user/task moderation
- Search, filter, sort and pagination on tasks
- Input validation, consistent JSON errors, privacy (client and bidder emails are not public)
- Automatic upgrade of v1 documents on first start, plus an automated test suite

## 🛠 Tech stack

Node.js · Express 5 · MongoDB Atlas (official driver) · jose (Firebase JWT verification) · Cloudinary (image hosting) · CORS · dotenv

## ⚙️ Configuration

Copy `.env.example` to `.env`:

| Variable                                                               | Required    | Description                                                                                                                                                      |
| ---------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB_USER`, `DB_PASS` (or `MONGODB_URI`)                                | yes         | MongoDB credentials / connection string                                                                                                                          |
| `DB_NAME`                                                              | no          | Database name (default `Assignment-10`)                                                                                                                          |
| `FIREBASE_PROJECT_ID`                                                  | **yes**     | Your Firebase project id; tokens are verified against it. Protected routes return an error if it is missing                                                      |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` | for uploads | From Cloudinary → Settings → API Keys. The secret stays on the server. Without them `POST /uploads/signature` returns `503` and profile photos can't be uploaded |
| `CLIENT_ORIGIN`                                                        | no          | Comma-separated allowed CORS origins (default: all)                                                                                                              |
| `PORT`                                                                 | no          | Local port (default `3000`)                                                                                                                                      |

On Vercel, add the same variables in the project settings.

## 🚀 Getting started

```bash
git clone https://github.com/SarfarazAkram17/TaskWave-Server.git
cd TaskWave-Server
npm install
cp .env.example .env     # fill in the values
npm start                # or: npm run dev (auto-restart)
npm test                 # run the API test suite
```

## 🖼 Image uploads (Cloudinary)

Users upload an image file; they never paste an image link.

1. The client calls `POST /uploads/signature` (logged in). The server signs `folder=taskwave/avatars&timestamp=…` with your API secret and returns `{ cloudName, apiKey, timestamp, folder, signature }`.
2. The browser uploads the file **directly to Cloudinary** with that signature (the secret is never sent to the browser).
3. The browser saves the returned `secure_url` with `PATCH /users/me` (`photo`) or `POST /users/register` (`photo`).

The server only accepts photo URLs that live in **your** Cloudinary account and the `taskwave/avatars` folder (or `""` to remove the photo). Anything else is rejected with `400`. Google sign-in avatars are used automatically as the default photo.

Setup: create a free Cloudinary account, copy the cloud name, API key and API secret into the server environment variables, and (optional) restrict uploads further in Cloudinary → Settings → Upload.

## 🔐 Authentication and roles

Send the Firebase ID token with every protected request:

```
Authorization: Bearer <firebase-id-token>
```

| Role           | Can do                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------- |
| **client**     | Create, edit, cancel and delete own tasks; view and accept/decline proposals; review deliveries                   |
| **freelancer** | Send, view and withdraw proposals; deliver work on assigned tasks                                                 |
| **admin**      | Everything a client can do on any task, plus user management and platform stats. Created manually in the database |

Roles are stored in the database (`users` collection) and read on every request, so changing a user's `role` or `status` takes effect immediately. Clients and freelancers choose their role at sign-up. **Admins can't sign up through the app**: you create the admin document by hand.

### Creating an admin

1. Sign up in the app (or log in with Google) using the email you want to make admin, so the Firebase account exists.
2. In MongoDB Atlas / Compass, open database `Assignment-10` → collection `users`. If a document for that email already exists, just edit its `role` to `"admin"`. Otherwise insert:

```json
{
  "email": "you@example.com",
  "name": "Your Name",
  "photo": "",
  "role": "admin",
  "status": "active",
  "headline": "",
  "bio": "",
  "location": "",
  "createdAt": { "$date": "2026-01-01T00:00:00Z" }
}
```

Or with `mongosh`:

```js
db.users.updateOne(
  { email: "you@example.com" },
  {
    $set: { role: "admin", status: "active" },
    $setOnInsert: {
      name: "Your Name",
      photo: "",
      headline: "",
      bio: "",
      location: "",
      createdAt: new Date(),
    },
  },
  { upsert: true },
);
```

Rules: `email` must be **lowercase** and identical to the Firebase account's email; `createdAt` must be a real **Date** (not a string) or the dashboard charts will skip it. Admins can then promote or demote other users from **Dashboard → Users**.

Suspended users receive `403 SUSPENDED` on all protected routes. Admins can't change their own role or status.

## 🔄 Task lifecycle

```
open ──accept proposal──► in_progress ──submit──► in_review ──approve──► completed
 │                              ▲                     │
 └─ cancel ► cancelled          └──── revise ◄────────┘
```

Accepting a proposal is atomic: only one proposal can move an open task to `in_progress`; the rest become `rejected`.

## 📦 API reference

Errors are JSON: `{ "error": "...", "message": "...", "code": "..." }` with a proper HTTP status.

### Health and meta

| Method | Endpoint        | Auth | Description                              |
| ------ | --------------- | ---- | ---------------------------------------- |
| GET    | `/`             | none | Health check                             |
| GET    | `/meta`         | none | Categories, roles, task statuses         |
| GET    | `/stats/public` | none | Open tasks, freelancers, completed tasks |

### Users

| Method | Endpoint             | Auth     | Description                                                                          |
| ------ | -------------------- | -------- | ------------------------------------------------------------------------------------ |
| GET    | `/users/me`          | token    | Current profile (`404 NO_PROFILE` until registered)                                  |
| POST   | `/users/register`    | token    | Create profile `{ role: "client"\|"freelancer", name?, photo? }` (idempotent)        |
| PATCH  | `/users/me`          | any role | Update `name`, `photo` (Cloudinary image URL or `""`), `headline`, `bio`, `location` |
| POST   | `/uploads/signature` | token    | Signed parameters for a direct-to-Cloudinary image upload                            |

### Tasks

| Method | Endpoint            | Auth          | Description                                                                                                                                                                                                                      |
| ------ | ------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/tasks`            | optional      | List with `q`, `category`, `status` (default `open`, or `all`), `minBudget`, `maxBudget`, `sort` (`newest`, `deadline`, `budgetHigh`, `budgetLow`, `proposals`), `page`, `limit`. Returns `{ items, total, page, pages, limit }` |
| GET    | `/featuredTasks`    | none          | 6 open tasks with the nearest deadlines                                                                                                                                                                                          |
| GET    | `/tasks/:id`        | optional      | Task details. Owner, assignee and admin also see private fields; freelancers get their own proposal as `myBid`                                                                                                                   |
| GET    | `/tasks/mine`       | client        | Own tasks with pending-proposal counts                                                                                                                                                                                           |
| GET    | `/jobs/mine`        | freelancer    | Tasks assigned to me                                                                                                                                                                                                             |
| POST   | `/tasks`            | client, admin | Create a task (`title`, `category`, `budget`, `deadline`, `description`)                                                                                                                                                         |
| PUT    | `/tasks/:id`        | owner, admin  | Partial update (open tasks only for non-admins)                                                                                                                                                                                  |
| POST   | `/tasks/:id/cancel` | owner, admin  | Cancel (owner: open only; admin: also in progress / in review)                                                                                                                                                                   |
| DELETE | `/tasks/:id`        | owner, admin  | Delete task and its proposals (not while in progress / in review, except admin)                                                                                                                                                  |

### Proposals

| Method | Endpoint           | Auth         | Description                                                                                |
| ------ | ------------------ | ------------ | ------------------------------------------------------------------------------------------ |
| POST   | `/tasks/:id/bids`  | freelancer   | Send `{ amount, deliveryDays, message }`. One per task, not on own task, task must be open |
| GET    | `/tasks/:id/bids`  | owner, admin | All proposals for the task                                                                 |
| GET    | `/bids/mine`       | freelancer   | My proposals with task summary                                                             |
| DELETE | `/bids/:id`        | freelancer   | Withdraw a pending proposal                                                                |
| POST   | `/bids/:id/accept` | owner, admin | Accept: task → `in_progress`, others rejected                                              |
| POST   | `/bids/:id/reject` | owner, admin | Decline a pending proposal                                                                 |

### Delivery and review

| Method | Endpoint            | Auth                | Description                                                                                |
| ------ | ------------------- | ------------------- | ------------------------------------------------------------------------------------------ |
| POST   | `/tasks/:id/submit` | assigned freelancer | `{ note, link? }`: task → `in_review`                                                      |
| POST   | `/tasks/:id/review` | owner, admin        | `{ action: "approve" }` → `completed`, or `{ action: "revise", feedback }` → `in_progress` |

### Dashboards and admin

| Method | Endpoint           | Auth     | Description                                                           |
| ------ | ------------------ | -------- | --------------------------------------------------------------------- |
| GET    | `/dashboard/stats` | any role | Statistics shaped for the caller's role (client / freelancer / admin) |
| GET    | `/admin/users`     | admin    | `q`, `role`, `status`, `page`, `limit`                                |
| PATCH  | `/admin/users/:id` | admin    | Change `role` and/or `status` (`active`, `suspended`)                 |
| GET    | `/admin/tasks`     | admin    | All tasks with `q`, `status`, `page`, `limit`                         |

## 🗄 Data model

- **users**: `email` (unique), `name`, `photo`, `role`, `status`, `headline`, `bio`, `location`, `createdAt`
- **taskCollection**: `title`, `category`, `budget` (number), `deadline` (`YYYY-MM-DD`), `description`, `email` / `name` (owner), `status`, `bid` (proposal count), `assignedTo`, `acceptedBidId`, `acceptedAmount`, `submission`, `feedback`, `createdAt`, `updatedAt`, `completedAt`
- **bids**: `taskId`, `freelancerEmail`, `amount`, `deliveryDays`, `message`, `status` (`pending`, `accepted`, `rejected`, `withdrawn`), `createdAt`. Unique per (`taskId`, `freelancerEmail`)

## ⬆️ Upgrading from v1

On first start the server creates indexes and upgrades old documents automatically: string budgets become numbers, tasks without a status become `open`, and missing counters are added. Notes:

- Old PATCH `/tasks/:id` "bid counter" is replaced by `POST /tasks/:id/bids`. Previous bids exist only as a count, not as proposals.
- `GET /tasks` now returns a paginated object, not an array, and `/tasks/email/:email` is replaced by `/tasks/mine`.
- Set `FIREBASE_PROJECT_ID` and the three `CLOUDINARY_*` variables before deploying, create your admin document (see "Creating an admin"), and use the v2 client.

## ✅ Tests

`npm test` runs an end-to-end suite against an in-memory database and a stubbed token verifier. It covers registration and roles (including database-created admins), signed Cloudinary uploads and own-host-only photos, validation, privacy, the full proposal → accept → deliver → revise → approve flow, dashboards, admin moderation, and real RS256 JWT verification (valid, wrong audience, wrong issuer, missing email, garbage).