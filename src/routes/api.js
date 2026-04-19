const express = require("express");
const router = express.Router();
const { Pool } = require("pg")
const { cacheAside, writeThrough, invalidateAll } = require('../services/cache')
const { mgetUsers, warmCache, getCacheStats } = require("../services/pipeline");

// ---- PostgreSQL connection -----
const pool = new Pool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT     || 5432,
  database: process.env.DB_NAME     || "ratelimiter",
  user:     process.env.DB_USER     || "postgres",
  password: process.env.DB_PASSWORD,
  max:      10,          // connection pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});


// ---- DB Helper ----
const db = {
  async get(id) {
    const result = await pool.query(
      "SELECT id, name, role FROM users WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  },

  async save(id, data) {
    const result = await pool.query(
      `INSERT INTO users (id, name, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE
       SET name = $2, role = $3
       RETURNING *`,
      [id, data.name, data.role]
    );
    return result.rows[0];
  }
};


// ---- Cache-Aside: GET user -----------------------------
router.get("/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await cacheAside(
      "users",                          // resource name
      id,                               // resource id
      () => db.get(id),             // how to fetch from DB on miss
      30                                // TTL in seconds
    );

    if (!result.data) {
      return res.status(404).json({ error: "User not found" });
    }

    // Tell client where data came from
    res.setHeader("X-Cache", result.source === "cache" ? "HIT" : "MISS");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---- Write-Through: UPDATE user ----------------------------
router.put("/users/:id", async (req, res) => {
  const { id }  = req.params;
  const updates = req.body;

  try {
    const result = await writeThrough(
      "users",                              // resource name
      id,                                   // resource id
      updates,                              // data to write
      (data) => db.save(id, data),      // how to write to DB
      30                                    // TTL in seconds
    );

    res.setHeader("X-Cache", "WRITE");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---- Invalidate all users cache (e.g. after bulk update) -------
router.delete("/users/cache", async (req, res) => {
  try {
    await invalidateAll("users");
    res.json({ message: "User cache invalidated" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ---- Batch fetch multiple users (pipeline) --------------------
router.get("/users", async (req, res) => {
  const ids = ["user_1", "user_2", "user_3"];
  const version = await require("../services/cache").getVersion("users");

  // Check which users are in cache — ONE round trip for all
  const results = await mgetUsers(ids, version);

  // For misses, fetch from DB and populate cache
  const pipeline = require("../services/redisClient").redis.pipeline();
  const misses = results.filter(r => !r.data);

  for (const miss of misses) {
    const data = await db.get(miss.id);
    if (data) {
      const key = `cache:users:v${version}:${miss.id}`;
      const jitter = Math.floor(Math.random() * 10);
      pipeline.set(key, JSON.stringify(data), "EX", 30 + jitter);
      miss.data = data;
      miss.source = "db";
    }
  }

  // Write all misses back to cache in one round trip
  if (misses.length > 0) await pipeline.exec();

  res.setHeader("X-Pipeline", `${ids.length} keys, ${misses.length} misses`);
  res.json(results);
});

// ---- Cache stats (pipeline) -------------------------------------
router.get("/cache/stats", async (req, res) => {
  const stats = await getCacheStats("users", 1);
  res.json(stats);
});

// ---- Warm up cache for all users --------------------------------
router.post("/cache/warm", async (req, res) => {
  const version = await require("../services/cache").getVersion("users");
  const ids     = ["user_1", "user_2", "user_3"];

  // Fetch all from DB
  const entries = [];
  for (const id of ids) {
    const data = await db.get(id);
    if (data) {
      entries.push({ key: `cache:users:v${version}:${id}`, data });
    }
  }

  // Write all to cache in one pipeline — one round trip
  const result = await warmCache(entries, 30);
  res.json({ message: "Cache warmed", ...result });
});


// Dummy routes to test rate limiting against
router.get("/data", (req, res) => {
  res.json({
    message: "Here is your data",
    tenant: req.headers["x-tenant-id"],
    user: req.headers["x-user-id"],
    time: new Date().toISOString(),
  });
});

router.post("/submit", (req, res) => {
  res.json({
    message: "Submission accepted",
    body: req.body,
  });
});

router.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

module.exports = router;