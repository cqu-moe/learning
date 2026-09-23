import { CookieJar } from 'tough-cookie';
import type { Json } from '../types/errors.js';

/** Full-fidelity cookie jar: domain/path/hostOnly/secure/expiry via tough-cookie. */
export class SessionCookieJar {
  private jar = new CookieJar();

  async cookiesFor(url: URL): Promise<string> {
    return this.jar.getCookieString(url.toString());
  }

  async cookieValue(url: URL, name: string): Promise<string | null> {
    const cookies = await this.jar.getCookies(url.toString());
    return cookies.find((cookie) => cookie.key === name)?.value ?? null;
  }

  async absorb(url: URL, setCookies: string[]): Promise<void> {
    for (const line of setCookies) {
      await this.jar.setCookie(line, url.toString());
    }
  }

  async serialize(): Promise<Json> {
    return (await this.jar.serialize()) as unknown as Json;
  }

  static async deserialize(data: Json): Promise<SessionCookieJar> {
    const wrapper = new SessionCookieJar();
    const jar = await CookieJar.deserialize(JSON.parse(JSON.stringify(data)) as never);
    wrapper.jar = jar;
    return wrapper;
  }
}
