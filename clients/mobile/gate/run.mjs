#!/usr/bin/env node
/**
 * `npm run gate:session` — does a session actually survive a restart?
 *
 * The gate this repo did not have. `build:sim` proves the app compiles;
 * `jest` proves the decisions are right against a MOCKED keychain. Neither can
 * see the failure RN-C3 measured on a real simulator: an unsigned build has no
 * entitlements, every keychain call fails with errSecMissingEntitlement
 * (-34018), `secureSession.ts` swallows that by design, and the app quietly
 * signs the person out on every launch while the whole suite stays green.
 *
 * So this drives the real app, on a real simulator, across REAL relaunches:
 *
 *   1. login              a fresh device signs in; the refresh token lands in
 *                         the keychain (and the raw OSStatus is reported)
 *   2. restore-online     new process: the session comes back and rotates
 *   3. restore-offline    new process, server unreachable: the credentials
 *                         must survive (the live defect fixed in 844407fb)
 *   4. restore-rejected   new process, server refuses: the credentials must be
 *                         erased and the app must land on sign-in
 *   5. signed-out-sticks  new process: the erasure survived the restart too
 *
 * Every step is its own `simctl launch`, because "survives a restart" cannot be
 * asserted without restarting.
 *
 * Usage:
 *   npm run gate:session               build, then run
 *   npm run gate:session -- --no-build reuse the app already in build/sim
 *   npm run gate:session -- --device "iPhone 17"
 */
import {execFileSync, spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startGateServers} from './server.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE_ID = 'app.momo.ios';
const APP_PATH = join(APP_ROOT, 'build/sim/Build/Products/Debug-iphonesimulator/MomoMobile.app');
const METRO_PORT = 8081;
const BUILD_LOG = join(APP_ROOT, 'build/gate-build.log');

/**
 * One hard bound per step. Generous enough for the first launch (which makes
 * Metro build the bundle) and fixed: a step that needs longer has failed, and
 * raising this number until it passes is the failure mode this gate exists to
 * avoid.
 */
const STEP_TIMEOUT_MS = 90_000;

const STEPS = [
  {step: 'login', apiMode: 'up'},
  {step: 'restore-online', apiMode: 'up'},
  {step: 'restore-offline', apiMode: 'dead'},
  {step: 'restore-rejected', apiMode: 'reject'},
  {step: 'signed-out-sticks', apiMode: 'up'},
];

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const deviceName = valueOf('--device') ?? 'iPhone 17 Pro';

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1];
}

function sh(file, argv, options = {}) {
  return execFileSync(file, argv, {encoding: 'utf8', ...options});
}

function since(start) {
  return `${((Date.now() - start) / 1000).toFixed(1)}s`;
}

// ---- simulator --------------------------------------------------------------

function pickDevice(name) {
  const listed = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'available', '--json']));
  for (const runtime of Object.keys(listed.devices).sort().reverse()) {
    const found = listed.devices[runtime].find(device => device.name === name);
    if (found) {
      return found;
    }
  }
  throw new Error(`no available simulator named ${name}`);
}

function bootDevice(device) {
  if (device.state !== 'Booted') {
    sh('xcrun', ['simctl', 'boot', device.udid]);
  }
  sh('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
}

// ---- metro ------------------------------------------------------------------

/**
 * Which checkout is serving this port, or null if nothing is.
 *
 * This is the question that mattered most while writing the gate: a Metro from
 * ANOTHER worktree answers on 8081 exactly like ours and serves that worktree's
 * JavaScript. The first run of this gate did exactly that — the app launched,
 * ran an `index.js` with no harness in it, and reported nothing — and every
 * worktree of this repo will have the gate once it lands, so the failure could
 * just as easily have been a PASS against the wrong tree.
 *
 * `@react-native-community/cli` answers it exactly rather than by inference:
 * its status middleware puts the project root in a response header.
 */
async function metroProjectRoot(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    if (!(await res.text()).includes('packager-status:running')) {
      return null;
    }
    return res.headers.get('x-react-native-project-root');
  } catch {
    return null;
  }
}

