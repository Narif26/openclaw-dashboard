const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawnSync } = require('child_process');

// Configuration via environment variables
const PORT = parseInt(process.env.DASHBOARD_PORT || '7000');
const OPENCLAW_DIR = process.env.OPENCLAW_DIR || path.join(os.homedir(), '.openclaw');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || process.env.OPENCLAW_WORKSPACE || process.cwd();
const AGENT_ID = process.env.OPENCLAW_AGENT || 'main';
const sessDir = path.join(OPENCLAW_DIR, 'agents', AGENT_ID, 'sessions');
const cronFile = path.join(OPENCLAW_DIR, 'cron', 'jobs.json');
const dataDir = path.join(WORKSPACE_DIR, 'data');
const memoryDir = path.join(WORKSPACE_DIR, 'memory');
const memoryMdPath = path.join(WORKSPACE_DIR, 'MEMORY.md');
const heartbeatPath = path.join(WORKSPACE_DIR, 'HEARTBEAT.md');
const healthHistoryFile = path.join(dataDir, 'health-history.json');
const claudeUsageFile = path.join(dataDir, 'claude-usage.json');
const scrapeScript = path.join(WORKSPACE_DIR, 'scripts', 'scrape-claude-usage.sh');
const codexSkillsRoot = path.join(os.homedir(), '.codex', 'skills');
const systemSkillsRoot = path.join(codexSkillsRoot, '.system');
const agentChatDir = path.join(dataDir, 'agent-chat');
const agentChatFile = path.join(agentChatDir, 'messages.json');
const agentChatUploadsDir = path.join(agentChatDir, 'uploads');
const agentBridgeScript = process.env.AGENT_BRIDGE_SCRIPT || path.join(WORKSPACE_DIR, 'scripts', 'dashboard-agent-bridge.sh');
const agentBridgeCommand = (process.env.AGENT_BRIDGE_COMMAND || '').trim();
const MAX_CHAT_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_CHAT_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_CHAT_ATTACHMENTS = 8;

const htmlPath = path.join(__dirname, 'index.html');

// Ensure data directory exists
try { fs.mkdirSync(dataDir, { recursive: true }); } catch {}
try { fs.mkdirSync(agentChatDir, { recursive: true }); } catch {}
try { fs.mkdirSync(agentChatUploadsDir, { recursive: true }); } catch {}

function getGitRepos() {
  const repos = [];
  const projDir = path.join(WORKSPACE_DIR, 'projects');
  try {
    if (fs.existsSync(projDir)) {
      fs.readdirSync(projDir).forEach(d => {
        const full = path.join(projDir, d);
        if (fs.existsSync(path.join(full, '.git'))) repos.push({ path: full, name: d });
      });
    }
  } catch {}
  // Also check workspace root
  if (fs.existsSync(path.join(WORKSPACE_DIR, '.git'))) repos.push({ path: WORKSPACE_DIR, name: path.basename(WORKSPACE_DIR) });
  return repos;
}

function runGitCommand(repoPath, args, timeout = 4000) {
  try {
    const result = spawnSync('git', ['-C', repoPath, ...args], {
      encoding: 'utf8',
      timeout
    });
    if (result.status !== 0) return '';
    return (result.stdout || '').trim();
  } catch {
    return '';
  }
}

function safeRelativePath(filePath) {
  try {
    const rel = path.relative(WORKSPACE_DIR, filePath);
    return rel || '.';
  } catch {
    return filePath;
  }
}

function getProjectsData() {
  const candidates = [];
  const seen = new Set();
  const addCandidate = (fullPath, name, source) => {
    try {
      const real = path.resolve(fullPath);
      if (seen.has(real)) return;
      const stat = fs.statSync(real);
      if (!stat.isDirectory()) return;
      seen.add(real);
      candidates.push({ path: real, name, source, modifiedAt: stat.mtimeMs });
    } catch {}
  };

  const projectsDir = path.join(WORKSPACE_DIR, 'projects');
  try {
    if (fs.existsSync(projectsDir)) {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      entries.filter(e => e.isDirectory()).forEach(e => {
        addCandidate(path.join(projectsDir, e.name), e.name, 'projects');
      });
    }
  } catch {}

  addCandidate(WORKSPACE_DIR, path.basename(WORKSPACE_DIR) || 'workspace', 'workspace');

  const projects = candidates.map(project => {
    const gitDir = path.join(project.path, '.git');
    const hasGit = fs.existsSync(gitDir);
    let branch = '-';
    let dirtyFiles = 0;
    let lastCommit = null;
    let languages = [];

    try {
      const entries = fs.readdirSync(project.path);
      languages = [];
      if (entries.some(f => f === 'package.json')) languages.push('Node');
      if (entries.some(f => f === 'pyproject.toml' || f === 'requirements.txt')) languages.push('Python');
      if (entries.some(f => f === 'go.mod')) languages.push('Go');
      if (entries.some(f => f === 'Cargo.toml')) languages.push('Rust');
      if (entries.some(f => f.endsWith('.sln') || f.endsWith('.csproj'))) languages.push('Dotnet');
    } catch {}

    if (hasGit) {
      const rawBranch = runGitCommand(project.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
      if (rawBranch) branch = rawBranch;

      const status = runGitCommand(project.path, ['status', '--porcelain']);
      if (status) dirtyFiles = status.split('\n').filter(Boolean).length;

      const logLine = runGitCommand(project.path, ['log', '-1', '--format=%H|%s|%ct']);
      if (logLine) {
        const [hash, message, ts] = logLine.split('|');
        const timestamp = (parseInt(ts || '0', 10) || 0) * 1000;
        if (timestamp > 0) {
          lastCommit = {
            hash: (hash || '').substring(0, 7),
            message: message || '',
            timestamp
          };
        }
      }
    }

    const lastActivityAt = Math.max(project.modifiedAt || 0, lastCommit?.timestamp || 0);
    return {
      name: project.name,
      source: project.source,
      path: safeRelativePath(project.path),
      hasGit,
      branch,
      dirtyFiles,
      modifiedAt: project.modifiedAt || 0,
      lastActivityAt,
      lastCommit,
      stack: languages
    };
  }).sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));

  const active = projects.filter(p => p.dirtyFiles > 0).length;
  return {
    updatedAt: Date.now(),
    total: projects.length,
    active,
    projects
  };
}

function parseSkillDescription(content) {
  const lines = content.split('\n');
  let title = '';
  let description = '';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!title && trimmed.startsWith('# ')) {
      title = trimmed.substring(2).trim();
      continue;
    }
    if (!description && trimmed && !trimmed.startsWith('#') && !trimmed.startsWith('```')) {
      description = trimmed;
    }
    if (title && description) break;
  }

  return { title, description };
}

