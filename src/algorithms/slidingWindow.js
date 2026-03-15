const { redis } = require("../services/redisClient");

const script = `
  local key    = KEYS[1]
  local now    = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit  = tonumber(ARGV[3])

  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

  local count = redis.call('ZCARD', key)

  if count < limit then
    redis.call('ZADD', key, now, now)
    redis.call('EXPIRE', key, math.ceil(window / 1000))
    return {1, count + 1}   -- allowed, new count
  end

  -- Get the oldest entry's timestamp
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local oldest_ts = tonumber(oldest[2])

  return {0, count, oldest_ts}         -- blocked, current count
`;

async function slidingWindow(userId, tenantId, policy) {
  const { limit, windowMs } = policy;
  const now = Date.now();
  const key = `rl:sliding:${tenantId}:${userId}`;

  const [allowed, count, oldestTs] = await redis.eval(
    script, 1, key, now, windowMs, limit
  );

  const remaining = Math.max(0, limit - count);

  // retryAfter = how long until oldest entry falls off the window
  // oldest entry expires at: oldestTs + windowMs
  // user needs to wait:       (oldestTs + windowMs) - now
  const retryAfter = allowed === 0 ? Math.ceil((oldestTs + windowMs - now) / 1000) : null;

  return {
    allowed: allowed === 1,
    count,
    limit,
    remaining,
    resetAt: null,  //doesn't have a fixed reset time
    retryAfter,
  };
}

module.exports = { slidingWindow };