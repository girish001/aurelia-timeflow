// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  ...(process.env["NITRO_PRESET"]
    ? {
        nitro: {
          preset: process.env["NITRO_PRESET"],
        },
      }
    : {}),
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    server: {
      host: "0.0.0.0",
      port: 3000,
    },
    plugins: [
      {
        name: "aurelia-api-dev-middleware",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (!req.url || !req.url.startsWith("/api/v1/")) {
              return next();
            }
            try {
              const protocol = req.headers["x-forwarded-proto"] || "http";
              const host = req.headers.host || "localhost:3000";
              const fullUrl = `${protocol}://${host}${req.url}`;

              const chunks: Buffer[] = [];
              for await (const chunk of req) {
                chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
              }
              const bodyBuffer = Buffer.concat(chunks);

              const headers = new Headers();
              for (const [k, v] of Object.entries(req.headers)) {
                if (v) {
                  if (Array.isArray(v)) {
                    v.forEach((val) => headers.append(k, val));
                  } else {
                    headers.set(k, v);
                  }
                }
              }

              const reqInit: RequestInit = {
                method: req.method ?? "GET",
                headers,
              };
              if (req.method !== "GET" && req.method !== "HEAD" && bodyBuffer.length > 0) {
                reqInit.body = new Uint8Array(bodyBuffer);
              }
              const webReq = new Request(fullUrl, reqInit);

              const { handleApiRequest } = await import("./src/server/api/routes");
              const response = await handleApiRequest(webReq);
              if (!response) {
                return next();
              }

              res.statusCode = response.status;
              response.headers.forEach((value, key) => {
                res.setHeader(key, value);
              });
              const arrayBuffer = await response.arrayBuffer();
              res.end(Buffer.from(arrayBuffer));
            } catch (err) {
              next(err);
            }
          });
        },
      },
    ],
    optimizeDeps: {
      include: [
        "@tanstack/react-query",
        "@tanstack/react-router",
        "lucide-react",
        "date-fns",
        "recharts",
        "sonner",
        "zod",
        "clsx",
        "tailwind-merge",
        "class-variance-authority",
        "@radix-ui/react-alert-dialog",
        "@radix-ui/react-checkbox",
        "@radix-ui/react-dialog",
        "@radix-ui/react-dropdown-menu",
        "@radix-ui/react-label",
        "@radix-ui/react-popover",
        "@radix-ui/react-progress",
        "@radix-ui/react-radio-group",
        "@radix-ui/react-scroll-area",
        "@radix-ui/react-select",
        "@radix-ui/react-separator",
        "@radix-ui/react-slot",
        "@radix-ui/react-switch",
        "@radix-ui/react-tabs",
        "@radix-ui/react-tooltip",
      ],
    },
  },
});
