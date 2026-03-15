const Redis = require("ioredis");
const redis = new Redis();

const tokenBucketScript = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local capacity = tonumber(ARGV[2])
  local refill_rate = tonumber(ARGV[3])  -- tokens per second

  -- Get current state
  local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
  local tokens = tonumber(bucket[1])
  local last_refill = tonumber(bucket[2])

  -- First request ever for this user
  if tokens == nil then
    tokens = capacity
    last_refill = now
  end

  -- Calculate how many tokens to add since last request
  local elapsed = now - last_refill
  local refill_amount = elapsed * refill_rate
  tokens = math.min(capacity, tokens + refill_amount)

  -- Check if request can be served
  if tokens >= 1 then
    tokens = tokens - 1
    redis.call('HSET', key, 'tokens', tokens, 'last_refill', now)
    redis.call('EXPIRE', key, 3600)
    return 1  -- allowed
  end

  -- Not enough tokens, still update last_refill and tokens
  redis.call('HSET', key, 'tokens', tokens, 'last_refill', now)
  redis.call('EXPIRE', key, 3600)
  return 0  -- blocked
`;

async function isRateLimited(userId, capacity = 5, refillRate = 0.5) {
  // refillRate = 0.5 means 1 token every 2 seconds
  const key = `rl:tokenbucket:${userId}`;
  const now = Date.now() / 1000; // seconds with decimals

  const allowed = await redis.eval(
    tokenBucketScript, 1, key, now, capacity, refillRate
  );

  // Show current bucket state
  const state = await redis.hgetall(key);
  console.log(`Tokens remaining: ${parseFloat(state.tokens).toFixed(2)}`);

  return allowed === 0;
}

async function simulate() {
  console.log("=== Token Bucket Demo ===\n");

  // Burst: fire 7 requests immediately
  console.log("-- Burst: 7 requests immediately (capacity = 5) --");
  for (let i = 0; i < 7; i++) {
    const limited = await isRateLimited("user_123");
    console.log(limited ? "  → BLOCKED (429)\n" : "  → ALLOWED\n");
  }

  // Wait 4 seconds — at 0.5 tokens/sec, should refill 2 tokens
  console.log("-- Waiting 4 seconds (refill rate = 0.5/sec, expect ~2 tokens) --");
  await new Promise(resolve => setTimeout(resolve, 4000));

  // Try 3 requests — only 2 should pass
  console.log("-- Sending 3 requests after wait --");
  for (let i = 0; i < 3; i++) {
    const limited = await isRateLimited("user_123");
    console.log(limited ? "  → BLOCKED (429)\n" : "  → ALLOWED\n");
  }

  redis.quit();
}

simulate();