/** A port nothing is listening on right now. */
async function freePort() {
  const {createServer} = await import('node:net');
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const {port} = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startMetro(port) {
  // `node cli.js` rather than `npx react-native`: npx is a wrapper process, and
  // signalling the wrapper leaves the real Metro listening — which is how a
  // stale server from a previous run ends up serving the next one. `detached`
  // gives the whole tree one process group to kill.
  const child = spawn(
    process.execPath,
    [join(APP_ROOT, 'node_modules/react-native/cli.js'), 'start', '--port', String(port)],
    {cwd: APP_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true},
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if ((await metroProjectRoot(port)) === APP_ROOT) {
      return child;
    }
    if (child.exitCode !== null) {
      throw new Error(`metro exited with ${child.exitCode}`);
    }
    await new Promise(done => setTimeout(done, 400));
  }
  child.kill('SIGTERM');
  throw new Error(`metro did not come up on :${port} within 90s`);
}

/**
 * Reuse the developer's Metro when it is serving THIS checkout, otherwise start
 * our own on a port nobody is arguing over and tell the app where it is.
 *
 * Taking 8081 by force would end someone's dev loop to run a gate; failing
 * because 8081 is busy would make the gate the thing people stop running. The
 * app follows `RCT_jsLocation` (`RCTBundleURLProvider.mm`), which reads
 * NSUserDefaults — so a launch argument moves it, per launch, for this run only.
 */
async function ensureMetro() {
  if ((await metroProjectRoot(METRO_PORT)) === APP_ROOT) {
    return {child: null, port: METRO_PORT, reused: true};
  }
  const port = await freePort();
  return {child: await startMetro(port), port, reused: false};
}

// ---- one step ---------------------------------------------------------------

async function runStep(servers, device, spec, metroPort) {
  servers.state.step = spec.step;
  servers.state.apiMode = spec.apiMode;

  try {
    sh('xcrun', ['simctl', 'terminate', device.udid, BUNDLE_ID], {stdio: 'ignore'});
  } catch {
    // Not running is the state we want.
  }

  const console_ = [];
  const child = spawn('xcrun', [
    'simctl',
    'launch',
    '--console-pty',
    device.udid,
    BUNDLE_ID,
    '-momoSessionGate',
    spec.step,
    '-momoGateControl',
    servers.controlBase,
    // Read by `RCTBundleURLProvider`, so this launch loads OUR Metro's bundle
    // even when the machine has another checkout's server on 8081.
    '-RCT_jsLocation',
    `127.0.0.1:${metroPort}`,
  ]);
  child.stdout.on('data', chunk => console_.push(chunk.toString()));
  child.stderr.on('data', chunk => console_.push(chunk.toString()));

  const started = Date.now();
  try {
    const report = await servers.waitForReport(spec.step, STEP_TIMEOUT_MS);
    return {report, seconds: (Date.now() - started) / 1000, log: console_.join('')};
  } catch (error) {
    return {
      report: {
        step: spec.step,
        ok: false,
        checks: [{name: 'launch', ok: false, severity: 'fail', detail: error.message}],
      },
      seconds: (Date.now() - started) / 1000,
      log: console_.join(''),
    };
  } finally {
    child.kill('SIGTERM');
  }
}

// ---- main -------------------------------------------------------------------

async function main() {
  const wall = Date.now();
  let metro = null;
  let servers = null;
  let failed = false;

  try {
    if (!noBuild) {
      const buildStart = Date.now();
      console.log('==> building the simulator app');
      // Redirected to a FILE rather than captured in memory: a clean xcodebuild
      // log is tens of megabytes and `execFileSync`'s default 1MB buffer turns
      // that into a killed child reported as a build failure — which is exactly
      // what happened while writing this, and it cost a wrong diagnosis.
      // Inheriting instead would bury the five lines this gate exists to print.
      mkdirSync(dirname(BUILD_LOG), {recursive: true});
      try {
        execFileSync('bash', ['-c', `bash scripts/build-sim.sh >"${BUILD_LOG}" 2>&1`], {
          cwd: APP_ROOT,
        });
      } catch {
        const log = readFileSync(BUILD_LOG, 'utf8').split('\n');
        const interesting = log.filter(line => /error:|BUILD FAILED/.test(line)).slice(-10);
        console.log((interesting.length > 0 ? interesting : log.slice(-20)).join('\n'));
        throw new Error(`scripts/build-sim.sh failed — full log: ${BUILD_LOG}`);
      }
      console.log(`    built in ${since(buildStart)}`);
    }
    if (!existsSync(APP_PATH)) {
      throw new Error(`${APP_PATH} is missing. Run without --no-build.`);
    }

    // The gate is only meaningful against a build that CAN reach the keychain,
    // and `--no-build` can hand it one that cannot. Say so up front rather than
    // letting it arrive as "the session did not survive".
    // `codesign -dv` reports on stderr, so it is merged rather than dropped.
    const signature = sh('sh', ['-c', `codesign -dv '${APP_PATH}' 2>&1`]);
    if (signature.includes('linker-signed')) {
      console.log(
        '!!  this app is only linker-signed (no codesign pass). Every keychain\n' +
          '!!  call in it fails with -34018 — expect step 1 to fail.',
      );
    }

    const device = pickDevice(deviceName);
    console.log(`==> simulator: ${device.name} (${device.udid})`);
    bootDevice(device);
    sh('xcrun', ['simctl', 'install', device.udid, APP_PATH]);

    const metroServer = await ensureMetro();
    metro = metroServer.child;
    console.log(
      `==> metro :${metroServer.port} (${metroServer.reused ? 'reused' : 'started for this run'})`,
    );

    servers = await startGateServers();
    console.log(`==> api ${servers.apiBase} · control ${servers.controlBase}`);

    const results = [];
    for (const spec of STEPS) {
      const outcome = await runStep(servers, device, spec, metroServer.port);
      results.push({spec, ...outcome});
      const verdict = outcome.report.ok ? 'PASS' : 'FAIL';
      console.log(`\n--- ${spec.step} (${outcome.seconds.toFixed(1)}s) ${verdict}`);
      for (const check of outcome.report.checks ?? []) {
        const mark = check.severity === 'note' ? 'note' : check.ok ? '  ok' : 'FAIL';
        console.log(`    ${mark}  ${check.name}: ${check.detail}`);
      }
      if (!outcome.report.ok) {
        failed = true;
        const tail = outcome.log.trim().split('\n').slice(-25).join('\n');
        if (tail) {
          console.log('    ---- app console ----');
          console.log(
            tail
              .split('\n')
              .map(line => `    ${line}`)
              .join('\n'),
          );
        }
        break;
      }
    }

    if (!failed) {
      // Two-sided: the device said the right things happened, and the server
      // says the right requests arrived. A client that never spoke to the
      // server could otherwise satisfy every device-side assertion above.
      const refreshes = servers.state.requests.filter(r => r.url === '/v1/auth/refresh');
      const offline = servers.state.requests.filter(r => r.step === 'restore-offline');
      const problems = [];
      if (refreshes.length !== 2) {
        problems.push(`expected 2 refresh requests (rotate + reject), saw ${refreshes.length}`);
      }
      if (offline.length !== 0) {
        problems.push(`the unreachable step still reached the server ${offline.length} times`);
      }
      if (problems.length > 0) {
        failed = true;
        console.log('\n--- server-side FAIL');
        for (const problem of problems) {
          console.log(`    FAIL  ${problem}`);
        }
      } else {
        console.log('\n--- server-side   ok  2 refresh requests, 0 during the unreachable step');
      }
    }

    console.log(`\n==> ${failed ? 'FAIL' : 'PASS'} in ${since(wall)}`);
    for (const result of results) {
      console.log(`    ${result.spec.step.padEnd(20)} ${result.seconds.toFixed(1)}s`);
    }
  } finally {
    servers?.close();
    if (metro) {
      try {
        process.kill(-metro.pid, 'SIGTERM');
      } catch {
        metro.kill('SIGTERM');
      }
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch(error => {
  console.error(`\n==> FAIL ${error.message}`);
  process.exit(1);
});
