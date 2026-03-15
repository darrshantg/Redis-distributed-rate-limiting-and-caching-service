const Redis = require("ioredis");
const redis = new Redis();

const slidingWindowScript = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])

  -- Remove all entries older than the window
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

  -- Count how many requests are in the current window
  local count = redis.call('ZCARD', key)

  if count < limit then
    -- Add current request with timestamp as both score and member
    redis.call('ZADD', key, now, now)
    redis.call('EXPIRE', key, window)
    return 1  -- allowed
  end

  return 0  -- blocked
`;

async function isRateLimited(userId, limit = 5, windowMs = 10000) {
  const key = `rl:sliding:${userId}`;
  const now = Date.now(); // milliseconds

  const allowed = await redis.eval(
    slidingWindowScript, 1, key, now, windowMs, limit
  );

  return allowed === 0;
}

async function simulate() {
  console.log("=== Sliding Window Demo ===\n");

  // Fire 5 requests — all should pass
  console.log("-- Sending 5 requests --");
  for (let i = 0; i < 5; i++) {
    const limited = await isRateLimited("user_123");
    console.log(limited ? "  → BLOCKED (429)\n" : "  → ALLOWED\n");
  }

  // Fire 3 more immediately — all should be blocked
  console.log("-- Sending 3 more immediately --");
  for (let i = 0; i < 3; i++) {
    const limited = await isRateLimited("user_123");
    console.log(limited ? "  → BLOCKED (429)\n" : "  → ALLOWED\n");
  }

  // Wait 11 seconds — window fully slides past all old requests
  console.log("-- Waiting 11 seconds for window to slide --");
  await new Promise(resolve => setTimeout(resolve, 11000));

  // Fire 3 more — should all pass now
  console.log("-- Sending 3 requests after wait --");
  for (let i = 0; i < 3; i++) {
    const limited = await isRateLimited("user_123");
    console.log(limited ? "  → BLOCKED (429)\n" : "  → ALLOWED\n");
  }

  redis.quit();
}

simulate();