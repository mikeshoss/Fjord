const express = require('express');
const crypto = require('crypto');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const {
  GITHUB_TOKEN,
  GITHUB_ORG = 'CasewareProduct',
  COOLIFY_URL = 'http://coolify:8080',
  COOLIFY_TOKEN,
  ANTHROPIC_API_KEY,
  BASE_DEPLOY_DOMAIN = 'caseware.steadypat.ch',
  PORT = 4000,
  SESSION_SECRET = crypto.randomBytes(32).toString('hex'),
  ADMIN_EMAILS = '',
} = process.env;

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// --- Sessions (in-memory) ---

const sessions = new Map(); // sessionId → { email, username, displayName, initials, isAdmin }

function createSession(user) {
  const id = crypto.randomBytes(32).toString('hex');
  sessions.set(id, { ...user, createdAt: Date.now() });
  return id;
}

function getSession(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/fjord_session=([a-f0-9]+)/);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

// Parse admin emails list
const adminEmails = ADMIN_EMAILS.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

// --- Helpers ---

function sanitize(str) {
  return str.toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function deriveUser(email) {
  const local = email.split('@')[0] || '';
  const username = local.split('.')[0].toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'unknown';
  const displayName = local || 'unknown';
  const initials = displayName.split('.').map(p => p[0]?.toUpperCase() || '').join('').slice(0, 2) || '??';
  const isAdmin = adminEmails.includes(email.toLowerCase());
  return { email, username, displayName, initials, isAdmin };
}

function parseRepoUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/\s]+)/);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, '');
  return { owner, repo };
}

