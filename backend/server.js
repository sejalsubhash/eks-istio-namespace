const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const port = Number(process.env.PORT || 3000);

const dbConfig = {
  host: process.env.DB_HOST || "mysql-service",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || "appuser",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || "appdb",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
};

const pool = mysql.createPool(dbConfig);

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    res.status(503).json({ status: "not-ready", database: "unavailable" });
  }
});

app.get("/api", (_req, res) => {
  res.json({ message: "Hello from the backend!", database: dbConfig.host });
});

app.get("/api/users", async (_req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, name, email FROM users ORDER BY id"
    );
    res.json(rows);
  } catch (err) {
    console.error("GET /api/users failed:", err.message);
    res.status(500).json({ error: "Unable to retrieve users" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`Backend listening on port ${port}`);
});
