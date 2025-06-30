# TaskWave Server

Backend API for **TaskWave**, a dynamic courier task management platform.  
This server handles all task-related operations, including task creation, updates, bidding logic, and user-specific task retrieval.

---

## 🌟 Features

- **Task CRUD:** Create, read, update, and delete tasks with MongoDB.
- **Bidding System:** Users can place bids on tasks with safeguards to prevent self-bidding and duplicate bids.
- **User-Specific Queries:** Retrieve tasks by user email.
- **Featured Tasks:** Fetch a list of top upcoming tasks sorted by deadline.
- **Robust API:** Clean RESTful routes with proper validation and error handling.

---

## 🔗 Related Links

- **Client Repository:** [https://github.com/SarfarazAkram17/TaskWave-Client](https://github.com/SarfarazAkram17/TaskWave-Client)
- **Live Client Site:** [https://assignment-10-sarfaraz-akram.netlify.app](https://assignment-10-sarfaraz-akram.netlify.app)

---

## 🛠 Tech Stack

| Technology    | Purpose                         |
| ------------- | ------------------------------- |
| Node.js       | Runtime environment             |
| Express.js    | API server framework            |
| MongoDB Atlas | Cloud NoSQL database            |
| dotenv        | Environment variable management |
| CORS          | Cross-Origin Resource Sharing   |

---

## 📦 API Endpoints

### Task Management

| Method | Endpoint     | Description                          |
| ------ | ------------ | ------------------------------------ |
| GET    | `/tasks`     | Retrieve all tasks                   |
| GET    | `/tasks/:id` | Get a task by ID                     |
| POST   | `/tasks`     | Create a new task                    |
| PUT    | `/tasks/:id` | Update a task (or create if missing) |
| DELETE | `/tasks/:id` | Delete a task                        |

### Bidding System

| Method | Endpoint     | Description           |
| ------ | ------------ | --------------------- |
| PATCH  | `/tasks/:id` | Place a bid on a task |

- **Request body** must contain `{ "email": "user@example.com" }`
- Prevents users from bidding on their own tasks
- Prevents multiple bids by the same user on a task

### Featured Tasks

| Method | Endpoint         | Description                               |
| ------ | ---------------- | ----------------------------------------- |
| GET    | `/featuredTasks` | Retrieve top 6 tasks by earliest deadline |

### User-Specific Tasks

| Method | Endpoint              | Description                    |
| ------ | --------------------- | ------------------------------ |
| GET    | `/tasks/email/:email` | Get all tasks posted by a user |

# 🛠️ Getting Started

git clone https://github.com/SarfarazAkram17/TaskWave-Server.git <br />
cd TaskWave-Server
