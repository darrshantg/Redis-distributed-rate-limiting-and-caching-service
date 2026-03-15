const { fixedWindow } = require("../algorithms/fixedWindow");
const { slidingWindow } = require("../algorithms/slidingWindow");
const { tokenBucket } = require("../algorithms/tokenBucket");
const { getPolicy } = require("../config/policies");
const { isRedisHealthy } = require("../services/redisClient");

// Map algorithm names to their functions
const algorithms = {
  fixedWindow,
  slidingWindow,
  tokenBucket,
};

function rateLimiter() {
    return async (req, res, next) => {
        // Extract tenant and user from headers
        // In production: parse JWT, API key, etc.
        const tenantId = req.headers["x-tenant-id"] || "unknown";
        const userId = req.headers["x-user-id"]   || req.ip;

        // Fail-open: if Redis is down, let request through
        // Change to fail-closed by returning 503 instead
        const healthy = await isRedisHealthy();
        if (!healthy) {
            console.warn("Redis unhealthy — failing open");
            res.setHeader("X-RateLimit-Status", "redis-unavailable");
            return next();
        }

        // Get the right policy for this tenant
        const policy = getPolicy(tenantId);
        const algorithm = algorithms[policy.algorithm];

        try {
            const result = await algorithm(userId, tenantId, policy)

            res.setHeader("X-RateLimit-Limit", result.limit);
            res.setHeader("X-RateLimit-Remaining", result.remaining);
            res.setHeader("X-RateLimit-Algorithm", policy.algorithm);

            if(result.resetAt) {
                res.setHeader("X-RateLimit-Reset", result.resetAt);
            }

            if (!result.allowed) {
                if (result.retryAfter) {
                    res.setHeader("Retry-After", result.retryAfter);
                }

                return res.status(429).json({
                    error: "Too Many Requests",
                    retryAfter: result.retryAfter,
                    policy: policy.description,
                });
            }

            next();
        } catch (err) {
            console.error("Rate limiter error:", err.message);
            // On unexpected error, fail-open
            next();
        }
    }
}

module.exports = { rateLimiter }