const { redis } = require("../services/redisClient");

const script = `
  local key    = KEYS[1]
  local limit  = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])

  local count = redis.call('INCR', key)

  if count == 1 then
    redis.call('EXPIRE', key, window)
  end

  return count
`;

async function fixedWindow(userId, tenantId, policy) {
  const { limit, windowSeconds } = policy;
  const windowNumber = Math.floor(Date.now() / 1000 / windowSeconds);
  const key = `rl:fixed:${tenantId}:${userId}:${windowNumber}`;

  const count = await redis.eval(script, 1, key, limit, windowSeconds);

  const remaining = Math.max(0, limit - count);
  const resetAt = (Math.floor(Date.now() / 1000 / windowSeconds) + 1) * windowSeconds;
  const retryAfter = count > limit ? resetAt - Math.floor(Date.now() / 1000) : null;

  return {
    allowed: count <= limit,
    count,
    limit,
    remaining,
    resetAt,         // unix timestamp when window resets
    retryAfter,
  };
}

module.exports = { fixedWindow };