import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// ------ Custom metrics ---------------------------
const rateLimitedRequests = new Counter("rate_limited_requests");
const allowedRequests     = new Counter("allowed_requests");
const errorRate           = new Rate("error_rate");
const responseTime        = new Trend("response_time");

// ------ Test configuration ---------------------------
export const options = {
  scenarios: {

    // Scenario 1: Gradual ramp up
    ramp_up: {
      executor:    "ramping-vus",
      startVUs:    0,
      stages: [
        { duration: "30s", target: 50  },  // ramp to 50 users
        { duration: "60s", target: 100 },  // ramp to 100 users
        { duration: "30s", target: 0   },  // ramp down
      ],
      gracefulRampDown: "10s",
    },

  },
  thresholds: {
    // 95% of requests must complete within 500ms
    http_req_duration: ["p(95)<500"],
    // Error rate must stay below 5% (429s don't count as errors)
    error_rate: ["rate<0.05"],
  },
};

const BASE_URL = "http://redis-ratelimiter-alb-972013051.ap-south-1.elb.amazonaws.com";

const TENANTS = ["free-corp", "pro-corp", "enterprise-corp"];

export default function () {
  // Pick a random tenant and user
  const tenant = TENANTS[Math.floor(Math.random() * TENANTS.length)];
  const userId = `user_${Math.floor(Math.random() * 100)}`;

  const params = {
    headers: {
      "x-tenant-id": tenant,
      "x-user-id":   userId,
    },
  };

  // ------ Test 1: Basic rate limiting ---------------------------
  const res = http.get(`${BASE_URL}/api/data`, params);
  responseTime.add(res.timings.duration);

  const isAllowed      = res.status === 200;
  const isRateLimited  = res.status === 429;
  const isError        = res.status !== 200 && res.status !== 429;

  check(res, {
    "status is 200 or 429":         (r) => r.status === 200 || r.status === 429,
    "has X-RateLimit-Algorithm":    (r) => r.headers["X-Ratelimit-Algorithm"] !== undefined,
    "has X-RateLimit-Remaining":    (r) => r.headers["X-Ratelimit-Remaining"] !== undefined,
    "response time < 500ms":        (r) => r.timings.duration < 500,
  });

  if (isAllowed)     allowedRequests.add(1);
  if (isRateLimited) rateLimitedRequests.add(1);
  if (isError)       errorRate.add(1);

  // ------ Test 2: Cache performance ---------------------------
  const userId1 = "user_1";
  const cacheRes = http.get(`${BASE_URL}/api/users/${userId1}`, params);

  check(cacheRes, {
    "cache endpoint returns 200 or 404": (r) => r.status === 200 || r.status === 404 || r.status === 429,
    "cache response time < 200ms":       (r) => r.timings.duration < 200,
  });

  sleep(0.1);  // 100ms between requests per VU
}

export function handleSummary(data) {
  const allowed      = data.metrics.allowed_requests?.values?.count     || 0;
  const rateLimited  = data.metrics.rate_limited_requests?.values?.count || 0;
  const total        = allowed + rateLimited;
  const limitedPct   = total > 0 ? ((rateLimited / total) * 100).toFixed(1) : 0;

  console.log("\n════════════════════════════════════════");
  console.log("         STRESS TEST SUMMARY");
  console.log("════════════════════════════════════════");
  console.log(`Total requests:      ${total}`);
  console.log(`Allowed (200):       ${allowed}`);
  console.log(`Rate limited (429):  ${rateLimited} (${limitedPct}%)`);
  console.log(`p50 latency:         ${data.metrics.http_req_duration?.values?.["p(50)"]?.toFixed(0)}ms`);
  console.log(`p95 latency:         ${data.metrics.http_req_duration?.values?.["p(95)"]?.toFixed(0)}ms`);
  console.log(`p99 latency:         ${data.metrics.http_req_duration?.values?.["p(99)"]?.toFixed(0)}ms`);
  console.log("════════════════════════════════════════\n");

  return {};
}