async function githubAPI(method, endpoint, body) {
  const url = `https://api.github.com${endpoint}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${endpoint}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function coolifyAPI(method, endpoint, body) {
  const url = `${COOLIFY_URL}${endpoint}`;
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${COOLIFY_TOKEN}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`Coolify ${method} ${endpoint}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

// Cache Coolify team members (refresh every 5 minutes)
let teamMembersCache = null;
let teamMembersCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000;

async function getCoolifyTeamMembers() {
  if (teamMembersCache && Date.now() - teamMembersCacheTime < CACHE_TTL) {
    return teamMembersCache;
  }
  const members = await coolifyAPI('GET', '/api/v1/teams/current/members');
  teamMembersCache = Array.isArray(members) ? members : [];
  teamMembersCacheTime = Date.now();
  return teamMembersCache;
}

// --- Auth routes (no middleware) ---

app.post('/api/login', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  try {
    const members = await getCoolifyTeamMembers();
    const found = members.find(m => m.email?.toLowerCase() === email.toLowerCase());

    if (!found) {
      return res.status(403).json({ error: 'Not a team member. Ask your admin to add you in Coolify.' });
    }

    const user = deriveUser(email);
    const sessionId = createSession(user);

    res.setHeader('Set-Cookie', `fjord_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Could not verify team membership. Is Coolify reachable?' });
  }
});

app.post('/api/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'fjord_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// --- Auth middleware (everything below requires login) ---

function requireAuth(req, res, next) {
  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not logged in' });
  }
  req.user = session;
  next();
}

// Serve frontend (no auth — the page itself handles login state)
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.get('/deploy', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Static files from frontend directory
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// All /api/* routes below require auth
app.use('/api', requireAuth);

// --- API: Me ---

app.get('/api/me', (req, res) => {
  res.json(req.user);
});

// --- API: Deploy ---

app.post('/api/deploy', async (req, res) => {
  // SSE setup
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function sendLog(message, type = 'info') {
    send({ type: 'log', message, logType: type });
  }

  function sendStep(step, status) {
    send({ type: 'step', step, status });
  }

  try {
    const { repoUrl, envVars } = req.body;
    if (!repoUrl) {
      send({ type: 'error', message: 'Missing repo URL' });
      return res.end();
    }

    const parsed = parseRepoUrl(repoUrl);
    if (!parsed) {
      send({ type: 'error', message: 'Invalid GitHub URL' });
      return res.end();
    }

    const { repo } = parsed;

    // Use logged-in user's username for project naming
    const username = req.user.username;

    // Step 1: Verify repo and derive project name
    sendStep('github', 'active');
    sendLog(`Fetching repo: ${GITHUB_ORG}/${repo}`, 'info');

    try {
      await githubAPI('GET', `/repos/${GITHUB_ORG}/${repo}`);
    } catch (err) {
      send({ type: 'error', message: `Repository not found: ${GITHUB_ORG}/${repo}` });
      return res.end();
    }

    const repoName = sanitize(repo);
    const projectName = `${username}-${repoName}`;

    sendLog(`Project name: ${projectName}`);
    sendStep('github', 'done');

    // Step 2: Fetch file tree and config files
    sendStep('claude', 'active');
    sendLog(`Analyzing file tree...`);

    const tree = await githubAPI('GET', `/repos/${GITHUB_ORG}/${repo}/git/trees/HEAD?recursive=1`);
    const filePaths = tree.tree.filter(f => f.type === 'blob').map(f => f.path);
    sendLog(`Found ${filePaths.length} files`);

    // Read key config files
    const configFileNames = [
      'package.json',
      'requirements.txt',
      'go.mod',
      'Pipfile',
      'pom.xml',
      'Gemfile',
      'Cargo.toml',
      'composer.json',
    ];
    const configFiles = {};
    for (const name of configFileNames) {
      if (filePaths.includes(name)) {
        try {
          const file = await githubAPI('GET', `/repos/${GITHUB_ORG}/${repo}/contents/${name}`);
          configFiles[name] = Buffer.from(file.content, 'base64').toString('utf-8');
        } catch {
          // Skip unreadable files
        }
      }
    }

    const configFileList = Object.keys(configFiles).join(', ') || 'none';
    sendLog(`Config files: ${configFileList}`);

    // Step 3: Claude stack detection
    sendLog('Detecting stack with Claude...');

    const fileTree = filePaths.join('\n');
    const configContent = Object.entries(configFiles)
      .map(([name, content]) => `--- ${name} ---\n${content}`)
      .join('\n\n');

    const claudePrompt = `You are analyzing a GitHub repository to generate a production Dockerfile.

File tree:
${fileTree}

Key config files found:
${configContent || 'none'}

Rules:
- Output ONLY a valid Dockerfile, nothing else
- No markdown, no explanation, no backticks
- Use the smallest appropriate base image (alpine where possible)
- Expose the correct port
- Use production start commands — never dev servers
- If you cannot determine the stack with confidence: output exactly UNKNOWN`;

    const claudeRes = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: claudePrompt }],
    });

    const dockerfile = claudeRes.content[0].text.trim();

    if (dockerfile === 'UNKNOWN') {
      sendStep('claude', 'done');
      send({
        type: 'error',
        message:
          "We couldn't automatically detect your project's stack. Slack Mike with your repo URL and he'll get you set up within the hour.",
      });
      return res.end();
    }

    sendLog('Stack detected', 'success');
    sendStep('claude', 'done');

    // Step 4: Commit Dockerfile to coolify-deploy branch
    sendStep('dockerfile', 'active');
    sendLog('Committing Dockerfile to coolify-deploy branch...');

    // Get default branch SHA
    const mainRef = await githubAPI('GET', `/repos/${GITHUB_ORG}/${repo}/git/ref/heads/main`).catch(
      () => githubAPI('GET', `/repos/${GITHUB_ORG}/${repo}/git/ref/heads/master`)
    );
    const baseSha = mainRef.object.sha;

    // Create or update coolify-deploy branch
    try {
      await githubAPI('POST', `/repos/${GITHUB_ORG}/${repo}/git/refs`, {
        ref: 'refs/heads/coolify-deploy',
        sha: baseSha,
      });
    } catch {
      // Branch may exist — update it
      await githubAPI('PATCH', `/repos/${GITHUB_ORG}/${repo}/git/refs/heads/coolify-deploy`, {
        sha: baseSha,
        force: true,
      });
    }

    // Check if Dockerfile exists on the branch
    let existingSha;
    try {
      const existing = await githubAPI(
        'GET',
        `/repos/${GITHUB_ORG}/${repo}/contents/Dockerfile?ref=coolify-deploy`
      );
      existingSha = existing.sha;
    } catch {
      // Doesn't exist yet
    }

    const commitBody = {
      message: 'chore: add production Dockerfile via Fjord',
      content: Buffer.from(dockerfile).toString('base64'),
      branch: 'coolify-deploy',
    };
    if (existingSha) commitBody.sha = existingSha;

    await githubAPI('PUT', `/repos/${GITHUB_ORG}/${repo}/contents/Dockerfile`, commitBody);
    sendLog('Dockerfile committed to coolify-deploy', 'success');

    // Open PR
    sendLog('Opening PR: coolify-deploy → main...');
    try {
      await githubAPI('POST', `/repos/${GITHUB_ORG}/${repo}/pulls`, {
        title: 'chore: add production Dockerfile via Fjord',
        head: 'coolify-deploy',
        base: 'main',
        body: `Auto-generated Dockerfile by Fjord deployment portal.\n\nProject: ${projectName}\nDomain: ${BASE_DEPLOY_DOMAIN}/${projectName}`,
      });
      sendLog('PR opened', 'success');
    } catch (err) {
      // PR may already exist
      if (err.message.includes('422')) {
        sendLog('PR already exists, continuing...', 'warn');
      } else {
        throw err;
      }
    }

    sendStep('dockerfile', 'done');

    // Step 5-7: Coolify project + application setup
    sendStep('coolify', 'active');
    sendLog(`Creating Coolify project: ${projectName}...`);

    const project = await coolifyAPI('POST', '/api/v1/projects', {
      name: projectName,
    });
    const projectId = project.uuid;
    sendLog(`Coolify project created: ${projectId}`, 'success');

    // Create application from private GitHub repo
    sendLog('Creating Coolify application...');
    const application = await coolifyAPI('POST', '/api/v1/applications/private', {
      project_uuid: projectId,
      repository: `${GITHUB_ORG}/${repo}`,
      branch: 'coolify-deploy',
      type: 'dockerfile',
    });
    const appId = application.uuid;

    // Configure domain and env vars
    sendLog(`Configuring domain: ${BASE_DEPLOY_DOMAIN}/${projectName}...`);
    const patchBody = {
      fqdn: `https://${BASE_DEPLOY_DOMAIN}/${projectName}`,
    };

    await coolifyAPI('PATCH', `/api/v1/applications/${appId}`, patchBody);

    // Inject env vars if provided
    if (envVars && envVars.trim()) {
      const lines = envVars.trim().split('\n');
      for (const line of lines) {
        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;
        const key = line.substring(0, eqIdx).trim();
        const value = line.substring(eqIdx + 1).trim();
        if (key) {
          try {
            await coolifyAPI('POST', `/api/v1/applications/${appId}/envs`, {
              key,
              value,
              is_build_time: false,
            });
          } catch {
            sendLog(`Warning: failed to set env var ${key}`, 'warn');
          }
        }
      }
      sendLog('Environment variables configured', 'success');
    }

    sendStep('coolify', 'done');

    // Step 8: Trigger deploy
    sendStep('live', 'active');
    sendLog('Starting deployment...', 'info');
    await coolifyAPI('POST', `/api/v1/applications/${appId}/start`);
    sendLog('Build started', 'success');

    // Step 9-10: Poll for status
    sendLog('Waiting for build to complete...');
    let healthy = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const status = await coolifyAPI('GET', `/api/v1/applications/${appId}`);
        if (status.status === 'running') {
          healthy = true;
          break;
        }
        if (status.status === 'exited' || status.status === 'error') {
          sendLog(`Build failed with status: ${status.status}`, 'warn');
          send({ type: 'error', message: 'Deployment failed. Check logs for details.' });
          return res.end();
        }
      } catch {
        // Keep polling
      }
    }

    if (!healthy) {
      send({ type: 'error', message: 'Deployment timed out after 5 minutes.' });
      return res.end();
    }

    const liveUrl = `https://${BASE_DEPLOY_DOMAIN}/${projectName}`;
    sendLog(`Health check passed`, 'success');
    sendLog(`Live: ${liveUrl}`, 'success');
    sendStep('live', 'done');
    send({ type: 'complete', url: liveUrl, projectName });
    res.end();
  } catch (err) {
    send({ type: 'error', message: err.message });
    res.end();
  }
});

