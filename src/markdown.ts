import MarkdownIt from 'markdown-it';
import { isExcludedMentionLine, roleMentionPattern } from './mentions';
import { parseWorkspaceReference } from './workspace-reference';

const markdown = new MarkdownIt({ html: false, breaks: true });

const mentionAtCursor = new RegExp(roleMentionPattern.source, 'iy');
markdown.inline.ruler.before('text', 'team_mention', (state, silent) => {
  const members: ReadonlySet<string> | undefined = state.env.mentionMembers;
  if (!members || state.src[state.pos] !== '@') return false;
  mentionAtCursor.lastIndex = state.pos;
  const match = mentionAtCursor.exec(state.src);
  if (!match || mentionAtCursor.lastIndex > state.posMax) return false;
  const id = match[1].toLowerCase();
  if (id !== 'all' && !members.has(id)) return false;
  if (!silent) {
    const token = state.push('team_mention', '', 0);
    token.content = match[0];
    token.meta = state.src.slice(0, state.pos).split('\n').length - 1;
  }
  state.pos = mentionAtCursor.lastIndex;
  return true;
});

markdown.core.ruler.after('inline', 'team_mention_context', state => {
  const lines = state.src.split('\n');
  let quotes = 0;
  let tableRow: number | undefined;
  for (const token of state.tokens) {
    if (token.type === 'blockquote_open') quotes++;
    if (token.type === 'blockquote_close') quotes--;
    if (token.type === 'tr_open') tableRow = token.map?.[0];
    if (token.type === 'tr_close') tableRow = undefined;
    const startLine = token.map?.[0] ?? tableRow;
    let link = false;
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') link = true;
      if (child.type === 'link_close') link = false;
      if (child.type === 'team_mention') {
        // Markdown strips indentation from list continuations before parsing inline text.
        const rawLine = startLine === undefined ? undefined : lines[startLine + child.meta];
        if (quotes || link || rawLine === undefined || isExcludedMentionLine(rawLine)) child.type = 'text';
      }
      if (child.type === 'image') {
        for (const alt of child.children ?? []) {
          if (alt.type === 'team_mention') alt.type = 'text';
        }
      }
    }
  }
});

markdown.renderer.rules.team_mention = (tokens, index) =>
  `<span class="team-mention">${markdown.utils.escapeHtml(tokens[index].content)}</span>`;

markdown.validateLink = href => {
  if (!/^https?:\/\//i.test(href)) return false;
  const url = URL.parse(href);
  return Boolean(url?.hostname && !url.username && !url.password);
};

markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const alt = renderer.renderInlineAsText(tokens[index].children ?? [], options, env);
  return markdown.utils.escapeHtml(alt);
};

const renderInlineCode = markdown.renderer.rules.code_inline!;
markdown.renderer.rules.code_inline = (tokens, index, options, env, renderer) => {
  const html = renderInlineCode(tokens, index, options, env, renderer);
  if (!parseWorkspaceReference(tokens[index].content)) return html;
  for (let prior = index - 1; prior >= 0; prior--) {
    if (tokens[prior].type === 'link_open') return html;
    if (tokens[prior].type === 'link_close') break;
  }
  return `<button type="button" class="workspace-reference" title="Open workspace file">${html}</button>`;
};

markdown.renderer.rules.table_open = () => '<div class="table-scroll" role="region" aria-label="Table" tabindex="0">\n<table>\n';
markdown.renderer.rules.table_close = () => '</table>\n</div>\n';

for (const tag of ['th_open', 'td_open']) {
  markdown.renderer.rules[tag] = (tokens, index, options, _env, renderer) => {
    const token = tokens[index];
    const styleIndex = token.attrIndex('style');
    if (styleIndex !== -1) {
      const style = token.attrGet('style');
      token.attrs?.splice(styleIndex, 1);
      if (style === 'text-align:right') token.attrSet('class', 'align-right');
      if (style === 'text-align:center') token.attrSet('class', 'align-center');
    }
    return renderer.renderToken(tokens, index, options);
  };
}

export function renderMessageMarkdown(source: string, mentionMembers?: ReadonlySet<string>) {
  return markdown.render(source, { mentionMembers });
}
