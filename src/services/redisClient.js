const Redis = require("ioredis");

function createClient() {
  const isCluster = process.env.REDIS_CLUSTER === "true";

  if (isCluster) {
    console.log(`[${process.env.INSTANCE_ID}] Redis: connecting in CLUSTER mode`);

    const nodes = [
      process.env.REDIS_NODE_1,
      process.env.REDIS_NODE_2,
      process.env.REDIS_NODE_3,
    ].filter(Boolean).map(node => {
      const [host, port] = node.split(":");
      return { host, port: parseInt(port) };
    });

    const client = new Redis.Cluster(nodes, {
      redisOptions: {
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
      },
      clusterRetryStrategy(times) {
        if (times > 5) {
          console.error(`[${process.env.INSTANCE_ID}] Redis Cluster: max retries reached`);
          return null;
        }
        const delay = Math.min(times * 200, 2000);
        console.warn(`[${process.env.INSTANCE_ID}] Redis Cluster: retry in ${delay}ms (attempt ${times})`);
        return delay;
      },
      // ioredis needs this for cluster node discovery
      enableReadyCheck: true,
      scaleReads: "master",
    });

    client.on("connect", () => console.log(`[${process.env.INSTANCE_ID}] Redis Cluster: connected`));
    client.on("ready", () => console.log(`[${process.env.INSTANCE_ID}] Redis Cluster: ready`));
    client.on("error", (err) => console.error(`[${process.env.INSTANCE_ID}] Redis Cluster: error → ${err.message}`));
    client.on("reconnecting", () => console.warn(`[${process.env.INSTANCE_ID}] Redis Cluster: reconnecting`));

    return client;
  } else {
    console.log(`[${process.env.INSTANCE_ID || "local"}] Redis: connecting in SINGLE NODE mode`);

    const client = new Redis({
      host: process.env.REDIS_HOST || "localhost",
      port: process.env.REDIS_PORT || 6379,
      maxRetriesPerRequest: 3,
      connectTimeout: 5000,
      lazyConnect: true,
      retryStrategy(times) {
        if (times > 5) return null;
        return Math.min(times * 200, 2000);
      },
    });

    client.on("connect", () => console.log(`[${process.env.INSTANCE_ID || "local"}] Redis: connected`));
    client.on("ready", () => console.log(`[${process.env.INSTANCE_ID || "local"}] Redis: ready`));
    client.on("error", (err) => console.error(`[${process.env.INSTANCE_ID || "local"}] Redis: error → ${err.message}`));
    client.on("close", () => console.warn(`[${process.env.INSTANCE_ID || "local"}] Redis: connection closed`));

    return client;
  }
}

const redis = createClient();

async function isRedisHealthy() {
  try {
    await redis.ping();
    return true;
  } catch {
    return false;
  }
}

module.exports = { redis, isRedisHealthy };