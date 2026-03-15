const Redis = require("ioredis");
const redis = new Redis(); // connects to localhost:6379 by default

const rateLimitScript = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window = tonumber(ARGV[2])

    local count = redis.call('INCR', key)

    if count == 1 then
        redis.call('EXPIRE', key, window)
    end

    return count
`

async function isRateLimited(userId, limit = 5, windowSeconds = 10) {
  const key = `rl:${userId}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;

  const count = await redis.eval(rateLimitScript, 1, key, limit, windowSeconds);

  console.log(`User: ${userId} | Count: ${count}/${limit} | Key: ${key}`);

  if (count > limit) {
    return true; // rate limited
  }
  return false; // allowed
}

// Simulate 8 rapid requests from the same user
async function simulate() {
  console.log("--- End of window 1 ---");
  for (let i = 0; i < 5; i++) {
    const limited = await isRateLimited("user_123", 5, 10);
    console.log(limited ? "  → BLOCKED (429)\n" : "  → ALLOWED\n");
  }

  // Force move to next window by changing the key manually
  console.log("--- Start of window 2 ---");
  const nextWindow = Math.floor(Date.now() / 1000 / 10) + 1;
  const key = `rl:user_123:${nextWindow}`;
  
  for (let i = 0; i < 5; i++) {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 10);
    console.log(`Count: ${count}/5`);
    console.log(count > 5 ? "  → BLOCKED (429)\n" : "  → ALLOWED\n");
  }

  redis.quit();
}

simulate();