// --- API: Projects ---

app.get('/api/projects', async (req, res) => {
  try {
    const projects = await coolifyAPI('GET', '/api/v1/projects');
    let apps = [];

    for (const project of projects) {
      try {
        const detail = await coolifyAPI('GET', `/api/v1/projects/${project.uuid}`);
        if (detail.applications) {
          for (const app of detail.applications) {
            apps.push({
              id: app.uuid,
              name: project.name,
              status: app.status === 'running' ? 'live' : app.status === 'building' ? 'building' : 'down',
              url: `https://${BASE_DEPLOY_DOMAIN}/${project.name}`,
              lastDeployed: app.updated_at,
              branch: app.branch || 'main',
            });
          }
        }
      } catch {
        // Skip projects we can't read
      }
    }

    // Filter by username if provided
    const { username } = req.query;
    if (username) {
      const prefix = sanitize(username) + '-';
      apps = apps.filter((a) => a.name.startsWith(prefix));
    }

    res.json(apps);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Redeploy ---

app.post('/api/projects/:id/redeploy', async (req, res) => {
  try {
    await coolifyAPI('POST', `/api/v1/applications/${req.params.id}/start`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Logs ---

app.get('/api/projects/:id/logs', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  try {
    const logs = await coolifyAPI('GET', `/api/v1/applications/${req.params.id}/logs`);
    const lines = Array.isArray(logs) ? logs : [logs];
    for (const line of lines) {
      res.write(`data: ${JSON.stringify({ type: 'log', message: typeof line === 'string' ? line : JSON.stringify(line) })}\n\n`);
    }
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.end();
});

// --- Start ---

app.listen(PORT, () => {
  console.log(`Fjord running on port ${PORT}`);
});