function scanSkills(rootDir, skipNames = new Set()) {
  const items = [];
  try {
    if (!fs.existsSync(rootDir)) return items;
    const entries = fs.readdirSync(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (skipNames.has(entry.name)) continue;
      const skillDir = path.join(rootDir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      try {
        const raw = fs.readFileSync(skillFile, 'utf8');
        const parsed = parseSkillDescription(raw);
        items.push({
          id: entry.name,
          name: parsed.title || entry.name,
          description: parsed.description || '',
          path: skillDir
        });
      } catch {}
    }
  } catch {}
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

function getSkillsData() {
  const base = scanSkills(systemSkillsRoot);
  const external = scanSkills(codexSkillsRoot, new Set(['.system']));
  return {
    updatedAt: Date.now(),
    baseRoot: systemSkillsRoot,
    externalRoot: codexSkillsRoot,
    base,
    external
  };
}

function loadAgentMessages() {
  try {
    if (!fs.existsSync(agentChatFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(agentChatFile, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(-500);
  } catch {
    return [];
  }
}

function saveAgentMessages(messages) {
  try {
    fs.writeFileSync(agentChatFile, JSON.stringify(messages.slice(-500), null, 2));
  } catch {}
}

function createMessage(role, text, attachments = [], meta = {}) {
  return {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    role,
    text: (text || '').toString(),
    attachments,
    createdAt: Date.now(),
    ...meta
  };
}

function appendAgentMessage(role, text, attachments = [], meta = {}) {
  const messages = loadAgentMessages();
  const next = createMessage(role, text, attachments, meta);
  messages.push(next);
  saveAgentMessages(messages);
  return next;
}

function sanitizeFilename(name) {
  const cleaned = (name || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  return cleaned.substring(0, 120) || 'upload.bin';
}

function contentTypeFromFilename(name, fallback = 'application/octet-stream') {
  const lower = (name || '').toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.json')) return 'application/json';
  if (lower.endsWith('.txt') || lower.endsWith('.md')) return 'text/plain; charset=utf-8';
  return fallback;
}

function storeChatAttachment(file) {
  if (!file || typeof file !== 'object') throw new Error('Invalid attachment payload');
  const safeName = sanitizeFilename(file.name || 'upload.bin');
  const raw = typeof file.data === 'string' ? file.data : '';
  if (!raw) throw new Error(`Attachment ${safeName} is empty`);

  let buffer;
  try {
    buffer = Buffer.from(raw, 'base64');
  } catch {
    throw new Error(`Attachment ${safeName} could not be decoded`);
  }
  if (!buffer || buffer.length <= 0) throw new Error(`Attachment ${safeName} could not be decoded`);
  if (buffer.length > MAX_CHAT_ATTACHMENT_BYTES) throw new Error(`Attachment ${safeName} exceeds 8MB`);

  const storedName = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${safeName}`;
  const target = path.join(agentChatUploadsDir, storedName);
  fs.writeFileSync(target, buffer);

  return {
    name: safeName,
    storedName,
    size: buffer.length,
    type: (file.type || contentTypeFromFilename(safeName)).toString().substring(0, 120),
    url: `/api/agent-chat/file?name=${encodeURIComponent(storedName)}`
  };
}

function readJsonBody(req, maxBytes = MAX_CHAT_TOTAL_BYTES) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    let done = false;

    req.on('data', chunk => {
      if (done) return;
      received += chunk.length;
      if (received > maxBytes) {
        done = true;
        reject(new Error('Payload too large'));
        try { req.destroy(); } catch {}
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (done) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });

    req.on('error', err => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

function isAgentBridgeConfigured() {
  if (agentBridgeCommand) return true;
  try { return fs.existsSync(agentBridgeScript); } catch { return false; }
}

function runAgentBridge(payload) {
  return new Promise(resolve => {
    if (!isAgentBridgeConfigured()) {
      resolve({ ok: false, error: 'Agent bridge is not configured' });
      return;
    }

    const payloadFile = path.join(agentChatDir, `payload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    try {
      fs.writeFileSync(payloadFile, JSON.stringify(payload, null, 2));
    } catch (e) {
      resolve({ ok: false, error: e.message || 'Failed to write bridge payload' });
      return;
    }

    const escapedPayload = payloadFile.replace(/"/g, '\\"');
    const escapedScript = agentBridgeScript.replace(/"/g, '\\"');
    const command = agentBridgeCommand ? `${agentBridgeCommand} "${escapedPayload}"` : `bash "${escapedScript}" "${escapedPayload}"`;

    exec(command, { timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(payloadFile); } catch {}

      if (err) {
        resolve({ ok: false, error: (stderr || err.message || 'Bridge execution failed').trim() });
        return;
      }

      const output = (stdout || '').trim();
      if (!output) {
        resolve({ ok: false, error: 'Bridge returned empty output' });
        return;
      }

      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed.reply === 'string') {
          resolve({ ok: true, reply: parsed.reply, meta: parsed.meta || null });
          return;
        }
      } catch {}

      resolve({ ok: true, reply: output });
    });
  });
}

function resolveName(key) {
  if (key.includes(':main:main')) return 'main';
  if (key.includes('teleg')) return 'telegram-group';
  if (key.includes('cron:')) {
    try {
      if (fs.existsSync(cronFile)) {
        const crons = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
        const jobs = crons.jobs || [];
        // Extract the cron UUID from the key (after "cron:")
        const cronPart = key.split('cron:')[1] || '';
        const cronUuid = cronPart.split(':')[0]; // get just the UUID, not :run:xxx
        const job = jobs.find(j => j.id === cronUuid);
        if (job && job.name) return job.name;
      }
    } catch {}
    // Extract short ID for fallback
    const cronPart = key.split('cron:')[1] || '';
    const cronUuid = cronPart.split(':')[0];
    return 'Cron: ' + cronUuid.substring(0, 8);
  }
  if (key.includes('subagent')) {
    const parts = key.split(':');
    return parts[parts.length - 1].substring(0, 12);
  }
  return key.split(':').pop().substring(0, 12);
}

function getLastMessage(sessionId) {
  try {
    const filePath = path.join(sessDir, sessionId + '.jsonl');
    if (!fs.existsSync(filePath)) return '';
    const data = fs.readFileSync(filePath, 'utf8');
    const lines = data.split('\n').filter(l => l.trim());
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
      try {
        const d = JSON.parse(lines[i]);
        if (d.type !== 'message') continue;
        const msg = d.message;
        if (!msg) continue;
        const role = msg.role;
        if (role !== 'user' && role !== 'assistant') continue;
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const b of msg.content) {
            if (b.type === 'text' && b.text) { text = b.text; break; }
          }
        }
        if (text) return text.replace(/\n/g, ' ').substring(0, 80);
      } catch {}
    }
    return '';
  } catch { return ''; }
}

let sessionCostCache = {};
let sessionCostCacheTime = 0;

function getSessionCost(sessionId) {
  const now = Date.now();
  if (now - sessionCostCacheTime > 60000) {
    sessionCostCache = {};
    sessionCostCacheTime = now;
    try {
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        const sid = file.replace('.jsonl', '');
        let total = 0;
        const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            const c = d.message?.usage?.cost?.total || 0;
            if (c > 0) total += c;
          } catch {}
        }
        if (total > 0) sessionCostCache[sid] = Math.round(total * 100) / 100;
      }
    } catch {}
  }
  return sessionCostCache[sessionId] || 0;
}

