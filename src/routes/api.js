const express = require("express");
const router = express.Router();
const { cacheAside, writeThrough, invalidateAll } = require('../services/cache')
const { mgetUsers, warmCache, getCacheStats } = require("../services/pipeline");

// ---- Fake database ----------------------------------
// Simulates a slow DB with a 200ms delay
const fakeDb = {
  users: {
    user_1: { id: "user_1", name: "Alice",   role: "admin" },
    user_2: { id: "user_2", name: "Bob",     role: "user"  },
    user_3: { id: "user_3", name: "Charlie", role: "user"  },
  },

  async get(id) {
    await new Promise(r => setTimeout(r, 200)); // simulate DB latency
    return this.users[id] || null;
  },

  async save(id, data) {
    await new Promise(r => setTimeout(r, 200));
    this.users[id] = { id, ...data };
    return this.users[id];
  }
};


// ---- Cache-Aside: GET user -----------------------------
router.get("/users/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const result = await cacheAside(
      "users",                          // resource name
      id,                               // resource id
      () => fakeDb.get(id),             // how to fetch from DB on miss
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
      (data) => fakeDb.save(id, data),      // how to write to DB
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
    const data = await fakeDb.get(miss.id);
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
    const data = await fakeDb.get(id);
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