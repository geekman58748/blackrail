import { writeFile } from "node:fs/promises";
import { validatePrivyFrontendConfig } from "./privy-config.mjs";

const apiBase = (process.env.BLACKRAIL_API_BASE || "").trim().replace(/\/+$/, "");
const privyAppId = validatePrivyFrontendConfig({
  context: process.env.CONTEXT || "development",
  privyAppId: process.env.BLACKRAIL_PRIVY_APP_ID || "",
});

const contents = `// Generated during the frontend build. Do not commit environment URLs here.
window.BLACKRAIL_CONFIG = window.BLACKRAIL_CONFIG || {};
window.BLACKRAIL_CONFIG.apiBase = ${JSON.stringify(apiBase)};
window.BLACKRAIL_CONFIG.privyAppId = ${JSON.stringify(privyAppId)};
`;

await writeFile("runtime-config.js", contents, "utf8");