function getSessionsJson() {
  try {
    const sFile = path.join(sessDir, 'sessions.json');
    const data = JSON.parse(fs.readFileSync(sFile, 'utf8'));
    return Object.entries(data).map(([key, s]) => ({
      key,
      label: s.label || resolveName(key),
      model: s.modelOverride || s.model || '-',
      totalTokens: s.totalTokens || 0,
      contextTokens: s.contextTokens || 0,
      kind: s.kind || (key.includes('group') ? 'group' : 'direct'),
      updatedAt: s.updatedAt || 0,
      createdAt: s.createdAt || s.updatedAt || 0,
      aborted: s.abortedLastRun || false,
      thinkingLevel: s.thinkingLevel || null,
      channel: s.channel || '-',
      sessionId: s.sessionId || '-',
      lastMessage: getLastMessage(s.sessionId || key),
      cost: getSessionCost(s.sessionId || key)
    }));
  } catch (e) { return []; }
}

function getCostData() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const perModel = {};
    const perDay = {};
    const perSession = {};
    let total = 0;

    for (const file of files) {
      const sid = file.replace('.jsonl', '');
      let scost = 0;
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const msg = d.message;
          if (!msg || !msg.usage || !msg.usage.cost) continue;
          const c = msg.usage.cost.total || 0;
          if (c <= 0) continue;
          const model = msg.model || 'unknown';
          if (model.includes('delivery-mirror')) continue;
          const ts = d.timestamp || '';
          const day = ts.substring(0, 10);
          perModel[model] = (perModel[model] || 0) + c;
          perDay[day] = (perDay[day] || 0) + c;
          scost += c;
          total += c;
        } catch {}
      }
      if (scost > 0) perSession[sid] = scost;
    }

    const now = new Date();
    const todayKey = now.toISOString().substring(0, 10);
    const weekAgo = new Date(now - 7 * 86400000).toISOString().substring(0, 10);
    let weekCost = 0;
    for (const [d, c] of Object.entries(perDay)) {
      if (d >= weekAgo) weekCost += c;
    }

    return {
      total: Math.round(total * 100) / 100,
      today: Math.round((perDay[todayKey] || 0) * 100) / 100,
      week: Math.round(weekCost * 100) / 100,
      perModel,
      perDay: Object.fromEntries(Object.entries(perDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 14)),
      perSession: (() => {
        let sidLabels = {};
        try {
          const sData = JSON.parse(fs.readFileSync(path.join(sessDir, 'sessions.json'), 'utf8'));
          for (const [key, val] of Object.entries(sData)) {
            if (val.sessionId) sidLabels[val.sessionId] = val.label || key.split(':').slice(2).join(':');
          }
        } catch {}
        return Object.fromEntries(
          Object.entries(perSession).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([sid, cost]) => {
            let label = sidLabels[sid] || null;
            if (!label) {
              try {
                const jf = path.join(sessDir, sid + '.jsonl');
                if (!fs.existsSync(jf)) {
                  const del = fs.readdirSync(sessDir).find(f => f.startsWith(sid) && f.includes('.deleted'));
                  if (del) { /* deleted session, no label */ }
                }
                if (fs.existsSync(jf)) {
                  const lines = fs.readFileSync(jf, 'utf8').split('\n');
                  for (const l of lines) {
                    if (!l.includes('"user"')) continue;
                    try {
                      const d = JSON.parse(l);
                      const c = d.message?.content;
                      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.find(x => x.type === 'text')?.text || '' : '';
                      if (txt) {
                        let t = txt.replace(/\n/g, ' ').trim();
                        const bgMatch = t.match(/background task "([^"]+)"/i);
                        if (bgMatch) t = 'Sub: ' + bgMatch[1];
                        const cronMatch = t.match(/\[cron:([^\]]+)\]/);
                        if (cronMatch) {
                          let cronName = cronMatch[1].substring(0, 8);
                          try {
                            const cj = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
                            const job = cj.jobs?.find(j => j.id?.startsWith(cronMatch[1].substring(0, 8)));
                            if (job?.name) cronName = job.name;
                          } catch {}
                          t = 'Cron: ' + cronName;
                        }
                        if (t.startsWith('System:')) t = t.substring(7).trim();
                        t = t.replace(/^\[\d{4}-\d{2}-\d{2}[^\]]*\]\s*/, '');
                        if (t.startsWith('You are running a boot')) t = 'Boot check';
                        if (t.match(/whatsapp/i)) t = 'WhatsApp session';
                        const subMatch2 = t.match(/background task "([^"]+)"/i);
                        if (!bgMatch && subMatch2) t = 'Sub: ' + subMatch2[1];
                        label = t.substring(0, 35); if (t.length > 35) label += '…';
                        break;
                      }
                    } catch {}
                  }
                }
              } catch {}
            }
            return [sid, { cost, label: label || ('session-' + sid.substring(0, 8)) }];
          })
        );
      })()
    };
  } catch (e) { return { total: 0, today: 0, week: 0, perModel: {}, perDay: {}, perSession: {} }; }
}

let costCache = null;
let costCacheTime = 0;

