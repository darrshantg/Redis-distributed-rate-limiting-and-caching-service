const { redis } = require("./redisClient");

// Fetch multiple users from cache in one round trip
async function mgetUsers(userIds, version) {
  const pipeline = redis.pipeline();

  // Queue all GET commands — nothing sent yet
  for (const id of userIds) {
    pipeline.get(`cache:users:v${version}:${id}`);
  }

  // Send all at once — one round trip
  const results = await pipeline.exec();

  // results = [[err, value], [err, value], ...]
  return results.map(([err, value], i) => ({
    id:     userIds[i],
    data:   value ? JSON.parse(value) : null,
    source: value ? "cache" : "miss",
  }));
}

// Check rate limit AND get cache in one round trip
async function checkRateLimitAndCache(userId, tenantId, cacheKey) {
  const pipeline = redis.pipeline();
  const windowNumber = Math.floor(Date.now() / 1000 / 60);
  const rlKey = `rl:fixed:${tenantId}:${userId}:${windowNumber}`;

  pipeline.get(cacheKey);   // command 1: check cache
  pipeline.get(rlKey);      // command 2: check rate limit counter

  const [[cacheErr, cached], [rlErr, count]] = await pipeline.exec();

  return {
    cached:       cached ? JSON.parse(cached) : null,
    requestCount: count ? parseInt(count) : 0,
  };
}

// Set multiple cache entries in one round trip
// Used for pre-warming cache at startup or after bulk DB fetch
async function warmCache(entries, ttlSeconds = 60) {
  const pipeline = redis.pipeline();
  const jitter   = () => Math.floor(Math.random() * 10);

  for (const { key, data } of entries) {
    pipeline.set(key, JSON.stringify(data), "EX", ttlSeconds + jitter());
  }

  const results = await pipeline.exec();
  console.log("Pipeline results:", JSON.stringify(results));
  const failed  = results.filter(([err]) => err).length;

  console.log(`Cache warm-up: ${entries.length - failed} set, ${failed} failed`);
  return { total: entries.length, failed };
}

// Fetch cache stats in one round trip
async function getCacheStats(resource, version) {
  const pipeline = redis.pipeline();

  pipeline.get(`cache:${resource}:version`);  // current version
  pipeline.dbsize();                           // total keys in Redis
  pipeline.info("stats");                      // Redis stats string

  const [[, ver], [, dbSize], [, info]] = await pipeline.exec();

  // Parse hit/miss from INFO stats
  const hits   = info.match(/keyspace_hits:(\d+)/)?.[1]   || "0";
  const misses = info.match(/keyspace_misses:(\d+)/)?.[1] || "0";
  const total  = parseInt(hits) + parseInt(misses);
  const hitRate = total > 0
    ? ((parseInt(hits) / total) * 100).toFixed(1)
    : "0.0";

  return {
    resource,
    currentVersion: ver || "1",
    totalKeys:      dbSize,
    cacheHits:      hits,
    cacheMisses:    misses,
    hitRate:        `${hitRate}%`,
  };
}

module.exports = { mgetUsers, warmCache, getCacheStats, checkRateLimitAndCache };