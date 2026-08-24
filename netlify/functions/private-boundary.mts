import type { Config } from "@netlify/functions";

export default async () => {
  return new Response(
    JSON.stringify({ ok: false, error: "private_boundary" }),
    {
      status: 401,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    }
  );
};

export const config: Config = {
  path: [
    "/controller",
    "/gauge-stack-controller.html",
    "/gauge-stack-controller.js",
    "/gauge-stack-controller.css",
    "/public/gauge-stack-controller.html",
    "/public/gauge-stack-controller.js",
    "/public/gauge-stack-controller.css",
  ],
};