function getUsageWindows() {
  try {
    const now = Date.now();
    const fiveHoursMs = 5 * 3600000;
    const oneWeekMs = 7 * 86400000;
    // Only read files modified within the week window
    const files = fs.readdirSync(sessDir).filter(f => {
      if (!f.endsWith('.jsonl')) return false;
      try { return fs.statSync(path.join(sessDir, f)).mtimeMs > now - oneWeekMs; } catch { return false; }
    });

    const perModel5h = {};
    const perModelWeek = {};
    const recentMessages = [];

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const msg = d.message;
          if (!msg || !msg.usage) continue;
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
          if (!ts) continue;
          const model = msg.model || 'unknown';
          const inTok = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
          const outTok = msg.usage.output || 0;
          const cost = msg.usage.cost ? msg.usage.cost.total || 0 : 0;

          if (now - ts < fiveHoursMs) {
            if (!perModel5h[model]) perModel5h[model] = { input: 0, output: 0, cost: 0, calls: 0 };
            perModel5h[model].input += inTok;
            perModel5h[model].output += outTok;
            perModel5h[model].cost += cost;
            perModel5h[model].calls++;
          }
          if (now - ts < oneWeekMs) {
            if (!perModelWeek[model]) perModelWeek[model] = { input: 0, output: 0, cost: 0, calls: 0 };
            perModelWeek[model].input += inTok;
            perModelWeek[model].output += outTok;
            perModelWeek[model].cost += cost;
            perModelWeek[model].calls++;
          }
          if (now - ts < fiveHoursMs) {
            recentMessages.push({ ts, model, input: inTok, output: outTok, cost });
          }
        } catch {}
      }
    }

    recentMessages.sort((a, b) => b.ts - a.ts);

    const estimatedLimits = { opus: 88000, sonnet: 220000 };

    let windowStart = null;
    if (recentMessages.length > 0) {
      windowStart = recentMessages[recentMessages.length - 1].ts;
    }
    const windowResetIn = windowStart ? Math.max(0, (windowStart + fiveHoursMs) - now) : 0;

    const thirtyMinAgo = now - 30 * 60000;
    const recent30 = recentMessages.filter(m => m.ts >= thirtyMinAgo);
    let burnTokensPerMin = 0;
    let burnCostPerMin = 0;
    if (recent30.length > 0) {
      const totalOut30 = recent30.reduce((s, m) => s + m.output, 0);
      const totalCost30 = recent30.reduce((s, m) => s + m.cost, 0);
      const spanMs = Math.max(now - Math.min(...recent30.map(m => m.ts)), 60000);
      burnTokensPerMin = totalOut30 / (spanMs / 60000);
      burnCostPerMin = totalCost30 / (spanMs / 60000);
    }

    const opusKey = Object.keys(perModel5h).find(k => k.includes('opus')) || '';
    const opusOut = opusKey ? perModel5h[opusKey].output : 0;
    const sonnetKey = Object.keys(perModel5h).find(k => k.includes('sonnet')) || '';
    const sonnetOut = sonnetKey ? perModel5h[sonnetKey].output : 0;

    const opusRemaining = estimatedLimits.opus - opusOut;
    const timeToLimit = burnTokensPerMin > 0 ? (opusRemaining / burnTokensPerMin) * 60000 : null;

    const perModelCost5h = {};
    for (const [model, data] of Object.entries(perModel5h)) {
      const isOpus = model.includes('opus');
      const isSonnet = model.includes('sonnet');
      let inputPrice = 0, outputPrice = 0, cachePrice = 0;
      if (isOpus) { inputPrice = 15; outputPrice = 75; cachePrice = 1.875; }
      else if (isSonnet) { inputPrice = 3; outputPrice = 15; cachePrice = 0.375; }
      perModelCost5h[model] = {
        inputCost: (data.input || 0) / 1000000 * inputPrice,
        outputCost: (data.output || 0) / 1000000 * outputPrice,
        totalCost: data.cost || 0
      };
    }

    const totalCost5h = Object.values(perModel5h).reduce((s, m) => s + (m.cost || 0), 0);
    const totalCalls5h = Object.values(perModel5h).reduce((s, m) => s + (m.calls || 0), 0);
    const costLimit = 35.0;
    const messageLimit = 1000;

    return {
      fiveHour: {
        perModel: perModel5h,
        perModelCost: perModelCost5h,
        windowStart,
        windowResetIn,
        recentCalls: recentMessages.slice(0, 20).map(m => ({
          ...m,
          ago: Math.round((now - m.ts) / 60000) + 'm ago'
        }))
      },
      weekly: {
        perModel: perModelWeek
      },
      burnRate: { tokensPerMinute: Math.round(burnTokensPerMin * 100) / 100, costPerMinute: Math.round(burnCostPerMin * 10000) / 10000 },
      estimatedLimits,
      current: {
        opusOutput: opusOut,
        sonnetOutput: sonnetOut,
        totalCost: Math.round(totalCost5h * 100) / 100,
        totalCalls: totalCalls5h,
        opusPct: Math.round((opusOut / estimatedLimits.opus) * 100),
        sonnetPct: Math.round((sonnetOut / estimatedLimits.sonnet) * 100),
        costPct: Math.round((totalCost5h / costLimit) * 100),
        messagePct: Math.round((totalCalls5h / messageLimit) * 100),
        costLimit,
        messageLimit
      },
      predictions: { timeToLimit: timeToLimit ? Math.round(timeToLimit) : null, safe: !timeToLimit || timeToLimit > 3600000 }
    };
  } catch (e) {
    return { fiveHour: { perModel: {} }, weekly: { perModel: {} } };
  }
}

// Track rate limit hits from OpenClaw logs
function getRateLimitEvents() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const events = [];
    const now = Date.now();
    const fiveHoursMs = 5 * 3600000;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          const ts = d.timestamp ? new Date(d.timestamp).getTime() : 0;
          if (now - ts > fiveHoursMs) continue;
          // Check for rate limit / overloaded errors
          if (d.type === 'error' || (d.message && d.message.stopReason === 'rate_limit')) {
            const text = JSON.stringify(d);
            if (text.includes('rate') || text.includes('overloaded') || text.includes('429') || text.includes('limit')) {
              events.push({ ts, type: 'rate_limit', detail: text.substring(0, 200) });
            }
          }
        } catch {}
      }
    }
    return events;
  } catch { return []; }
}

let usageCache = null;
let usageCacheTime = 0;

// System stats
function getSystemStats() {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    let cpuTemp = null;
    try {
      const tempRaw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
      cpuTemp = parseInt(tempRaw) / 1000;
    } catch {}

    const loadAvg = os.loadavg();
    const uptime = os.uptime();

    let cpuUsage = 0;
    try {
      const loadAvg1m = os.loadavg()[0];
      const numCpus = os.cpus().length;
      cpuUsage = Math.min(Math.round((loadAvg1m / numCpus) * 100), 100);
    } catch {
      cpuUsage = 0;
    }

    let diskPercent = 0, diskUsed = '', diskTotal = '';
    try {
      const { execSync } = require('child_process');
      const df = execSync("df / --output=pcent,used,size -B1G | tail -1", { encoding: 'utf8' }).trim();
      const parts = df.split(/\s+/);
      diskPercent = parseInt(parts[0]);
      diskUsed = parts[1] + 'G';
      diskTotal = parts[2] + 'G';
    } catch {}

    let crashCount = 0;
    try {
      const { execSync } = require('child_process');
      const logs = execSync("journalctl -u openclaw --since '7 days ago' --no-pager -o short 2>/dev/null | grep -ci 'SIGABRT\\|SIGSEGV\\|exit code [1-9]\\|process crashed\\|fatal error' || echo 0", { encoding: 'utf8' }).trim();
      crashCount = parseInt(logs) || 0;
    } catch {}

    let crashesToday = 0;
    try {
      const { execSync } = require('child_process');
      const logs = execSync("journalctl -u openclaw --since today --no-pager -o short 2>/dev/null | grep -ci 'SIGABRT\\|SIGSEGV\\|exit code [1-9]\\|process crashed\\|fatal error' || echo 0", { encoding: 'utf8' }).trim();
      crashesToday = parseInt(logs) || 0;
    } catch {}

    return {
      cpu: { usage: cpuUsage, temp: cpuTemp },
      disk: { percent: diskPercent, used: diskUsed, total: diskTotal },
      crashCount,
      crashesToday,
      memory: {
        total: totalMem,
        used: usedMem,
        free: freeMem,
        percent: memPercent,
        totalGB: (totalMem / 1073741824).toFixed(1),
        usedGB: (usedMem / 1073741824).toFixed(1),
        freeGB: (freeMem / 1073741824).toFixed(1)
      },
      loadAvg: { '1m': loadAvg[0].toFixed(2), '5m': loadAvg[1].toFixed(2), '15m': loadAvg[2].toFixed(2) },
      uptime: uptime
    };
  } catch (e) {
    return { cpu: { usage: 0, temp: null }, memory: { total: 0, used: 0, free: 0, percent: 0 }, loadAvg: { '1m': 0, '5m': 0, '15m': 0 }, uptime: 0 };
  }
}

