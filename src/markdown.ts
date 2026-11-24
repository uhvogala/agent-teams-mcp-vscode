import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: false, breaks: true });

markdown.validateLink = href => {
  if (!/^https?:\/\//i.test(href)) return false;
  const url = URL.parse(href);
  return Boolean(url?.hostname && !url.username && !url.password);
};

markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  const alt = renderer.renderInlineAsText(tokens[index].children ?? [], options, env);
  return markdown.utils.escapeHtml(alt);
};

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

export function renderMessageMarkdown(source: string) {
  return markdown.render(source);
}
