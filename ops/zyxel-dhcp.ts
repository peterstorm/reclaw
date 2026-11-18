// One-off ops script for the Zyxel EX3600-T0 via its encrypted OPAL DAL web
// API over HTTPS. Default mode is a read-only inventory (login + DAL GETs);
// the optional `dhcp` argument writes static DHCP reservations (the session
// key rotates on every write and the rotated key is consumed). Password from
// ZYXEL_PASS env (never logged). Imperative shell.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
import {
  constants,
  type KeyObject,
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from 'node:crypto';
import { z } from 'zod';

const HOST = process.env.ZYXEL_HOST ?? 'https://192.168.1.1';
const USER = process.env.ZYXEL_USER ?? 'admin';
const PASS = process.env.ZYXEL_PASS ?? '';
const OIDS = [
  'status',
  'wan',
  'lan',
  'static_dhcp',
  'lanhosts',
  'wlan',
  'nat',
  'dns',
  'firewall_acl',
  'user_account',
  'login_privilege',
  'MultiWan',
  'policy_route',
];

const REDACT = /pass(word)?|hash|secret|slid/i;

let cookie = '';
let aesKey: Buffer = randomBytes(0);

const jsonObject = z.record(z.unknown());

/** Every DAL document is a JSON object; anything else is reported, never read as one. */
function parseJsonRecord(text: string): Record<string, unknown> {
  const parsed = jsonObject.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`expected a JSON object, got: ${text.slice(0, 120)}`);
  return parsed.data;
}

function aesEncrypt(plain: string, key: Buffer, iv32: Buffer): string {
  const cipher = createCipheriv('aes-256-cbc', key, iv32.subarray(0, 16));
  return Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}

function decryptBody(contentB64: string, ivB64: string, key: Buffer): Record<string, unknown> {
  const decipher = createDecipheriv(
    'aes-256-cbc',
    key,
    Buffer.from(ivB64, 'base64').subarray(0, 16),
  );
  const raw = Buffer.concat([decipher.update(Buffer.from(contentB64, 'base64')), decipher.final()]);
  return parseJsonRecord(stripPkcs7(raw).toString('utf8'));
}

function decryptResponse(text: string, key: Buffer): Record<string, unknown> {
  const obj = parseJsonRecord(text);
  if (typeof obj.content === 'string' && typeof obj.iv === 'string') {
    return decryptBody(obj.content, obj.iv, key);
  }
  return obj;
}

function stripPkcs7(raw: Buffer): Buffer {
  const padLen = raw[raw.length - 1] ?? 0;
  if (padLen >= 1 && padLen <= 16) {
    const tail = raw.subarray(raw.length - padLen);
    let allPad = true;
    for (const b of tail) if (b !== padLen) allPad = false;
    if (allPad) return raw.subarray(0, raw.length - padLen);
  }
  return raw;
}

