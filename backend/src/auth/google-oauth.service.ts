import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { PublicUser, UsersService } from '../users/users.service.js';

/** Why a Google sign-in didn't complete: the frontend turns it into a message. */
export type GoogleFailureReason =
  | 'denied'
  | 'state'
  | 'not_registered'
  | 'conflict'
  | 'failed';

export class GoogleAuthError extends Error {
  constructor(readonly reason: GoogleFailureReason) {
    super(`Google sign-in failed: ${reason}`);
    this.name = 'GoogleAuthError';
  }
}

interface GoogleIdentity {
  sub: string;
  email?: string;
  email_verified?: boolean;
}

/** The identity provider services the flow talks to. */
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const STATE_AUDIENCE = 'google-login';

/** One-time codes are redeemed immediately by the app: they only bridge the redirect. */
const CODE_TTL_MS = 60_000;
/** How long a sign-in started on Google stays valid, state included. */
const STATE_TTL = '10m';

@Injectable()
export class GoogleOAuthService {
  /**
   * Codes for the redirect back to the app, so the token never travels in a URL.
   * In memory: the app is a single process, and they live one minute.
   */
  private readonly codes = new Map<
    string,
    { userId: number; expiresAt: number }
  >();

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly users: UsersService,
  ) {}

  /** Without credentials the flow can't start, so the button isn't offered either. */
  isEnabled(): boolean {
    return Boolean(this.clientId() && this.clientSecret());
  }

  /** Where the app lives, to send the browser back after the callback. */
  frontendOrigin(): string {
    return (this.config.get<string>('CORS_ORIGIN') ?? 'http://localhost:5173')
      .split(',')[0]
      .trim()
      .replace(/\/+$/, '');
  }

  /**
   * Must match one of the redirect URIs registered on the Google client.
   * Defaults to the app origin, which the dev server proxies to this backend.
   */
  redirectUri(): string {
    return (
      this.config.get<string>('GOOGLE_REDIRECT_URI') ??
      `${this.frontendOrigin()}/api/auth/google/callback`
    );
  }

  async authorizationUrl(): Promise<string> {
    // A signed, short-lived state is the CSRF defence: the callback must echo it.
    const state = await this.jwt.signAsync(
      { purpose: 'google-login' },
      { expiresIn: STATE_TTL, audience: STATE_AUDIENCE },
    );
    const params = new URLSearchParams({
      client_id: this.clientId(),
      redirect_uri: this.redirectUri(),
      response_type: 'code',
      scope: 'openid email profile',
      state,
      // Always let the person choose, instead of silently reusing the last Google session.
      prompt: 'select_account',
    });
    return `${AUTHORIZE_URL}?${params}`;
  }

  /** Completes the flow and returns the account the Google identity belongs to. */
  async complete(
    code: string,
    state: string | undefined,
  ): Promise<PublicUser> {
    await this.verifyState(state);
    const profile = await this.identityFromCode(code);
    const email = profile.email?.trim().toLowerCase();
    if (!email || profile.email_verified !== true) {
      throw new GoogleAuthError('failed');
    }

    // The link wins over the email: it keeps working after the profile changes it.
    const linked = await this.users.findByGoogleId(profile.sub);
    const user = linked ?? (await this.users.findByEmail(email));
    // Registration stays closed: only an email that already has an account signs in.
    if (!user) throw new GoogleAuthError('not_registered');

    if (user.googleId && user.googleId !== profile.sub) {
      throw new GoogleAuthError('conflict');
    }
    if (!user.googleId) {
      await this.users.linkGoogleId(user.id, profile.sub);
    }

    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    };
  }

  /** The code the app redeems for a token: single use and short-lived. */
  issueCode(userId: number): string {
    this.purgeCodes();
    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, { userId, expiresAt: Date.now() + CODE_TTL_MS });
    return code;
  }

  consumeCode(code: string): number | null {
    this.purgeCodes();
    const entry = this.codes.get(code);
    if (!entry) return null;
    this.codes.delete(code);
    return entry.userId;
  }

  private async verifyState(state: string | undefined): Promise<void> {
    if (!state) throw new GoogleAuthError('state');
    try {
      const payload = await this.jwt.verifyAsync<{ purpose?: string }>(state, {
        audience: STATE_AUDIENCE,
      });
      if (payload.purpose !== 'google-login') throw new Error('wrong purpose');
    } catch {
      throw new GoogleAuthError('state');
    }
  }

  private async identityFromCode(code: string): Promise<GoogleIdentity> {
    // Exchanged server-side with the client secret, so Google's answer is trusted.
    const token = await this.postForm(TOKEN_URL, {
      code,
      client_id: this.clientId(),
      client_secret: this.clientSecret(),
      redirect_uri: this.redirectUri(),
      grant_type: 'authorization_code',
    });
    const accessToken =
      typeof token.access_token === 'string' ? token.access_token : null;
    if (!accessToken) throw new GoogleAuthError('failed');

    // Userinfo also proves the token works, so no need to verify the ID token's signature.
    const res = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) throw new GoogleAuthError('failed');
    const profile = (await res.json().catch(() => null)) as
      | GoogleIdentity
      | null;
    if (!profile?.sub) throw new GoogleAuthError('failed');
    return profile;
  }

  private async postForm(
    url: string,
    body: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res?.ok) throw new GoogleAuthError('failed');
    const data = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!data) throw new GoogleAuthError('failed');
    return data;
  }

  private purgeCodes(): void {
    const now = Date.now();
    for (const [code, entry] of this.codes) {
      if (entry.expiresAt <= now) this.codes.delete(code);
    }
  }

  private clientId(): string {
    return this.config.get<string>('GOOGLE_CLIENT_ID') ?? '';
  }

  private clientSecret(): string {
    return this.config.get<string>('GOOGLE_CLIENT_SECRET') ?? '';
  }
}
