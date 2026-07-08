import { Router } from "express";
import { config } from "../config.js";
import {
  buildAuthorizationUrl,
  handleAuthorizationCallback,
  getAuthStatus,
  logout,
} from "../auth/oauthClient.js";

export const authRouter = Router();

authRouter.get("/login", async (req, res) => {
  const url = await buildAuthorizationUrl();
  res.redirect(url);
});

authRouter.get("/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) {
    res.redirect(
      `${config.frontendOrigin}/?auth_error=${encodeURIComponent(error_description || error)}`
    );
    return;
  }
  try {
    await handleAuthorizationCallback({ code: String(code), state: String(state) });
    res.redirect(`${config.frontendOrigin}/?authenticated=1`);
  } catch (err) {
    res.redirect(`${config.frontendOrigin}/?auth_error=${encodeURIComponent(err.message)}`);
  }
});

authRouter.get("/status", (req, res) => {
  res.json(getAuthStatus());
});

authRouter.post("/logout", async (req, res) => {
  await logout();
  res.json({ ok: true });
});
