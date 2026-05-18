const http = require("http");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const RESOURCES_FILE = path.join(DATA_DIR, "resources.json");
const SESSION_TTL_MS = 1000 * 60 * 60 * 8;
const sessions = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

function readJson(file, fallback) {
  if (!fs.existsSync(file)) {
    writeJson(file, fallback);
    return fallback;
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  writeTextFile(file, JSON.stringify(data, null, 2));
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function runPowerShell(script, input) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return spawnSync("powershell.exe", ["-NoProfile", "-EncodedCommand", encoded], {
    input,
    encoding: "utf8"
  });
}

function writeTextFile(file, text) {
  try {
    fs.writeFileSync(file, text);
    return;
  } catch (error) {
    const command = `[Console]::InputEncoding=[Text.UTF8Encoding]::new(); Set-Content -LiteralPath ${psQuote(file)} -Value $input -Encoding UTF8 -NoNewline`;
    const result = runPowerShell(command, text);
    if (result.status !== 0) throw error;
  }
}

function writeBufferFile(file, buffer) {
  try {
    fs.writeFileSync(file, buffer);
    return;
  } catch (error) {
    const command = `$p=${psQuote(file)}; New-Item -ItemType Directory -Force -Path (Split-Path -Parent $p) | Out-Null; $b=[Convert]::FromBase64String($input); [IO.File]::WriteAllBytes($p, $b)`;
    const result = runPowerShell(command, buffer.toString("base64"));
    if (result.status !== 0) {
      throw new Error(result.stderr || error.message);
    }
  }
}

function deleteFile(file) {
  try {
    fs.unlinkSync(file);
    return;
  } catch (error) {
    const command = `Remove-Item -LiteralPath ${psQuote(file)} -Force`;
    const result = runPowerShell(command, "");
    if (result.status !== 0) throw error;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

function seedAdmin() {
  const users = readJson(USERS_FILE, []);
  if (users.some((user) => user.role === "admin")) return;

  users.push({
    id: crypto.randomUUID(),
    name: "Admin",
    email: "admin@studyshare.local",
    passwordHash: hashPassword("admin123"),
    role: "admin",
    createdAt: new Date().toISOString()
  });
  writeJson(USERS_FILE, users);
}

seedAdmin();
readJson(RESOURCES_FILE, []);

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  sendJson(res, status, { message });
}

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJsonBody(req) {
  const body = await readBody(req, 1024 * 1024);
  if (!body.length) return {};
  return JSON.parse(body.toString("utf8"));
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function createSession(res, userId) {
  const id = crypto.randomUUID();
  sessions.set(id, { userId, expiresAt: Date.now() + SESSION_TTL_MS });
  res.setHeader(
    "Set-Cookie",
    `sid=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function destroySession(req, res) {
  const sid = parseCookies(req).sid;
  if (sid) sessions.delete(sid);
  res.setHeader("Set-Cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
}

function getCurrentUser(req) {
  const sid = parseCookies(req).sid;
  const session = sid ? sessions.get(sid) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (sid) sessions.delete(sid);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  const users = readJson(USERS_FILE, []);
  return users.find((user) => user.id === session.userId) || null;
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt
  };
}

function requireAuth(req, res) {
  const user = getCurrentUser(req);
  if (!user) {
    sendError(res, 401, "Please log in first.");
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== "admin") {
    sendError(res, 403, "Admin access required.");
    return null;
  }
  return user;
}

function parseMultipart(buffer, contentType) {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) throw new Error("Missing upload boundary.");

  const boundary = `--${boundaryMatch[1] || boundaryMatch[2]}`;
  const parts = buffer.toString("binary").split(boundary).slice(1, -1);
  const fields = {};
  let file = null;

  for (const part of parts) {
    const cleaned = part.replace(/^\r\n/, "").replace(/\r\n$/, "");
    const headerEnd = cleaned.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;

    const rawHeaders = cleaned.slice(0, headerEnd);
    const bodyBinary = cleaned.slice(headerEnd + 4);
    const disposition = rawHeaders.match(/content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?/i);
    if (!disposition) continue;

    const fieldName = disposition[1];
    const originalName = disposition[2];
    const contentTypeMatch = rawHeaders.match(/content-type:\s*([^\r\n]+)/i);
    const content = Buffer.from(bodyBinary, "binary");

    if (originalName !== undefined) {
      if (!originalName || !content.length) continue;
      file = {
        fieldName,
        originalName: path.basename(originalName),
        contentType: contentTypeMatch ? contentTypeMatch[1].trim() : "application/octet-stream",
        content
      };
    } else {
      fields[fieldName] = Buffer.from(bodyBinary, "binary").toString("utf8");
    }
  }

  return { fields, file };
}

function saveUploadedFile(file) {
  const allowed = new Set([".pdf", ".txt", ".doc", ".docx", ".ppt", ".pptx"]);
  const ext = path.extname(file.originalName).toLowerCase();
  if (!allowed.has(ext)) {
    throw new Error("Only PDF, text, Word, and PowerPoint files are allowed.");
  }
  if (file.content.length > 10 * 1024 * 1024) {
    throw new Error("File must be 10 MB or smaller.");
  }

  const safeName = file.originalName.replace(/[^a-z0-9._-]/gi, "_");
  const fileName = `${Date.now()}-${crypto.randomUUID()}-${safeName}`;
  writeBufferFile(path.join(UPLOAD_DIR, fileName), file.content);
  return { fileName, originalName: file.originalName, fileSize: file.content.length };
}

function serveStatic(req, res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml"
  };
  res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

function listResources(searchParams) {
  const resources = readJson(RESOURCES_FILE, []);
  const query = String(searchParams.get("q") || "").trim().toLowerCase();
  const subject = String(searchParams.get("subject") || "").trim().toLowerCase();

  return resources
    .filter((resource) => {
      const matchesSubject = !subject || resource.subject.toLowerCase() === subject;
      const text = `${resource.title} ${resource.subject} ${resource.description} ${resource.uploaderName}`.toLowerCase();
      return matchesSubject && (!query || text.includes(query));
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/me") {
    sendJson(res, 200, { user: publicUser(getCurrentUser(req)) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/signup") {
    const { name, email, password } = await readJsonBody(req);
    if (!name || !email || !password) return sendError(res, 400, "Name, email, and password are required.");
    if (password.length < 6) return sendError(res, 400, "Password must be at least 6 characters.");

    const users = readJson(USERS_FILE, []);
    const normalizedEmail = email.trim().toLowerCase();
    if (users.some((user) => user.email === normalizedEmail)) {
      return sendError(res, 409, "An account with this email already exists.");
    }

    const user = {
      id: crypto.randomUUID(),
      name: name.trim(),
      email: normalizedEmail,
      passwordHash: hashPassword(password),
      role: "student",
      createdAt: new Date().toISOString()
    };
    users.push(user);
    writeJson(USERS_FILE, users);
    createSession(res, user.id);
    sendJson(res, 201, { user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/login") {
    const { email, password } = await readJsonBody(req);
    const users = readJson(USERS_FILE, []);
    const user = users.find((item) => item.email === String(email || "").trim().toLowerCase());
    if (!user || !verifyPassword(password || "", user.passwordHash)) {
      return sendError(res, 401, "Invalid email or password.");
    }

    createSession(res, user.id);
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/logout") {
    destroySession(req, res);
    sendJson(res, 200, { message: "Logged out successfully." });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    sendJson(res, 200, { resources: listResources(url.searchParams) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/subjects") {
    const resources = readJson(RESOURCES_FILE, []);
    const subjects = [...new Set(resources.map((resource) => resource.subject))].sort();
    sendJson(res, 200, { subjects });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resources") {
    const user = requireAuth(req, res);
    if (!user) return;

    const contentType = req.headers["content-type"] || "";
    const body = await readBody(req);
    const { fields, file } = parseMultipart(body, contentType);
    const { title, subject, description, link } = fields;
    if (!title || !subject || !description) {
      return sendError(res, 400, "Title, subject, and description are required.");
    }
    if (!file && !link) return sendError(res, 400, "Upload a file or provide a useful link.");

    let savedFile = { fileName: "", originalName: "", fileSize: 0 };
    if (file) savedFile = saveUploadedFile(file);

    const resources = readJson(RESOURCES_FILE, []);
    const resource = {
      id: crypto.randomUUID(),
      title: title.trim(),
      subject: subject.trim(),
      description: description.trim(),
      link: link ? link.trim() : "",
      ...savedFile,
      uploaderId: user.id,
      uploaderName: user.name,
      createdAt: new Date().toISOString()
    };
    resources.push(resource);
    writeJson(RESOURCES_FILE, resources);
    sendJson(res, 201, { resource });
    return;
  }

  const downloadMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/download$/);
  if (req.method === "GET" && downloadMatch) {
    const resources = readJson(RESOURCES_FILE, []);
    const resource = resources.find((item) => item.id === downloadMatch[1]);
    if (!resource || !resource.fileName) {
      res.writeHead(404);
      res.end("File not found.");
      return;
    }

    const filePath = path.join(UPLOAD_DIR, resource.fileName);
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end("File no longer exists.");
      return;
    }

    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${resource.originalName.replace(/"/g, "")}"`
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const deleteMatch = url.pathname.match(/^\/api\/resources\/([^/]+)$/);
  if (req.method === "DELETE" && deleteMatch) {
    const user = requireAdmin(req, res);
    if (!user) return;

    const resources = readJson(RESOURCES_FILE, []);
    const resource = resources.find((item) => item.id === deleteMatch[1]);
    if (!resource) return sendError(res, 404, "Resource not found.");

    if (resource.fileName) {
      const filePath = path.join(UPLOAD_DIR, resource.fileName);
      if (fs.existsSync(filePath)) deleteFile(filePath);
    }

    writeJson(
      RESOURCES_FILE,
      resources.filter((item) => item.id !== deleteMatch[1])
    );
    sendJson(res, 200, { message: "Resource removed." });
    return;
  }

  sendError(res, 404, "API route not found.");
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  } catch (error) {
    if (!res.headersSent) sendError(res, 400, error.message || "Something went wrong.");
  }
});

server.listen(PORT, () => {
  console.log(`Study Resource Sharing Platform running at http://localhost:${PORT}`);
});
