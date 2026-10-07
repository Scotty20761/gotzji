import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { startGotzjiOwnedBrowser } from './gotzji-browser-provider-session.js';

const fixtureRoot = path.parse(process.cwd()).root;
const fixtureProfileParent = path.join(fixtureRoot, 'isolated', 'gotzji', 'fixture');
const fixtureChromeExecutable = path.join(fixtureRoot, 'fixtures', 'chrome.exe');
const fixtureOptions = { profileParent: fixtureProfileParent, chromeExecutable: fixtureChromeExecutable };

describe('gotzji blank-profile browser driver admission', () => {
  it('admits about:blank default without granting access to any web origin, then respects pre-cancellation', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(startGotzjiOwnedBrowser(fixtureOptions, controller.signal)).rejects.toMatchObject({ code: 'BROWSER_CANCELLED' });
  });
  it('admits only explicitly owner-approved HTTPS start origins', async () => {
    const controller = new AbortController(); controller.abort(); const base = { ...fixtureOptions, allowedOrigins: ['https://nodejs.org'] };
    await expect(startGotzjiOwnedBrowser({ ...base, startUrl: 'https://nodejs.org/api/url.html' }, controller.signal)).rejects.toMatchObject({ code: 'BROWSER_CANCELLED' });
    await expect(startGotzjiOwnedBrowser({ ...base, startUrl: 'https://site.invalid/' }, controller.signal)).rejects.toMatchObject({ code: 'BROWSER_ORIGIN_SCOPE_DENIED' });
  });
  it('rejects caller debugger endpoints and browser profile overrides', async () => {
    for (const key of ['debugEndpoint', 'profileDir', 'port']) await expect(startGotzjiOwnedBrowser({ ...fixtureOptions, [key]: 'untrusted' } as never)).rejects.toMatchObject({ code: 'BROWSER_INPUT_INVALID' });
  });
  it('does not mix fixture compatibility with broadened origin approval', async () => {
    await expect(startGotzjiOwnedBrowser({ ...fixtureOptions, fixtureUrl: 'http://127.0.0.1:12345/fixture', allowedOrigins: ['https://site.invalid'] })).rejects.toMatchObject({ code: 'BROWSER_FIXTURE_SCOPE_DENIED' });
  });
  it.each(['C:/Users/example/AppData/Local/Google/Chrome/User Data', 'C:/Users/example/Desktop/browser'])('does not adopt profile %s', async (profileParent) => {
    await expect(startGotzjiOwnedBrowser({ profileParent, chromeExecutable: 'C:/Program Files/Google/Chrome/Application/chrome.exe', fixtureUrl: 'http://127.0.0.1:12345/qualification.html' })).rejects.toMatchObject({ code: 'BROWSER_PROFILE_SCOPE_DENIED' });
  });
  it('does not transmit qualification content to an external destination', async () => {
    await expect(startGotzjiOwnedBrowser({ ...fixtureOptions, fixtureUrl: 'https://site.invalid/collect' })).rejects.toMatchObject({ code: 'BROWSER_FIXTURE_SCOPE_DENIED' });
  });
  it('stops an already-cancelled launch before creating a profile or process', async () => {
    const signal = new AbortController(); signal.abort();
    await expect(startGotzjiOwnedBrowser({ ...fixtureOptions, fixtureUrl: 'http://127.0.0.1:12345/qualification.html' }, signal.signal)).rejects.toMatchObject({ code: 'BROWSER_CANCELLED' });
  });
});
