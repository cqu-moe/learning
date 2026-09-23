export const XTX_BASE = 'https://www.xuetangx.com';
export const XTX_WSAPP = 'wss://www.xuetangx.com/wsapp/';

export const XTX_BASE_HEADERS: Record<string, string> = {
  accept: 'application/json, text/plain, */*',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  xtbz: 'xt',
  'app-name': 'xtzx',
  'x-client': 'web',
  'terminal-type': 'web',
  'django-language': 'zh',
};

export const REQUESTLOGIN_FRAME = {
  op: 'requestlogin',
  role: 'web',
  version: '1.4',
  purpose: 'login',
  xtbz: 'xt',
  'x-client': 'web',
} as const;
