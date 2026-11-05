const { ObjectId } = require("mongodb");

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const toId = (value, label = "id") => {
  if (!ObjectId.isValid(value) || String(value).length !== 24) {
    throw new HttpError(400, `Invalid ${label}`);
  }
  return new ObjectId(String(value));
};

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const clampInt = (value, min, max, fallback) => {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const str = (value, { min = 0, max = 500, label = "Field" } = {}) => {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length < min) throw new HttpError(400, `${label} must be at least ${min} characters`);
  if (v.length > max) throw new HttpError(400, `${label} must be at most ${max} characters`);
  return v;
};

const money = (value, label = "Amount") => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) {
    throw new HttpError(400, `${label} must be a positive number`);
  }
  return Math.round(n * 100) / 100;
};

const isoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const todayISO = () => new Date().toISOString().slice(0, 10);

const paginate = (query) => {
  const page = clampInt(query.page, 1, 100000, 1);
  const limit = clampInt(query.limit, 1, 50, 9);
  return { page, limit, skip: (page - 1) * limit };
};

const lastMonths = (n = 6) => {
  const out = [];
  const d = new Date();
  d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push({
      key: `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`,
      label: x.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
    });
  }
  return out;
};

const fillMonths = (rows, valueKey = "value") => {
  const map = new Map(rows.map((r) => [r._id, r[valueKey] || 0]));
  return lastMonths().map((m) => ({ month: m.label, key: m.key, value: map.get(m.key) || 0 }));
};

module.exports = {
  HttpError, toId, escapeRegex, clampInt, str, money, isoDate, todayISO, paginate, fillMonths,
};
