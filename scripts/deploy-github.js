const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('../src/backend/config');

getConfig();

const ROOT_DIR = path.resolve(__dirname, '..');

const IGNORED_DIRS = new Set(['node_modules', '.git', 'data', '.gemini']);
const IGNORED_FILES = new Set(['.env', 'test_luan_barber.db', 'luan_barber.db']);

function collectFiles(dir, baseRel = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.git')) continue;
    const relPath = baseRel ? `${baseRel}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      files.push(...collectFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      if (IGNORED_FILES.has(entry.name)) continue;
      if (
        entry.name.endsWith('.db') ||
        entry.name.endsWith('.db-wal') ||
        entry.name.endsWith('.db-shm')
      ) {
        continue;
      }
      files.push({
        path: relPath,
        content: fs.readFileSync(fullPath, 'utf8')
      });
    }
  }
  return files;
}

function parseRepoSlug(rawRepo) {
  if (!rawRepo) return '';
  return rawRepo
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/$/, '');
}

async function githubRequest(endpoint, token, { method = 'GET', body = null } = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Luan-Barber-AutoDeploy'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Erro GitHub API (${res.status}): ${errText}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function resolveRepoSlug(token) {
  const configured = parseRepoSlug(process.env.GITHUB_REPO);
  if (configured) return configured;

  const repos = await githubRequest('/user/repos?sort=updated&per_page=20', token);
  const match =
    repos.find((r) => /luan|barber/i.test(r.name)) || repos[0];
  if (!match) {
    throw new Error('Nenhum repositório encontrado na sua conta do GitHub.');
  }
  return match.full_name;
}

async function deployToGitHub() {
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (!token) {
    console.error('Erro: GITHUB_TOKEN não configurado no arquivo .env.');
    process.exit(1);
  }

  const repoSlug = await resolveRepoSlug(token);
  const repoInfo = await githubRequest(`/repos/${repoSlug}`, token);
  const branch = (process.env.GITHUB_BRANCH || repoInfo.default_branch || 'main').trim();

  console.log(`Enviando atualizações para o GitHub (${repoSlug} -> branch ${branch})...`);
  const files = collectFiles(ROOT_DIR);

  let latestCommitSha = null;
  let baseTreeSha = null;

  try {
    const refData = await githubRequest(
      `/repos/${repoSlug}/git/ref/heads/${branch}`,
      token
    );
    latestCommitSha = refData.object.sha;
    const commitData = await githubRequest(
      `/repos/${repoSlug}/git/commits/${latestCommitSha}`,
      token
    );
    baseTreeSha = commitData.tree.sha;
  } catch (err) {
    // Se o repositório estiver vazio (sem commits ainda), inicializa com o README.md via Contents API
    if (err.status === 404 || err.status === 409) {
      console.log('Repositório vazio detectado. Inicializando branch principal...');
      const readmeContent = Buffer.from('# Luan Barber\n').toString('base64');
      await githubRequest(`/repos/${repoSlug}/contents/README.md`, token, {
        method: 'PUT',
        body: {
          message: 'Commit inicial Luan Barber',
          content: readmeContent,
          branch
        }
      });
      const refData = await githubRequest(
        `/repos/${repoSlug}/git/ref/heads/${branch}`,
        token
      );
      latestCommitSha = refData.object.sha;
      const commitData = await githubRequest(
        `/repos/${repoSlug}/git/commits/${latestCommitSha}`,
        token
      );
      baseTreeSha = commitData.tree.sha;
    } else {
      throw err;
    }
  }

  const treeItems = files.map((f) => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    content: f.content
  }));

  const newTree = await githubRequest(`/repos/${repoSlug}/git/trees`, token, {
    method: 'POST',
    body: {
      base_tree: baseTreeSha,
      tree: treeItems
    }
  });

  const commitMessage =
    process.argv[2] ||
    `Atualização Luan Barber (${new Date().toLocaleString('pt-BR')})`;

  const newCommit = await githubRequest(`/repos/${repoSlug}/git/commits`, token, {
    method: 'POST',
    body: {
      message: commitMessage,
      tree: newTree.sha,
      parents: [latestCommitSha]
    }
  });

  await githubRequest(`/repos/${repoSlug}/git/refs/heads/${branch}`, token, {
    method: 'PATCH',
    body: {
      sha: newCommit.sha,
      force: true
    }
  });

  console.log('============================================================');
  console.log('SUCESSO! Código enviado para o GitHub!');
  console.log(`Repositório: https://github.com/${repoSlug}`);
  console.log(`Commit:      ${newCommit.sha.slice(0, 7)} — ${commitMessage}`);
  console.log('O Render atualizará o seu link online automaticamente em instantes.');
  console.log('============================================================');
}

deployToGitHub().catch((err) => {
  console.error('Falha ao atualizar GitHub:', err.message);
  process.exit(1);
});