async function req(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<string> {
  const headers: Record<string, string> = {
    'If-Modified-Since': 'Thu, 01 Jun 1970 00:00:00 GMT',
    ...extraHeaders,
  };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${HOST}${url}`, { method, headers, body });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0] ?? cookie;
  return await res.text();
}

/**
 * The credentials AES-encrypted under `key`; the key itself travels RSA-encrypted to the router.
 * The password goes base64-encoded, so the body declares `SHA512_password: false`.
 */
function loginBody(pub: KeyObject, key: Buffer): string {
  const iv32 = randomBytes(32);
  const loginObj = {
    Input_Account: USER,
    Input_Passwd: Buffer.from(PASS, 'utf8').toString('base64'),
    currLang: 'en',
    RememberPassword: '',
    SHA512_password: false,
  };
  return JSON.stringify({
    content: aesEncrypt(JSON.stringify(loginObj), key, iv32),
    key: publicEncrypt(
      { key: pub, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(key.toString('base64'), 'utf8'),
    ).toString('base64'),
    iv: iv32.toString('base64'),
  });
}

async function login(): Promise<{ aesKey: Buffer; sessionKey: string }> {
  await req('GET', '/GetInfoNoLogin');
  const pem = parseJsonRecord(await req('GET', '/getRSAPublickKey')).RSAPublicKey;
  if (typeof pem !== 'string' || !pem) throw new Error('no RSAPublicKey');
  const pub = createPublicKey(pem);

  aesKey = randomBytes(32);
  const resp = await req('POST', '/UserLogin', loginBody(pub, aesKey), {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    Origin: HOST,
    Referer: `${HOST}/`,
    'X-Requested-With': 'XMLHttpRequest',
  });
  process.stdout.write(`# raw login response (sha512=false): ${resp.slice(0, 300)}\n`);
  let data: Record<string, unknown>;
  try {
    data = decryptResponse(resp, aesKey);
  } catch {
    data = parseJsonRecord(resp);
  }
  if (typeof data.sessionkey === 'string' && data.sessionkey !== '') {
    const sessionKey = data.sessionkey;
    process.stdout.write(`# logged in as ${USER} over HTTPS\n`);
    return { aesKey, sessionKey };
  }
  throw new Error(`login failed: ${(data.result as string) ?? JSON.stringify(data).slice(0, 200)}`);
}

/** The session key a write handed back (it rotates on every write), else the current one. */
function rotatedKey(result: Record<string, unknown>, current: string): string {
  return typeof result.sessionkey === 'string' && result.sessionkey !== ''
    ? result.sessionkey
    : current;
}

async function dalWrite(
  oid: string,
  obj: Record<string, unknown>,
  sessionKey: string,
  method: 'POST' | 'PUT' = 'POST',
  extraQuery = '',
): Promise<Record<string, unknown>> {
  const iv32 = randomBytes(32);
  const body = JSON.stringify({
    content: aesEncrypt(JSON.stringify(obj), aesKey, iv32),
    iv: iv32.toString('base64'),
  });
  const r = await req(
    method,
    `/cgi-bin/DAL?oid=${oid}&sessionkey=${sessionKey}${extraQuery}`,
    body,
    {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      CSRFToken: sessionKey,
      Origin: HOST,
      Referer: `${HOST}/`,
    },
  );
  let data: Record<string, unknown>;
  try {
    data = decryptResponse(r, aesKey);
  } catch {
    // Show the full envelope so the write result/rotated sessionkey is visible.
    data = { raw: r.slice(0, 800), status: 'decrypt-failed' };
  }
  // session key rotates on every write; consume the rotated one
  if (typeof data.sessionkey === 'string' && data.sessionkey !== '')
    return { sessionkey: data.sessionkey, ...data };
  return data;
}

async function dalGet(oid: string, sessionKey: string): Promise<Record<string, unknown>> {
  const text = await req('GET', `/cgi-bin/DAL?oid=${oid}&sessionkey=${sessionKey}`);
  return decryptResponse(text, aesKey);
}

async function dalDelete(
  oid: string,
  params: Record<string, string | number>,
  sessionKey: string,
): Promise<Record<string, unknown>> {
  // DAL DELETE carries its key as query params (no encrypted body), per the router's httpReqSendAndRecv.
  const q = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const text = await req(
    'DELETE',
    `/cgi-bin/DAL?oid=${oid}&${q}&sessionkey=${sessionKey}`,
    undefined,
    {
      CSRFToken: sessionKey,
      Origin: HOST,
      Referer: `${HOST}/`,
    },
  );
  try {
    const data = decryptResponse(text, aesKey);
    if (typeof data.sessionkey === 'string' && data.sessionkey !== '')
      return { sessionkey: data.sessionkey, ...data };
    return data;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

/** `dhcp`: inert static reservations — they take effect only at subnet cutover. */
async function addDhcpReservations(initialKey: string): Promise<void> {
  const reservations: Array<Record<string, unknown>> = [
    {
      Enable: true,
      MACAddr: '10:6F:D9:AF:20:73',
      IPAddr: '192.168.0.28',
      BrWan: 'Default',
      Description: 'homelab-wlp3s0',
    },
    {
      Enable: true,
      MACAddr: 'AC:F2:3C:25:E5:9F',
      IPAddr: '192.168.0.80',
      BrWan: 'Default',
      Description: 'desktop-wlp10s0',
    },
  ];
  let sessionKey = initialKey;
  for (const r of reservations) {
    const result = await dalWrite('static_dhcp', r, sessionKey, 'POST');
    sessionKey = rotatedKey(result, sessionKey);
    process.stdout.write(`# add ${r.IPAddr}: ${JSON.stringify(result)}\n`);
  }
  process.stdout.write('=== verify static_dhcp after write ===\n');
  const verify = await dalGet('static_dhcp', sessionKey);
  process.stdout.write(JSON.stringify(verify, null, 1));
}

/**
 * `wired`: move the .28 identity onto the wired NIC (eno1). MAC is the entry key, so DELETE the
 * stale .28->wlp3s0 row and re-add .28->eno1. (.29->wlp3s0 backup was added already.)
 */
async function moveReservationToWired(initialKey: string): Promise<void> {
  let sessionKey = initialKey;
  const cur = await dalGet('static_dhcp', sessionKey);
  const entries = (cur.Object as Array<Record<string, unknown>>) ?? [];
  const stale = entries.find(
    (e) => e.IPAddr === '192.168.0.28' && String(e.MACAddr).toUpperCase() === '10:6F:D9:AF:20:73',
  );
  if (stale) {
    const d = await dalDelete('static_dhcp', { Index: Number(stale.Index) }, sessionKey);
    sessionKey = rotatedKey(d, sessionKey);
    process.stdout.write(
      `# delete stale .28->wlp3s0 (Index ${String(stale.Index)}): ${String(d.result)}\n`,
    );
  } else {
    process.stdout.write('# no stale .28->wlp3s0 entry\n');
  }
  const a = await dalWrite(
    'static_dhcp',
    {
      Enable: true,
      MACAddr: '58:47:CA:70:8E:B1',
      IPAddr: '192.168.0.28',
      BrWan: 'Default',
      Description: 'homelab-eno1-wired',
    },
    sessionKey,
    'POST',
  );
  sessionKey = rotatedKey(a, sessionKey);
  process.stdout.write(`# add .28 -> eno1: ${String(a.result)} ${String(a.ReplyMsg ?? '')}\n`);
  process.stdout.write('=== verify static_dhcp ===\n');
  const verify = await dalGet('static_dhcp', sessionKey);
  for (const r of (verify.Object as Array<Record<string, unknown>>) ?? [])
    process.stdout.write(`  ${String(r.IPAddr)} <- ${String(r.MACAddr)}\n`);
}

/**
 * `lan`: subnet cutover — move LAN to 192.168.0.1, DHCP pool .2-.239 (excludes .240-.250).
 * The router drops the old-IP session on apply, so tolerate a reset/timeout here
 * and verify separately after re-homing eno1 onto the new subnet.
 */
async function cutOverLanSubnet(initialKey: string): Promise<void> {
  const lanObj = {
    EnableDHCP: true,
    Name: 'Default',
    DHCPType: 'DHCPServer',
    DHCP_MinAddress: '192.168.0.2',
    DHCP_MaxAddress: '192.168.0.239',
    IPAddress: '192.168.0.1',
    SubnetMask: '255.255.255.0',
    DHCP_LeaseTime: 86400,
    DNS_Type: 'DNSProxy',
    logout: 0,
  };
  try {
    const result = await dalWrite('lan', lanObj, initialKey, 'PUT', '&timedelay=1');
    process.stdout.write(`# lan write: ${JSON.stringify(result)}\n`);
  } catch (e) {
    process.stdout.write(
      `# lan write connection dropped (expected on IP change): ${String(e).slice(0, 120)}\n`,
    );
  }
}

/**
 * `wlan`: clone the Sagemcom SSIDs onto the Zyxel main radios so devices roam seamlessly.
 * PSK from env, never hardcoded/logged. No device uses the Zyxel Wi-Fi yet, so
 * this is safe to iterate.
 */
async function cloneWlanSsids(initialKey: string): Promise<void> {
  const psk = process.env.ZYXEL_WIFI_PSK ?? '';
  if (!psk) {
    process.stderr.write('ZYXEL_WIFI_PSK is not set\n');
    process.exit(1);
  }
  const base = {
    wlEnable: true,
    wlHide: false,
    securityLevel: 'MoreSecure',
    wpaMode: 'wpa2psk',
    encryp: 'aes',
    AutoGenPSK: false,
    psk_value: psk,
    RekeyingInterval: 3600,
  };
  const clones: Array<Record<string, unknown>> = [
    { Index: 1, SSID: 'FreeBritney', ...base },
    { Index: 5, SSID: 'FreeBritney5GHz', ...base },
  ];
  let sessionKey = initialKey;
  for (const c of clones) {
    const result = await dalWrite('wlan', c, sessionKey, 'PUT');
    sessionKey = rotatedKey(result, sessionKey);
    const { sessionkey: _, ...shown } = result;
    process.stdout.write(
      `# wlan Index ${String(c.Index)} -> ${String(c.SSID)}: ${JSON.stringify(shown)}\n`,
    );
  }
  process.stdout.write('=== verify wlan after write ===\n');
  const verify = await dalGet('wlan', sessionKey);
  const arr = (verify.Object as Array<Record<string, unknown>>) ?? [];
  for (const e of arr)
    if (e.Index === 1 || e.Index === 5)
      process.stdout.write(
        `Index=${String(e.Index)} SSID=${JSON.stringify(e.SSID)} sec=${String(e.SecurityMode)} autopsk=${String(e.AutoGenPSK)}\n`,
      );
}

function redactDeep(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(redactDeep);
  if (o && typeof o === 'object') {
    const r: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      r[k] = REDACT.test(k) ? '[REDACTED]' : redactDeep(v);
    }
    return r;
  }
  return o;
}

/** Default mode: read-only DAL inventory, secrets redacted. */
async function printInventory(): Promise<void> {
  const out: Record<string, unknown> = {};
  for (const oid of OIDS) {
    try {
      const text = await req('GET', `/cgi-bin/DAL?oid=${oid}`);
      out[oid] = decryptResponse(text, aesKey);
    } catch (e) {
      out[oid] = { error: String(e).slice(0, 160) };
    }
  }
  process.stdout.write(JSON.stringify(redactDeep(out), null, 1));
}

const WRITE_MODES: ReadonlyMap<string, (initialKey: string) => Promise<void>> = new Map([
  ['dhcp', addDhcpReservations],
  ['wired', moveReservationToWired],
  ['lan', cutOverLanSubnet],
  ['wlan', cloneWlanSsids],
]);

async function main() {
  if (!PASS) {
    process.stderr.write('ZYXEL_PASS is not set\n');
    process.exit(1);
  }
  const { sessionKey: initialKey } = await login();
  const writeMode = WRITE_MODES.get(process.argv[2] ?? '');
  if (writeMode) await writeMode(initialKey);
  else await printInventory();
  process.exit(0);
}
main().catch((e) => {
  process.stderr.write(`${String(e)}\n`);
  process.exit(1);
});
