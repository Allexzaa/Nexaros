import { google } from 'googleapis';
import { env } from '../config/env';

export function getOAuth2Client() {
  return new google.auth.OAuth2(
    env.GOOGLE_OAUTH_CLIENT_ID,
    env.GOOGLE_OAUTH_CLIENT_SECRET,
    env.GOOGLE_OAUTH_REDIRECT_URI,
  );
}

export function getAuthUrl(): string {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: ['openid', 'email', 'profile'],
    prompt: 'select_account',
  });
}

export async function getGoogleProfile(code: string): Promise<{ email: string; sub: string; name: string }> {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: 'v2', auth: client });
  const { data } = await oauth2.userinfo.get();

  if (!data.email || !data.id) throw new Error('Google profile missing required fields');
  return { email: data.email, sub: data.id, name: data.name ?? data.email };
}
