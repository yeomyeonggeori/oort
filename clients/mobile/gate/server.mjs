/**
 * The gate's two servers: a mock oort API and a control channel.
 *
 * Zero dependencies, same rule `measure/origin-stub.mjs` follows — a gate that
 * needs an install step is a gate people stop running.
 *
 * ## Why two servers on two ports
 *
 * The `restore-offline` step needs the API to be UNREACHABLE while the harness
 * is still able to say what it observed. One socket cannot be both, so the
 * control channel lives on its own port and stays up throughout.
 *
 * ## Why `dead` destroys the connection instead of closing the listener
 *
 * Closing the listener frees the port, and re-binding it later is a race this
 * gate would lose at random — which would arrive as a flaky gate, and flaky
 * gates get disabled. Destroying the accepted socket produces the same thing
 * the client is being tested against: a transport failure with no HTTP response,
 * on a port that never moves.
 */
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';

const MEMBER = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: '22222222-2222-4222-8222-222222222222',
  kind: 'human',
  displayName: 'Gate Runner',
  handle: 'gate-runner',
};

const CREDENTIALS = {email: 'gate@oort.invalid', password: 'gate-password'};

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

export async function startGateServers() {
  const state = {
    runId: randomUUID(),
    step: 'login',
    /** `up` answers, `reject` refuses the refresh token, `dead` kills the socket. */
    apiMode: 'up',
    accessToken: null,
    refreshToken: null,
    /** Every request the API actually received, tagged with the step it arrived in. */
    requests: [],
    waiter: null,
  };

  const api = createServer(async (req, res) => {
    state.requests.push({step: state.step, method: req.method, url: req.url});
    if (req.method !== 'POST') {
      json(res, 404, {error: {message: 'not found'}});
      return;
    }
    let body;
    try {
      body = await readBody(req);
    } catch {
      json(res, 400, {error: {message: 'bad json'}});
      return;
    }

    if (req.url === '/v1/auth/login') {
      if (body.email !== CREDENTIALS.email || body.password !== CREDENTIALS.password) {
        json(res, 401, {error: {message: 'bad credentials'}});
        return;
      }
      state.accessToken = `access-${randomUUID()}`;
      state.refreshToken = `refresh-${randomUUID()}`;
      json(res, 200, {
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        realtimeWebSocketUrl: `ws://127.0.0.1:${api.address().port}/connection/websocket`,
        member: MEMBER,
      });
      return;
    }

    if (req.url === '/v1/auth/refresh') {
      if (state.apiMode === 'reject') {
        json(res, 401, {error: {message: 'refresh token revoked'}});
        return;
      }
      // Single-use rotation, enforced (MOMO-300): presenting anything but the
      // live token is the same thing a revoked token is, and the client must not
      // be allowed to pass this gate by replaying one.
      if (typeof body.refreshToken !== 'string' || body.refreshToken !== state.refreshToken) {
        json(res, 401, {error: {message: 'stale refresh token'}});
        return;
      }
      state.accessToken = `access-${randomUUID()}`;
      state.refreshToken = `refresh-${randomUUID()}`;
      json(res, 200, {
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
      });
      return;
    }

    json(res, 404, {error: {message: 'not found'}});
  });

  api.on('connection', socket => {
    if (state.apiMode === 'dead') {
      socket.destroy();
    }
  });

  const control = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/__gate/plan') {
      json(res, 200, {
        runId: state.runId,
        step: state.step,
        apiBase: `http://127.0.0.1:${api.address().port}`,
        email: CREDENTIALS.email,
        password: CREDENTIALS.password,
        expectRefreshToken: state.refreshToken,
        expectHandle: MEMBER.handle,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/__gate/report') {
      let body;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, {error: {message: 'bad json'}});
        return;
      }
      json(res, 200, {received: true});
      if (state.waiter && body.step === state.waiter.step) {
        state.waiter.resolve(body);
        state.waiter = null;
      }
      return;
    }
    json(res, 404, {error: {message: 'not found'}});
  });

  const apiPort = await listen(api);
  const controlPort = await listen(control);

  return {
    state,
    apiBase: `http://127.0.0.1:${apiPort}`,
    controlBase: `http://127.0.0.1:${controlPort}`,
    member: MEMBER,
    /**
     * Resolve when the app reports on `step`, or reject at `timeoutMs`.
     *
     * A hard bound, not a retry: a step that has not answered in time has failed,
     * and stretching the wait until it passes is how a gate stops meaning
     * anything.
     */
    waitForReport(step, timeoutMs) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          state.waiter = null;
          reject(new Error(`step ${step} sent no verdict within ${timeoutMs}ms`));
        }, timeoutMs);
        state.waiter = {
          step,
          resolve: value => {
            clearTimeout(timer);
            resolve(value);
          },
        };
      });
    },
    close() {
      api.close();
      control.close();
      api.closeAllConnections?.();
      control.closeAllConnections?.();
    },
  };
}