let liveClients = [];
let liveWatcher = null;
const _fileWatchers = {};
const _fileSizes = {};

function watchSessionFile(file) {
  const filePath = path.join(sessDir, file);
  const sessionKey = file.replace('.jsonl', '');
  if (_fileWatchers[file]) return;
  try {
    _fileSizes[file] = fs.statSync(filePath).size;
  } catch { _fileSizes[file] = 0; }
  
  try {
    _fileWatchers[file] = fs.watch(filePath, (eventType) => {
      if (eventType !== 'change') return;
      try {
        const stats = fs.statSync(filePath);
        if (stats.size <= (_fileSizes[file] || 0)) return;
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.allocUnsafe(stats.size - (_fileSizes[file] || 0));
        fs.readSync(fd, buffer, 0, buffer.length, _fileSizes[file] || 0);
        fs.closeSync(fd);
        _fileSizes[file] = stats.size;
        buffer.toString('utf8').split('\n').filter(l => l.trim()).forEach(line => {
          try { const data = JSON.parse(line); data._sessionKey = sessionKey; broadcastLiveEvent(data); } catch {}
        });
      } catch {}
    });
  } catch {}
}

function startLiveWatcher() {
  if (liveWatcher) return;
  try {
    // Watch existing files
    fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl')).forEach(watchSessionFile);
    // Watch directory for new session files
    liveWatcher = fs.watch(sessDir, (eventType, filename) => {
      if (filename && filename.endsWith('.jsonl') && !_fileWatchers[filename]) {
        try { if (fs.existsSync(path.join(sessDir, filename))) watchSessionFile(filename); } catch {}
      }
    });
  } catch {}
}

function broadcastLiveEvent(data) {
  if (liveClients.length === 0) return;
  
  const event = formatLiveEvent(data);
  if (!event) return;
  
  const message = `data: ${JSON.stringify(event)}\n\n`;
  liveClients.forEach(res => {
    try {
      res.write(message);
    } catch {}
  });
}

function formatLiveEvent(data) {
  const timestamp = data.timestamp || new Date().toISOString();
  const sessionKey = data._sessionKey || data.sessionId || 'unknown';
  
  const sessions = getSessionsJson();
  const session = sessions.find(s => s.sessionId === sessionKey || s.key.includes(sessionKey));
  const label = session ? session.label : sessionKey.substring(0, 8);
  
  if (data.type === 'message') {
    const msg = data.message;
    if (!msg) return null;
    
    const role = msg.role || 'unknown';
    let content = '';
    
    if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text' && block.text) {
          content = block.text.substring(0, 150);
          break;
        } else if (block.type === 'toolCall' || block.type === 'tool_use') {
          content = `🔧 ${block.name || block.toolName || 'tool'}(${(JSON.stringify(block.arguments || block.input || {})).substring(0, 80)})`;
          break;
        } else if (block.type === 'toolResult' || block.type === 'tool_result') {
          const rc = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
          content = `📋 Result: ${rc.substring(0, 100)}`;
          break;
        } else if (block.type === 'thinking') {
          content = `💭 ${(block.thinking || '').substring(0, 100)}`;
          break;
        }
      }
      if (!content && msg.content[0]) {
        content = JSON.stringify(msg.content[0]).substring(0, 100);
      }
    } else if (typeof msg.content === 'string') {
      content = msg.content.substring(0, 150);
    }
    
    // For tool results at top level
    if (!content && msg.type === 'tool_result') {
      const rc = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
      content = `📋 ${rc.substring(0, 100)}`;
    }
    
    if (!content) return null;
    
    return {
      timestamp,
      session: label,
      role,
      content: content.replace(/\n/g, ' ').trim()
    };
  }
  
  return null;
}

function getCronJobs() {
  try {
    if (!fs.existsSync(cronFile)) return [];
    const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
    return (data.jobs || []).map(j => {
      let humanSchedule = j.schedule?.expr || '';
      try {
        const parts = humanSchedule.split(' ');
        if (parts.length === 5) {
          const [min, hour, dom, mon, dow] = parts;
          const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
          let readable = '';
          if (dow !== '*') readable = dowNames[parseInt(dow)] || dow;
          if (hour !== '*' && min !== '*') readable += (readable ? ' ' : '') + `${hour.padStart(2,'0')}:${min.padStart(2,'0')}`;
          if (j.schedule?.tz) readable += ` (${j.schedule.tz.split('/').pop()})`;
          if (readable) humanSchedule = readable;
        }
      } catch {}
      return {
        id: j.id,
        name: j.name || j.id.substring(0, 8),
        schedule: humanSchedule,
        enabled: j.enabled !== false,
        lastStatus: j.state?.lastStatus || 'unknown',
        lastRunAt: j.state?.lastRunAtMs || 0,
        nextRunAt: j.state?.nextRunAtMs || 0,
        lastDuration: j.state?.lastDurationMs || 0
      };
    });
  } catch { return []; }
}

function getGitActivity() {
  try {
    const { execSync } = require('child_process');
    const repos = getGitRepos();
    const commits = [];
    for (const repo of repos) {
      try {
        if (!fs.existsSync(path.join(repo.path, '.git'))) continue;
        const log = execSync(`git -C ${repo.path} log --oneline --since='7 days ago' -10 --format='%H|%s|%at'`, { encoding: 'utf8', timeout: 5000 }).trim();
        if (!log) continue;
        log.split('\n').forEach(line => {
          const [hash, msg, ts] = line.split('|');
          commits.push({ repo: repo.name, hash: (hash || '').substring(0, 7), message: msg || '', timestamp: parseInt(ts || '0') * 1000 });
        });
      } catch {}
    }
    commits.sort((a, b) => b.timestamp - a.timestamp);
    return commits.slice(0, 15);
  } catch { return []; }
}

function getServicesStatus() {
  const { execSync } = require('child_process');
  const services = ['openclaw', 'agent-dashboard', 'tailscaled'];
  return services.map(name => {
    try {
      const status = execSync(`systemctl is-active ${name} 2>/dev/null`, { encoding: 'utf8', timeout: 3000 }).trim();
      return { name, active: status === 'active' };
    } catch { return { name, active: false }; }
  });
}

function getMemoryFiles() {
  const files = [];
  try {
    if (fs.existsSync(memoryMdPath)) {
      const stat = fs.statSync(memoryMdPath);
      files.push({ name: 'MEMORY.md', modified: stat.mtimeMs, size: stat.size });
    }
  } catch {}
  try {
    if (fs.existsSync(heartbeatPath)) {
      const stat = fs.statSync(heartbeatPath);
      files.push({ name: 'HEARTBEAT.md', modified: stat.mtimeMs, size: stat.size });
    }
  } catch {}
  try {
    if (fs.existsSync(memoryDir)) {
      const entries = fs.readdirSync(memoryDir).filter(f => f.endsWith('.md')).sort().reverse();
      entries.forEach(e => {
        try {
          const stat = fs.statSync(path.join(memoryDir, e));
          files.push({ name: 'memory/' + e, modified: stat.mtimeMs, size: stat.size });
        } catch {}
      });
    }
  } catch {}
  return files;
}

