import { createStage2aDemoServer, listenLoopbackDemo } from "../dist/src/web/stage2a-server.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const localEnvironment = existsSync(".env") ? parseDotEnv(await readFile(".env", "utf8")) : {};
const environment = { ...localEnvironment, ...process.env };
const port = Number(environment.HBIEPA_DEMO_PORT ?? environment.PORT ?? "3030");
const server = createStage2aDemoServer(undefined, environment);
try { await listenLoopbackDemo(server, port); console.log(`HBIEPA Stage 2B local demonstration: http://127.0.0.1:${port}`); const shutdown = () => server.close(() => process.exit(0)); process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown); } catch (error) { console.error(error instanceof Error ? error.message : "DEMO_SERVER_START_FAILED"); process.exitCode = 1; }

function parseDotEnv(contents) { return Object.fromEntries(contents.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")).map((line) => { const index = line.indexOf("="); return index < 0 ? [line, ""] : [line.slice(0, index).trim(), line.slice(index + 1).trim()]; })); }
