import { createApp } from "./app.js";
import { config } from "./config.js";
const server = createApp().listen(config.port, config.host, () =>
  console.log(`Crazibox API: http://${config.host}:${config.port}`),
);
server.requestTimeout = config.timeout + 5000;
server.headersTimeout = 15000;
