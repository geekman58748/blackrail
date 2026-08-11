import { writeFile } from "node:fs/promises";

const apiBase = (process.env.BLACKRAIL_API_BASE || "").trim().replace(/\/+$/, "");
const contents = `// Generated during the frontend build. Do not commit environment URLs here.
window.BLACKRAIL_CONFIG = window.BLACKRAIL_CONFIG || {};
window.BLACKRAIL_CONFIG.apiBase = ${JSON.stringify(apiBase)};
`;

await writeFile("runtime-config.js", contents, "utf8");