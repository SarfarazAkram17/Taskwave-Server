const CATEGORIES = [
  "Web Development",
  "Graphic Design",
  "Content Writing",
  "Digital Marketing",
  "Mobile App Development",
  "Video Editing",
  "SEO Optimization",
  "Virtual Assistance",
  "UI/UX Design",
  "Data Entry",
];

const ROLES = ["client", "freelancer", "admin"];
const SELF_SERVICE_ROLES = ["client", "freelancer"];

// open -> in_progress -> in_review -> completed   (cancelled from open / by admin)
const TASK_STATUSES = ["open", "in_progress", "in_review", "completed", "cancelled"];
const BID_STATUSES = ["pending", "accepted", "rejected", "withdrawn"];

module.exports = { CATEGORIES, ROLES, SELF_SERVICE_ROLES, TASK_STATUSES, BID_STATUSES };