function getTodayTokens() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const now = new Date();
    const todayStr = now.toISOString().substring(0, 10);
    const perModel = {};
    let totalInput = 0, totalOutput = 0;

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const ts = d.timestamp || '';
          if (!ts.startsWith(todayStr)) continue;
          const msg = d.message;
          if (!msg || !msg.usage) continue;
          const model = (msg.model || 'unknown').split('/').pop();
          if (model === 'delivery-mirror') continue;
          const inTok = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
          const outTok = msg.usage.output || 0;
          if (!perModel[model]) perModel[model] = { input: 0, output: 0 };
          perModel[model].input += inTok;
          perModel[model].output += outTok;
          totalInput += inTok;
          totalOutput += outTok;
        } catch {}
      }
    }
    return { totalInput, totalOutput, perModel };
  } catch { return { totalInput: 0, totalOutput: 0, perModel: {} }; }
}

function getAvgResponseTime() {
  try {
    const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
    const now = new Date();
    const todayStr = now.toISOString().substring(0, 10);
    const diffs = [];

    for (const file of files) {
      const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
      let lastUserTs = null;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const d = JSON.parse(line);
          if (d.type !== 'message') continue;
          const ts = d.timestamp || '';
          if (!ts.startsWith(todayStr)) continue;
          const role = d.message?.role;
          const msgTs = new Date(ts).getTime();
          if (role === 'user') {
            lastUserTs = msgTs;
          } else if (role === 'assistant' && lastUserTs) {
            const diff = msgTs - lastUserTs;
            if (diff > 0 && diff < 600000) diffs.push(diff);
            lastUserTs = null;
          }
        } catch {}
      }
    }
    if (diffs.length === 0) return 0;
    return Math.round(diffs.reduce((a, b) => a + b, 0) / diffs.length / 1000);
  } catch { return 0; }
}

function trackDiskHistory(diskPercent) {
  const histFile = path.join(__dirname, 'disk-history.json');
  let history = [];
  try { history = JSON.parse(fs.readFileSync(histFile, 'utf8')); } catch {}
  const now = Date.now();
  if (history.length > 0 && now - history[history.length - 1].t < 1800000) return history;
  history.push({ t: now, v: diskPercent });
  if (history.length > 48) history = history.slice(-48);
  try { fs.writeFileSync(histFile, JSON.stringify(history)); } catch {}
  return history;
}

// Health history tracking
let healthHistory = [];
try {
  if (fs.existsSync(healthHistoryFile)) {
    healthHistory = JSON.parse(fs.readFileSync(healthHistoryFile, 'utf8'));
  }
} catch {}

