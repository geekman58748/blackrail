import { writeFile } from "node:fs/promises";

const apiBase = (process.env.BLACKRAIL_API_BASE || "").trim().replace(/\/+$/, "");
const privyAppId = (process.env.BLACKRAIL_PRIVY_APP_ID || "").trim();

// privyAppId MUST match the PRIVY_APP_ID configured on the API server
// (Railway). If they diverge, the frontend authenticates against one Privy
// app while the backend verifies tokens against another, so every login
// succeeds against Privy but fails at the API and the user is immediately
// signed out.
if (process.env.CONTEXT === "production" && !privyAppId) {
  throw new Error(
    "BLACKRAIL_PRIVY_APP_ID is required for production builds and must match the API server's PRIVY_APP_ID",
  );
}

const contents = `// Generated during the frontend build. Do not commit environment URLs here.
window.BLACKRAIL_CONFIG = window.BLACKRAIL_CONFIG || {};
window.BLACKRAIL_CONFIG.apiBase = ${JSON.stringify(apiBase)};
window.BLACKRAIL_CONFIG.privyAppId = ${JSON.stringify(privyAppId)};
`;

await writeFile("runtime-config.js", contents, "utf8");
