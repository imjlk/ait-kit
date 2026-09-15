// Runs as a plain Node child process (spawned by mtls-test-server.ts) so the
// suite verifies the transport against Node's real TLS stack with client
// certificate enforcement enabled. Usage: node mtls-test-server.mjs <dir> <port>
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const port = Number(process.argv[3]);

const server = createServer(
  {
    cert: readFileSync(join(dir, "server.crt")),
    key: readFileSync(join(dir, "server.key")),
    ca: readFileSync(join(dir, "ca.crt")),
    // Enforce mutual TLS: requests without a recognized client cert are
    // rejected during the handshake.
    requestCert: true,
    rejectUnauthorized: true
  },
  (req, res) => {
    const url = new URL(req.url ?? "/", "https://localhost");
    const peer = req.socket.getPeerCertificate();
    const clientCn = peer?.subject?.CN ?? null;

    const send = (status, body, headers = { "content-type": "application/json" }) => {
      res.writeHead(status, headers);
      res.end(body);
    };

    if (url.pathname === "/echo" && req.method === "POST") {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        send(
          200,
          JSON.stringify({
            clientCn,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: req.headers["content-type"] ?? null
          })
        );
      });
      return;
    }

    if (url.pathname === "/immediate") {
      send(200, JSON.stringify({ clientCn, ok: true }));
      return;
    }

    if (url.pathname === "/slow-body") {
      // Headers arrive immediately; the body trickles in but completes.
      res.writeHead(200, { "content-type": "text/plain" });
      let written = 0;
      const total = Number(url.searchParams.get("chunks") ?? 3);
      const timer = setInterval(() => {
        written += 1;
        res.write(`chunk-${written}\n`);
        if (written >= total) {
          clearInterval(timer);
          res.end();
        }
      }, 40);
      return;
    }

    if (url.pathname === "/hang-headers") {
      // Never responds; the client must hit its overall deadline.
      return;
    }

    if (url.pathname === "/break-body") {
      // Headers plus a partial body, then the socket is destroyed.
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial-");
      setTimeout(() => {
        res.socket?.destroy();
      }, 40);
      return;
    }

    if (url.pathname === "/large") {
      const size = Number(url.searchParams.get("size") ?? 1024);
      res.writeHead(200, { "content-type": "application/octet-stream" });
      const block = Buffer.alloc(64 * 1024, 0x61);
      let sent = 0;
      while (sent + block.length <= size) {
        res.write(block);
        sent += block.length;
      }
      if (sent < size) {
        res.write(block.subarray(0, size - sent));
      }
      res.end();
      return;
    }

    send(404, JSON.stringify({ error: "NOT_FOUND" }));
  }
);

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ready:${server.address().port}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
