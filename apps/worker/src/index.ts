import { assertDevAuthAllowed, parseAuthEnv } from "@open-split/auth";
import { plannedHttpRoutes } from "@open-split/contracts";
import { Hono } from "hono";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  try {
    assertDevAuthAllowed(
      parseAuthEnv({
        environment: c.env.ENVIRONMENT,
        authDevIdentities: c.env.AUTH_DEV_IDENTITIES,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ message: "dev auth refused", error: message }));
    return c.json({ error: "dev_auth_refused", detail: message }, 500);
  }
  return next();
});

app.get("/health", (c) => {
  console.log(JSON.stringify({ message: "health", path: "/health" }));
  return c.json({ ok: true, service: "open-split" });
});

app.all("/api/*", (c) => {
  console.log(JSON.stringify({ message: "not_implemented", path: c.req.path }));
  return c.json(
    {
      error: "not_implemented",
      detail: "HTTP ledger routes start at vertical slice 1. See docs/04-vertical-slices.md.",
      routes: plannedHttpRoutes,
    },
    501,
  );
});

export default app;
