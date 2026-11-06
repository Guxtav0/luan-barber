const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { getConfig } = require('./backend/config');
const { getDb } = require('./backend/db');
const { handleApiRequest } = require('./backend/routes/api');

const PUBLIC_DIR = path.resolve(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Página não encontrada.');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  const content = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-cache'
  });
  res.end(content);
}

function createAppServer() {
  getDb();

  return http.createServer(async (req, res) => {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = parsedUrl.pathname;

      if (pathname.startsWith('/api/')) {
        return await handleApiRequest(req, res);
      }

      if (pathname === '/' || pathname === '/index.html') {
        return serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'));
      }

      if (pathname === '/admin' || pathname === '/admin/' || pathname === '/admin.html') {
        return serveStaticFile(res, path.join(PUBLIC_DIR, 'admin.html'));
      }

      if (pathname.startsWith('/agendamento/') || pathname === '/manage.html') {
        return serveStaticFile(res, path.join(PUBLIC_DIR, 'manage.html'));
      }

      const safeRelPath = path.normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
      const candidatePath = path.join(PUBLIC_DIR, safeRelPath);
      if (candidatePath.startsWith(PUBLIC_DIR) && fs.existsSync(candidatePath)) {
        return serveStaticFile(res, candidatePath);
      }

      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404 — Página não encontrada</h1><p><a href="/">Voltar para Luan Barber</a></p>');
    } catch (err) {
      console.error('Erro inesperado na requisição:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Erro interno no servidor.' }));
      }
    }
  });
}

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
  });
  process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err);
  });

  const config = getConfig();
  const server = createAppServer();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`O servidor Luan Barber já está em execução na porta ${config.port}!`);
      process.exit(0);
    } else {
      console.error('Erro no servidor:', err);
    }
  });

  server.listen(config.port, () => {
    console.log('============================================================');
    console.log(`LUAN BARBER — Servidor iniciado com sucesso!`);
    console.log(`Área Pública (Cliente):       http://localhost:${config.port}/`);
    console.log(`Painel Administrativo (Luan): http://localhost:${config.port}/admin`);
    console.log('============================================================');
  });
}

module.exports = { createAppServer };
