const express = require("express");
const { rateLimiter } = require("./src/middleware/rateLimiter");
const apiRoutes = require("./src/routes/api");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Apply rate limiting to all routes
app.use(rateLimiter());

// Mount routes
app.use("/api", apiRoutes);

app.listen(PORT, () => {
  console.log(`[${process.env.INSTANCE_ID || "local"}] Server running on http://localhost:${PORT}`);
});