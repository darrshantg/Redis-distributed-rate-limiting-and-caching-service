const { redis } = require("./redisClient");

// ---- Key helpers -----------------------------------------

// Versioned key — bump version to invalidate all cache for a resource
// e.g. cache:users:v3:user_123
function cacheKey(resource, id, version = 1) {
  return `cache:${resource}:v${version}:${id}`;
}

// Version key — stores current version number for a resource type
function versionKey(resource) {
  return `cache:${resource}:version`;
}


// ---- Version Management ------------------------------------

// Get current version for a resource type
async function getVersion(resource) {
  const v = await redis.get(versionKey(resource));
  return v ? parseInt(v) : 1;
}

// Bump version — instantly invalidates ALL cached entries for this resource
// Old versioned keys become orphans, expire via their TTL
async function bumpVersion(resource) {
  const newVersion = await redis.incr(versionKey(resource));
  console.log(`Cache: version bumped for '${resource}' → v${newVersion}`);
  return newVersion;
}


// ---- Cache-Aside ----------------------------------------
// Read pattern:
//   1. Check cache
//   2. On miss → fetch from DB
//   3. Store in cache
//   4. Return data

async function cacheAside(resource, id, fetchFromDb, ttlSeconds = 60) {
  const version = await getVersion(resource);
  const key     = cacheKey(resource, id, version);

  // Step 1: Check cache
  const cached = await redis.get(key);
  if (cached) {
    console.log(`Cache HIT  → ${key}`);
    return { data: JSON.parse(cached), source: "cache" };
  }

  console.log(`Cache MISS → ${key}`);

  // Step 2: Acquire lock to prevent stampede
  // Only one request rebuilds the cache, others wait
  const lockKey = `lock:${key}`;
  const lockVal = `${Date.now()}`; // unique value per request
  const locked = await redis.set(lockKey, lockVal, "EX", 5, "NX");

  if (!locked) {
    // Another request is already rebuilding — wait briefly and retry from cache
    console.log(`Cache LOCK miss → waiting for rebuild of ${key}`);
    await new Promise(r => setTimeout(r, 100));
    const retried = await redis.get(key);
    if (retried) {
      return { data: JSON.parse(retried), source: "cache" };
    }
  }

  try {
    // Step 3: Fetch from DB
    const data = await fetchFromDb();

    // Step 4: Store in cache with TTL jitter (prevents mass expiry at same time)
    const jitter = Math.floor(Math.random() * 10);
    const effectiveTtl = ttlSeconds + jitter;
    await redis.set(key, JSON.stringify(data), "EX", effectiveTtl);

    console.log(`Cache SET  → ${key} (TTL: ${effectiveTtl}s)`);
    return { data, source: "db" };
  } finally {
    // Release lock only if we still own it (Lua for atomicity)
    const releaseLock = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      else
        return 0
      end
    `;
    await redis.eval(releaseLock, 1, lockKey, lockVal);
  }
}


// ---- Write-Through ------------------------------------------
// Write pattern:
//   1. Write to DB
//   2. Write to cache simultaneously
//   Both succeed or cache is invalidated

async function writeThrough(resource, id, data, writeToDb, ttlSeconds = 60) {
  const version = await getVersion(resource);
  const key     = cacheKey(resource, id, version);

  // Step 1: Write to DB first
  const saved = await writeToDb(data);

  // Step 2: Write to cache
  const jitter = Math.floor(Math.random() * 10);
  await redis.set(key, JSON.stringify(saved), "EX", ttlSeconds + jitter);

  console.log(`Cache WRITE-THROUGH → ${key}`);
  return { data: saved, source: "db" };
}


// ---- Cache Invalidation --------------------------------------

// Invalidate a specific entry
async function invalidate(resource, id) {
  const version = await getVersion(resource);
  const key     = cacheKey(resource, id, version);
  await redis.del(key);
  console.log(`Cache INVALIDATED → ${key}`);
}

// Invalidate ALL entries for a resource by bumping version
// Old keys become unreachable — they'll expire via their TTL naturally
async function invalidateAll(resource) {
  await bumpVersion(resource);
  console.log(`Cache ALL INVALIDATED → resource: ${resource}`);
}


module.exports = {
  cacheAside,
  writeThrough,
  invalidate,
  invalidateAll,
  cacheKey,
  getVersion,
};