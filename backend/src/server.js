import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { authRouter } from "./routes/auth.js";
import { foodRouter } from "./routes/food.js";
import { instamartRouter } from "./routes/instamart.js";
import { NeedsReauthError } from "./auth/oauthClient.js";
import { SwiggyToolError } from "./mcp/mcpClient.js";
import { startUsualsScheduler } from "./scheduler.js";

const app = express();
app.use(cors({ origin: config.frontendOrigin, credentials: true }));
app.use(express.json());

app.use("/auth", authRouter);
app.use("/api/food", foodRouter);
app.use("/api/instamart", instamartRouter);

app.get("/health", (req, res) => res.json({ ok: true }));

// Central error handler. Every route above is async and Express 5 forwards
// rejected promises here automatically.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof NeedsReauthError) {
    res.status(401).json({
      error: "NEEDS_REAUTH",
      message: err.message,
      loginUrl: "/auth/login",
    });
    return;
  }

  // Swiggy access tokens have no refresh token in v1 — any 401 bubbling up
  // from a live tool call means the same thing: re-run the OAuth flow.
  if (err instanceof SwiggyToolError && /401|unauthorized|token.?expired/i.test(err.message)) {
    res.status(401).json({
      error: "NEEDS_REAUTH",
      message: "Swiggy session expired — please re-authenticate.",
      loginUrl: "/auth/login",
    });
    return;
  }

  if (err instanceof SwiggyToolError) {
    res.status(502).json({ error: "SWIGGY_TOOL_ERROR", message: err.message, tool: err.tool });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "INTERNAL_ERROR", message: err.message });
});

// Bind to loopback ONLY (127.0.0.1), not the default all-interfaces (0.0.0.0).
// This backend holds the live Swiggy OAuth token and exposes unauthenticated
// endpoints that add to the cart and place real orders (food /order, and
// checkout via the Instamart chat). With a 0.0.0.0 bind, any device on the
// same Wi-Fi/LAN could reach http://<your-ip>:8787 and drive your Swiggy
// account. Loopback binding makes the server reachable only from this machine
// (which is all the Vite dev proxy — http://localhost:8787 — needs). This is
// the single most important line for "no one else can touch my account."
app.listen(config.port, "127.0.0.1", () => {
  console.log(`Swiggy dashboard backend listening on http://127.0.0.1:${config.port}`);
  startUsualsScheduler();
});
