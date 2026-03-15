// Per-tenant rate limiting policies
// In production this would be loaded from a database
// and refreshed periodically — this is the "dynamic config" part

const policies = {
  // Free tier — strict fixed window
  "free-corp": {
    algorithm: "fixedWindow",
    limit: 10,
    windowSeconds: 60,
    description: "10 requests per minute",
  },

  // Pro tier — sliding window, more generous
  "pro-corp": {
    algorithm: "slidingWindow",
    limit: 50,
    windowMs: 60000,
    description: "50 requests per minute, exact counting",
  },

  // Enterprise tier — token bucket with burst tolerance
  "enterprise-corp": {
    algorithm: "tokenBucket",
    capacity: 100,       // burst up to 100 requests
    refillRate: 10,      // refill 10 tokens per second (600/min sustained)
    description: "100 burst, 10 req/sec sustained",
  },

  // Default policy — applied when tenant is unknown
  default: {
    algorithm: "fixedWindow",
    limit: 5,
    windowSeconds: 60,
    description: "5 requests per minute (default)",
  },
};

function getPolicy(tenantId) {
  return policies[tenantId] || policies["default"];
}

module.exports = { getPolicy };