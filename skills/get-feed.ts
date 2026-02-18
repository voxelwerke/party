type Status = {
  id: string;
  created_at: string;
  content: string;
  reblogs_count: number;
  favourites_count: number;
  replies_count: number;
  reblog?: { content: string; account: { display_name: string; acct: string } };
};

type Account = {
  id: string;
  display_name: string;
  acct: string;
  note: string;
  followers_count: number;
  following_count: number;
  statuses_count: number;
};

const stripHtml = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

function parseHandle(raw: string): { user: string; domain: string } {
  const handle = raw.replace(/^@/, "");
  const at = handle.indexOf("@");
  if (at === -1) throw new Error(`invalid handle "${raw}" — need user@instance`);
  return { user: handle.slice(0, at), domain: handle.slice(at + 1) };
}

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function formatPost(s: Status): string {
  const boost = s.reblog;
  const body = stripHtml(boost ? boost.content : s.content).trim();
  const prefix = boost ? `[boosted @${boost.account.acct}] ` : "";
  const stats = [
    s.reblogs_count && `${s.reblogs_count} boosts`,
    s.favourites_count && `${s.favourites_count} favs`,
    s.replies_count && `${s.replies_count} replies`,
  ]
    .filter(Boolean)
    .join(", ");
  return `${prefix}${body}${stats ? `  (${stats})` : ""}  — ${relTime(s.created_at)}`;
}

export async function getMastodonFeed(
  handle: string,
  limit = 10
): Promise<string> {
  const { user, domain } = parseHandle(handle);
  const base = `https://${domain}`;

  const lookupRes = await fetch(
    `${base}/api/v1/accounts/lookup?acct=${encodeURIComponent(user)}`
  );
  if (!lookupRes.ok) {
    throw new Error(`couldn't find @${user} on ${domain} (${lookupRes.status})`);
  }
  const account = (await lookupRes.json()) as Account;

  const statusRes = await fetch(
    `${base}/api/v1/accounts/${account.id}/statuses?limit=${limit}&exclude_replies=true`
  );
  if (!statusRes.ok) {
    throw new Error(`failed to fetch statuses (${statusRes.status})`);
  }
  const statuses = (await statusRes.json()) as Status[];

  if (!statuses.length) return `@${user}@${domain} has no recent posts.`;

  const bio = stripHtml(account.note).trim();
  const header = [
    `@${user}@${domain}`,
    account.display_name ? `(${account.display_name})` : "",
    bio ? `— ${bio}` : "",
    `${account.followers_count} followers · ${account.statuses_count} posts`,
  ]
    .filter(Boolean)
    .join(" ");

  const posts = statuses.map((s, i) => `${i + 1}. ${formatPost(s)}`).join("\n");
  return `${header}\n\n${posts}`;
}
