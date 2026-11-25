export const roleMentionPattern = /(?<![^\s([{])@([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?![\w@/-]|\.[\w])/gi;
export const isExcludedMentionLine = (line: string) => /^(?: {4}|\t|\s*>)/.test(line);

export function mentionedRoles(body: string, members: readonly string[]) {
  const targets = new Set<string>();
  let fence: string | undefined;
  for (const line of body.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`{3,}|~{3,})\s*$/.test(line)) fence = undefined;
      continue;
    }
    if (marker) { fence = marker; continue; }
    if (isExcludedMentionLine(line)) continue;
    const prose = line.replace(/(`+).*?\1/g, '');
    for (const [, mention] of prose.matchAll(roleMentionPattern)) {
      const id = mention.toLowerCase();
      if (id === 'all') return [...members];
      if (members.includes(id)) targets.add(id);
    }
  }
  return [...targets];
}
