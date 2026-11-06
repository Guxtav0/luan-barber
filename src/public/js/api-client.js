const ApiClient = {
  getToken() {
    return localStorage.getItem('luan_admin_token') || '';
  },

  setToken(token) {
    if (token) {
      localStorage.setItem('luan_admin_token', token);
    } else {
      localStorage.removeItem('luan_admin_token');
    }
  },

  async request(path, { method = 'GET', body = null } = {}) {
    const headers = {
      'Content-Type': 'application/json'
    };
    const token = this.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    let res;
    try {
      res = await fetch(path, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined
      });
    } catch {
      // Segunda tentativa rápida caso o navegador tenha oscilado
      await new Promise((r) => setTimeout(r, 250));
      try {
        res = await fetch(path, {
          method,
          headers,
          body: body !== null ? JSON.stringify(body) : undefined
        });
      } catch {
        const netErr = new Error(
          'Servidor desconectado. Execute o arquivo start.bat para manter o servidor ativo.'
        );
        netErr.status = 0;
        throw netErr;
      }
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Erro na requisição (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      err.conflicts = data.conflicts;
      throw err;
    }
    return data;
  },

  get(path) {
    return this.request(path, { method: 'GET' });
  },

  post(path, body) {
    return this.request(path, { method: 'POST', body });
  },

  put(path, body) {
    return this.request(path, { method: 'PUT', body });
  },

  delete(path) {
    return this.request(path, { method: 'DELETE' });
  }
};

window.ApiClient = ApiClient;
