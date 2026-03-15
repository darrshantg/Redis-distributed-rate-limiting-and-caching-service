const { redis } = require("../services/redisClient");

const script = `
  local key         = KEYS[1]
  local now         = tonumber(ARGV[1])
  local capacity    = tonumber(ARGV[2])
  local refill_rate = tonumber(ARGV[3])

  local bucket      = redis.call('HMGET', key, 'tokens', 'last_refill')
  local tokens      = tonumber(bucket[1])
  local last_refill = tonumber(bucket[2])

  if tokens == nil then
    tokens = capacity
    last_refill = now
  end

  local elapsed = now - last_refill
  local refill_amount = elapsed * refill_rate
  tokens = math.min(capacity, tokens + refill_amount)

  if tokens >= 1 then
    tokens = tokens - 1
    redis.call('HSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, 3600)
    return {1, tokens}   -- allowed, tokens remaining
  end

  redis.call('HSET', key, 'tokens', tokens, 'last_refill', now)
  redis.call('EXPIRE', key, 3600)
  return {0, tokens}     -- blocked, tokens remaining
`;

async function tokenBucket(userId, tenantId, policy) {
  const { capacity, refillRate } = policy;
  const now = Date.now() / 1000;
  const key = `rl:bucket:${tenantId}:${userId}`;

  const [allowed, tokens] = await redis.eval(
    script, 1, key, now, capacity, refillRate
  );

  const retryAfter = allowed === 0 ? Math.ceil(1 / refillRate) : null;

  return {
    allowed: allowed === 1,
    tokens: parseFloat(tokens).toFixed(2),
    limit: capacity,
    remaining: Math.floor(tokens),
    resetAt: null,         // token bucket doesn't have a fixed reset time
    retryAfter,
  };
}

module.exports = { tokenBucket };