function saveHealthSnapshot() {
  try {
    const stats = getSystemStats();
    const now = Date.now();
    healthHistory.push({
      t: now,
      cpu: stats.cpu?.usage || 0,
      ram: stats.memory?.percent || 0
    });
    // Keep last 24h (288 points at 5min intervals)
    if (healthHistory.length > 288) {
      healthHistory = healthHistory.slice(-288);
    }
    const dir = path.dirname(healthHistoryFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(healthHistoryFile, JSON.stringify(healthHistory));
  } catch (e) {
    console.error('Health snapshot error:', e);
  }
}

// Save health snapshot every 5 minutes
setInterval(saveHealthSnapshot, 5 * 60 * 1000);
saveHealthSnapshot(); // Initial snapshot

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getSessionsJson()));
    return;
  }
  if (req.url === '/api/usage') {
    const now = Date.now();
    if (!usageCache || now - usageCacheTime > 10000) {
      usageCache = getUsageWindows();
      usageCacheTime = now;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(usageCache));
    return;
  }
  if (req.url === '/api/costs') {
    const now = Date.now();
    if (!costCache || now - costCacheTime > 60000) {
      costCache = getCostData();
      costCacheTime = now;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(costCache));
    return;
  }
  if (req.url === '/api/system') {
    const stats = getSystemStats();
    if (stats.disk) stats.diskHistory = trackDiskHistory(stats.disk.percent || 0);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(stats));
    return;
  }
  if (req.url.startsWith('/api/session-messages?')) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    const rawId = params.get('id') || '';
    const sessionId = rawId.replace(/[^a-zA-Z0-9\-_:.]/g, '');
    const messages = [];
    try {
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      let targetFile = files.find(f => f.includes(sessionId));
      if (!targetFile) {
        const sFile = path.join(sessDir, 'sessions.json');
        const data = JSON.parse(fs.readFileSync(sFile, 'utf8'));
        for (const [k, v] of Object.entries(data)) {
          if (k === sessionId && v.sessionId) {
            targetFile = files.find(f => f.includes(v.sessionId));
            break;
          }
        }
      }
      if (targetFile) {
        const lines = fs.readFileSync(path.join(sessDir, targetFile), 'utf8').split('\n').filter(l => l.trim());
        for (let i = Math.max(0, lines.length - 30); i < lines.length; i++) {
          try {
            const d = JSON.parse(lines[i]);
            if (d.type !== 'message') continue;
            const msg = d.message;
            if (!msg) continue;
            let text = '';
            if (typeof msg.content === 'string') text = msg.content;
            else if (Array.isArray(msg.content)) {
              for (const b of msg.content) {
                if (b.type === 'text' && b.text) { text = b.text; break; }
                if (b.type === 'tool_use' || b.type === 'toolCall') { text = '🔧 ' + (b.name || b.toolName || 'tool'); break; }
              }
            }
            if (text) messages.push({ role: msg.role || 'unknown', content: text.substring(0, 300), timestamp: d.timestamp || '' });
          } catch {}
        }
      }
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(messages));
    return;
  }
  if (req.url === '/api/crons') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getCronJobs()));
    return;
  }
  if (req.url === '/api/git') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getGitActivity()));
    return;
  }
  if (req.url === '/api/services') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getServicesStatus()));
    return;
  }
  if (req.url === '/api/memory') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getMemoryFiles()));
    return;
  }
  if (req.url === '/api/tokens-today') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getTodayTokens()));
    return;
  }
  if (req.url === '/api/projects') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getProjectsData()));
    return;
  }
  if (req.url === '/api/skills') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getSkillsData()));
    return;
  }
  if (req.url === '/api/agent-chat') {
    const messages = loadAgentMessages();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({
      updatedAt: Date.now(),
      bridgeConfigured: isAgentBridgeConfigured(),
      limits: {
        maxAttachments: MAX_CHAT_ATTACHMENTS,
        maxFileBytes: MAX_CHAT_ATTACHMENT_BYTES
      },
      messages: messages.slice(-200)
    }));
    return;
  }
  if (req.url.startsWith('/api/agent-chat/file?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const storedName = (params.get('name') || '').trim();
      if (!storedName || !/^[a-zA-Z0-9._-]+$/.test(storedName)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid file');
        return;
      }
      const filePath = path.join(agentChatUploadsDir, storedName);
      const normalizedRoot = path.resolve(agentChatUploadsDir) + path.sep;
      const normalizedFile = path.resolve(filePath);
      if (!normalizedFile.startsWith(normalizedRoot)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid file path');
        return;
      }
      if (!fs.existsSync(normalizedFile)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
        return;
      }
      const stat = fs.statSync(normalizedFile);
      const contentType = contentTypeFromFilename(storedName);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        'Cache-Control': 'private, max-age=60',
        'Access-Control-Allow-Origin': '*'
      });
      fs.createReadStream(normalizedFile).pipe(res);
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Failed to read file');
    }
    return;
  }
  if (req.url === '/api/agent-chat/send' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const text = (body.text || '').toString().trim();
      const rawFiles = Array.isArray(body.files) ? body.files : [];
      if (!text && rawFiles.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'Message text or attachment is required' }));
        return;
      }
      if (rawFiles.length > MAX_CHAT_ATTACHMENTS) {
        res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: `Max ${MAX_CHAT_ATTACHMENTS} attachments allowed` }));
        return;
      }

      const attachments = [];
      let totalBytes = 0;
      try {
        for (const file of rawFiles) {
          const saved = storeChatAttachment(file);
          totalBytes += saved.size || 0;
          if (totalBytes > MAX_CHAT_TOTAL_BYTES) {
            try {
              const p = path.join(agentChatUploadsDir, saved.storedName);
              if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch {}
            throw new Error('Total attachment size exceeds 25MB');
          }
          attachments.push(saved);
        }
      } catch (attachmentErr) {
        attachments.forEach(a => {
          try {
            const p = path.join(agentChatUploadsDir, a.storedName);
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } catch {}
        });
        throw attachmentErr;
      }

      const userMessage = appendAgentMessage('user', text, attachments, { source: 'dashboard' });
      let assistantMessage = null;
      let bridgeError = null;

      if (isAgentBridgeConfigured()) {
        const bridgeResult = await runAgentBridge({
          createdAt: Date.now(),
          message: {
            id: userMessage.id,
            text: userMessage.text,
            attachments: userMessage.attachments
          },
          recentMessages: loadAgentMessages().slice(-30),
          workspaceDir: WORKSPACE_DIR,
          openclawDir: OPENCLAW_DIR,
          agentId: AGENT_ID
        });
        if (bridgeResult.ok && bridgeResult.reply) {
          assistantMessage = appendAgentMessage('assistant', bridgeResult.reply, [], { source: 'bridge', bridgeMeta: bridgeResult.meta || null });
        } else if (!bridgeResult.ok) {
          bridgeError = bridgeResult.error || 'Bridge execution failed';
          assistantMessage = appendAgentMessage('system', `Bridge error: ${bridgeError}`, [], { source: 'bridge' });
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({
        success: true,
        bridgeConfigured: isAgentBridgeConfigured(),
        bridgeError,
        userMessage,
        assistantMessage
      }));
    } catch (e) {
      const statusCode = (e.message || '').includes('Payload too large') ? 413 : 400;
      res.writeHead(statusCode, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: e.message || 'Failed to send message' }));
    }
    return;
  }
  if (req.url === '/api/config') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ name: 'OpenClaw Dashboard', version: '1.0.0' }));
    return;
  }
  if (req.url === '/api/claude-usage-scrape' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    const { exec } = require('child_process');
    if (fs.existsSync(scrapeScript)) {
      exec(`bash ${scrapeScript}`, { timeout: 60000 }, (err) => {});
      res.end(JSON.stringify({ status: 'started' }));
    } else {
      res.end(JSON.stringify({ status: 'error', message: 'Scrape script not found' }));
    }
    return;
  }
  if (req.url === '/api/claude-usage') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const data = JSON.parse(fs.readFileSync(claudeUsageFile, 'utf8'));
      res.end(JSON.stringify(data));
    } catch {
      res.end(JSON.stringify({ error: 'No usage data. Run scrape-claude-usage.sh first.' }));
    }
    return;
  }
  if (req.url === '/api/response-time') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ avgSeconds: getAvgResponseTime() }));
    return;
  }
  if (req.url.startsWith('/api/logs?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const allowedServices = ['openclaw', 'agent-dashboard', 'tailscaled', 'sshd', 'nginx'];
      const service = params.get('service') || 'openclaw';
      if (!allowedServices.includes(service)) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Invalid service name');
        return;
      }
      const lines = Math.min(Math.max(parseInt(params.get('lines')) || 100, 1), 1000);
      const { execSync } = require('child_process');
      const logs = execSync(`journalctl -u ${service} --no-pager -n ${lines} -o short 2>/dev/null || echo "No logs available"`, { encoding: 'utf8', timeout: 10000 });
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
      res.end(logs);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error fetching logs');
    }
    return;
  }
  if (req.url === '/api/action/restart-openclaw' && req.method === 'POST') {
    try {
      const { exec } = require('child_process');
      exec('systemctl restart openclaw', (err) => {});
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/action/restart-dashboard' && req.method === 'POST') {
    try {
      const { exec } = require('child_process');
      setTimeout(() => {
        exec('systemctl restart agent-dashboard', (err) => {});
      }, 2000);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, message: 'Restarting in 2 seconds...' }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/action/clear-cache' && req.method === 'POST') {
    try {
      costCache = null;
      usageCache = null;
      costCacheTime = 0;
      usageCacheTime = 0;
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/action/restart-tailscale' && req.method === 'POST') {
    exec('systemctl restart tailscaled', (err) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, error: err?.message }));
    });
    return;
  }
  if (req.url === '/api/action/update-openclaw' && req.method === 'POST') {
    exec('npm update -g openclaw', { timeout: 120000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, output: stdout?.trim(), error: err?.message }));
    });
    return;
  }
  if (req.url === '/api/action/kill-tmux' && req.method === 'POST') {
    exec('tmux kill-server 2>/dev/null; echo ok', (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }
  if (req.url === '/api/action/gc' && req.method === 'POST') {
    const projDir = path.join(WORKSPACE_DIR, 'projects');
    exec(`if [ -d "${projDir}" ]; then for d in ${projDir}/*/; do cd "$d" && git gc --quiet 2>/dev/null; done; fi; cd ${WORKSPACE_DIR} && git gc --quiet 2>/dev/null; echo ok`, (err) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }
  if (req.url === '/api/action/check-update' && req.method === 'POST') {
    exec('npm outdated -g openclaw 2>/dev/null || echo "up to date"', { timeout: 30000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, output: (stdout || '').trim() || 'All packages up to date' }));
    });
    return;
  }
  if (req.url === '/api/action/sys-update' && req.method === 'POST') {
    exec('apt update -qq && apt upgrade -y -qq 2>&1 | tail -5', { timeout: 300000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, output: (stdout || '').trim(), error: err?.message }));
    });
    return;
  }
  if (req.url === '/api/action/disk-cleanup' && req.method === 'POST') {
    exec('apt autoremove -y -qq 2>/dev/null; apt clean 2>/dev/null; journalctl --vacuum-time=7d 2>/dev/null; echo "Cleanup done"', { timeout: 60000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: true, output: (stdout || '').trim() }));
    });
    return;
  }
  if (req.url === '/api/action/restart-claude' && req.method === 'POST') {
    exec(`tmux kill-session -t claude-persistent 2>/dev/null; sleep 1; tmux new-session -d -s claude-persistent -x 200 -y 60 && tmux send-keys -t claude-persistent "cd ${WORKSPACE_DIR} && claude" Enter && echo "Claude session started"`, { timeout: 20000 }, (err, stdout) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ success: !err, output: (stdout || '').trim() }));
    });
    return;
  }
  if (req.url === '/api/tailscale') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const { execSync } = require('child_process');
      const statusJson = execSync('tailscale status --json 2>/dev/null', { encoding: 'utf8', timeout: 5000 });
      const status = JSON.parse(statusJson);
      const self = status.Self || {};
      const peers = Object.values(status.Peer || {}).filter(p => p.Online).length;
      let routes = [];
      try {
        const serveStatus = execSync('tailscale serve status 2>/dev/null', { encoding: 'utf8', timeout: 3000 });
        if (serveStatus && !serveStatus.includes('No serve config')) {
          routes = serveStatus.split('\n').filter(l => l.includes('http')).map(l => l.trim());
        }
      } catch {}
      res.end(JSON.stringify({
        hostname: self.HostName || 'unknown',
        ip: self.TailscaleIPs?.[0] || 'unknown',
        online: self.Online || false,
        peers,
        routes
      }));
    } catch (e) {
      res.end(JSON.stringify({ error: 'Tailscale not available', hostname: '--', ip: '--', online: false, peers: 0, routes: [] }));
    }
    return;
  }
  if (req.url === '/api/lifetime-stats') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    try {
      const now = Date.now();
      const cacheKey = 'lifetimeStats';
      const cacheTime = global[cacheKey + 'Time'] || 0;
      if (global[cacheKey] && now - cacheTime < 300000) {
        res.end(JSON.stringify(global[cacheKey]));
        return;
      }
      const files = fs.readdirSync(sessDir).filter(f => f.endsWith('.jsonl'));
      let totalTokens = 0, totalMessages = 0, totalCost = 0, totalSessions = files.length;
      let firstSessionDate = null;
      const activeDays = new Set();
      for (const file of files) {
        const lines = fs.readFileSync(path.join(sessDir, file), 'utf8').split('\n');
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const d = JSON.parse(line);
            if (d.type !== 'message') continue;
            totalMessages++;
            const msg = d.message;
            if (msg?.usage) {
              const inTok = (msg.usage.input || 0) + (msg.usage.cacheRead || 0) + (msg.usage.cacheWrite || 0);
              const outTok = msg.usage.output || 0;
              totalTokens += inTok + outTok;
              totalCost += msg.usage.cost?.total || 0;
            }
            if (d.timestamp) {
              const ts = new Date(d.timestamp).getTime();
              if (!firstSessionDate || ts < firstSessionDate) firstSessionDate = ts;
              const day = d.timestamp.substring(0, 10);
              activeDays.add(day);
            }
          } catch {}
        }
      }
      const result = {
        totalTokens,
        totalMessages,
        totalCost: Math.round(totalCost * 100) / 100,
        totalSessions,
        firstSessionDate,
        daysActive: activeDays.size
      };
      global[cacheKey] = result;
      global[cacheKey + 'Time'] = now;
      res.end(JSON.stringify(result));
    } catch (e) {
      res.end(JSON.stringify({ totalTokens: 0, totalMessages: 0, totalCost: 0, totalSessions: 0, firstSessionDate: null, daysActive: 0 }));
    }
    return;
  }
  if (req.url === '/api/health-history') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(healthHistory));
    return;
  }
  if (req.url === '/api/memory-files') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(getMemoryFiles()));
    return;
  }
  if (req.url.startsWith('/api/memory-file?')) {
    try {
      const params = new URL(req.url, 'http://localhost').searchParams;
      const fname = params.get('path') || '';
      let fpath = '';
      if (fname === 'MEMORY.md') fpath = memoryMdPath;
      else if (fname === 'HEARTBEAT.md') fpath = heartbeatPath;
      else if (fname.startsWith('memory/') && !fname.includes('..')) fpath = path.join(WORKSPACE_DIR, fname);
      else throw new Error('Invalid path');
      
      if (fs.existsSync(fpath)) {
        const content = fs.readFileSync(fpath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' });
        res.end(content);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('File not found');
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
    }
    return;
  }
  if (req.url.startsWith('/api/cron/') && req.method === 'POST') {
    try {
      const parts = req.url.split('/');
      const action = parts[parts.length - 1];
      const id = parts[parts.length - 2].replace(/[^a-zA-Z0-9\-_]/g, '');
      if (!id) { res.writeHead(400); res.end('Invalid id'); return; }
      
      if (action === 'toggle') {
        const { execSync } = require('child_process');
        if (!fs.existsSync(cronFile)) throw new Error('No cron file');
        const data = JSON.parse(fs.readFileSync(cronFile, 'utf8'));
        const job = (data.jobs || []).find(j => j.id === id);
        if (!job) throw new Error('Job not found');
        job.enabled = !job.enabled;
        fs.writeFileSync(cronFile, JSON.stringify(data, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true, enabled: job.enabled }));
      } else if (action === 'run') {
        const { exec } = require('child_process');
        exec(`openclaw cron run ${id}`, { timeout: 60000 }, (err) => {});
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  if (req.url === '/api/live') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });
    
    liveClients.push(res);
    startLiveWatcher();
    
    res.write('data: {"status":"connected"}\n\n');
    
    try {
      // Only backfill from recently modified sessions (last 1h)
      const cutoff = Date.now() - 3600000;
      const files = fs.readdirSync(sessDir).filter(f => {
        if (!f.endsWith('.jsonl')) return false;
        try { return fs.statSync(path.join(sessDir, f)).mtimeMs > cutoff; } catch { return false; }
      });
      const recentEvents = [];
      files.forEach(file => {
        const sessionKey = file.replace('.jsonl', '');
        const content = fs.readFileSync(path.join(sessDir, file), 'utf8');
        const lines = content.split('\n').filter(l => l.trim());
        lines.slice(-5).forEach(line => {
          try {
            const data = JSON.parse(line);
            data._sessionKey = sessionKey;
            const event = formatLiveEvent(data);
            if (event) recentEvents.push(event);
          } catch {}
        });
      });
      recentEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
      recentEvents.slice(0, 20).forEach(event => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      });
    } catch {}
    
    req.on('close', () => {
      liveClients = liveClients.filter(client => client !== res);
      if (liveClients.length === 0) {
        if (liveWatcher) { try { liveWatcher.close(); } catch {} liveWatcher = null; }
        Object.keys(_fileWatchers).forEach(k => { try { _fileWatchers[k].close(); } catch {} delete _fileWatchers[k]; });
      }
    });
    
    return;
  }
  try {
    const html = fs.readFileSync(htmlPath, 'utf8');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch (e) {
    res.writeHead(500);
    res.end('Error loading dashboard');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Dashboard: http://0.0.0.0:' + PORT);
  // Usage scrape on-demand only (triggered via API)
});
