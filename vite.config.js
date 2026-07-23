import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";

const OVERRIDES_PATH = path.resolve(process.cwd(), "public", "config", "modelScaleOverrides.json");

function readOverridesFile() {
  if (!fs.existsSync(OVERRIDES_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(OVERRIDES_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * Dev-only API used by /calibrate.html to save the per-background,
 * per-model scale values the user has picked. Writes/merges into
 * public/config/modelScaleOverrides.json, which the real pipeline
 * (src/main.js) reads at generation time.
 *
 * Only active under `npm run dev` (Vite dev server). `npm run generate`
 * uses `vite preview`, which just serves the static file that was already
 * saved here, so nothing at generation time depends on this plugin.
 */
function scaleOverridesApiPlugin() {
  return {
    name: "scale-overrides-api",
    configureServer(server) {
      server.middlewares.use("/api/scale-overrides", async (req, res) => {
        if (req.method === "GET") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(readOverridesFile()));
          return;
        }

        if (req.method === "POST") {
          try {
            const raw = await readBody(req);
            const payload = JSON.parse(raw || "{}");
            const { background, overrides } = payload;
            if (!background || typeof overrides !== "object") {
              res.statusCode = 400;
              res.end(JSON.stringify({ ok: false, error: "Expected { background, overrides }" }));
              return;
            }

            const existing = readOverridesFile();
            existing[background] = overrides;

            fs.mkdirSync(path.dirname(OVERRIDES_PATH), { recursive: true });
            fs.writeFileSync(OVERRIDES_PATH, JSON.stringify(existing, null, 2), "utf-8");

            console.log(`[scale-overrides] saved ${Object.keys(overrides).length} value(s) for "${background}" -> ${OVERRIDES_PATH}`);

            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
          }
          return;
        }

        res.statusCode = 405;
        res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
      });
    },
  };
}

export default defineConfig({
  plugins: [scaleOverridesApiPlugin()],
  server: {
    port: 5173,
  },
});
